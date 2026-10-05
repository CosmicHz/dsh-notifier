// Destinations service (02-DATA.md; 03-SERVICES-RPC.md destinations.*).
// A destination belongs to exactly one account and must satisfy the channel's
// declared target fields. Secret target fields live in destination.secrets.
import { DomainError, notFound, validationError, conflict } from '../domain/errors.mjs';
import { LIMITS } from '../domain/limits.mjs';
import { channelById, fieldsFor, targetFieldNames, validateFieldValues } from '../domain/descriptors.mjs';
import { applySecretChanges, secretFieldStatus } from '../security/secrets.mjs';
import { commit } from '../storage/store.mjs';
import { appendActivity } from './activity.mjs';
import { mergeDeep, requireLabel, requireId, paginate, filterHash } from './accounts.mjs';

const KINDS = ['private', 'group', 'local', 'endpoint'];

function nowOf(ctx) {
  return Number.isInteger(ctx?.now) ? ctx.now : Date.now();
}

function newIdOf(ctx) {
  return typeof ctx?.newId === 'function' ? ctx.newId() : globalThis.crypto.randomUUID();
}

function destinationSecretPaths(channelId) {
  const paths = new Set();
  for (const field of fieldsFor(channelId, 'outbound', 'destination')) {
    if (field.exposure === 'secret') paths.add(field.path);
  }
  return paths;
}

/**
 * Split a raw target into public values plus captured secret literals, then
 * validate. Secret-exposure target fields are moved out of `target` so they can
 * only live in destination.secrets.
 */
function normalizeTarget(channelId, target) {
  const values = target ?? {};
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    throw validationError('target must be an object');
  }
  const secretFields = new Set(
    fieldsFor(channelId, 'outbound', 'destination').filter((f) => f.exposure === 'secret').map((f) => f.field),
  );
  const publicTarget = {};
  const captured = {};
  const errors = [];
  for (const [key, value] of Object.entries(values)) {
    if (secretFields.has(key)) {
      if (typeof value !== 'string') errors.push(`target.${key}: expected string secret`);
      else captured[`target.${key}`] = { kind: 'literal', value };
    } else {
      publicTarget[key] = value;
    }
  }
  const allowed = new Set(targetFieldNames(channelId));
  for (const key of Object.keys(publicTarget)) {
    if (!allowed.has(key)) errors.push(`target.${key}: not a declared target field for ${channelId}`);
  }
  for (const problem of validateFieldValues(channelId, 'outbound', 'destination', publicTarget)) {
    errors.push(`target.${problem}`);
  }
  if (errors.length) throw validationError('invalid destination target', errors);
  return { target: publicTarget, captured };
}

function validateDestinationSecretChanges(channelId, changes) {
  const allowed = destinationSecretPaths(channelId);
  const errors = [];
  for (const change of changes) {
    if (change && typeof change.path === 'string' && !allowed.has(change.path)) {
      errors.push(`${change.path}: not a destination secret for ${channelId}`);
    }
  }
  if (errors.length) throw validationError('invalid secretChanges', errors);
}

/** Insert a destination for an existing account. Returns the inserted record. */
export function insertDestination(draft, input, ctx = {}) {
  const account = draft.accounts[input?.accountId];
  if (!account) throw notFound('account not found');
  if (Object.keys(draft.destinations).length >= LIMITS.MAX_DESTINATIONS) {
    throw new DomainError('CAPACITY', `destinations limit ${LIMITS.MAX_DESTINATIONS} reached`);
  }
  const channel = channelById(account.channelId);
  const label = requireLabel(input?.label);
  const kind = input?.kind ?? channel.defaultDestinationKind;
  if (!KINDS.includes(kind)) throw validationError(`kind must be one of ${KINDS.join('|')}`);
  const { target, captured } = normalizeTarget(account.channelId, input?.target);
  const secretChanges = input?.secretChanges ?? [];
  if (!Array.isArray(secretChanges)) throw validationError('secretChanges must be an array');
  validateDestinationSecretChanges(account.channelId, secretChanges);
  const merged = applySecretChanges(captured, secretChanges, { creating: true });
  const enabled = input?.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== 'boolean') throw validationError('enabled must be a boolean');

  const now = nowOf(ctx);
  const destination = {
    id: newIdOf(ctx),
    revision: 0,
    accountId: account.id,
    label,
    kind,
    target,
    secrets: merged,
    enabled,
    createdAt: now,
    updatedAt: now,
  };
  draft.destinations[destination.id] = destination;
  appendActivity(draft, { kind: 'connection', accountId: account.id, status: 'destination-created' }, { now });
  return destination;
}

const PATCHABLE = new Set(['label', 'target', 'enabled']);

/** Patch a destination in place. `target` replaces wholesale when present. */
export function patchDestination(draft, input, ctx = {}) {
  const destination = draft.destinations[input?.id];
  if (!destination) throw notFound('destination not found');
  if (input.expectedRevision !== destination.revision) {
    throw conflict('destination revision changed', { currentRevision: destination.revision });
  }
  const patch = input?.patch ?? {};
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw validationError('patch must be an object');
  }
  const errors = [];
  for (const key of Object.keys(patch)) if (!PATCHABLE.has(key)) errors.push(`patch.${key}: field is not writable`);
  if (errors.length) throw validationError('invalid destination patch', errors);

  const account = draft.accounts[destination.accountId];
  const channelId = account.channelId;
  let target = destination.target;
  let captured = {};
  if ('target' in patch) {
    const normalized = normalizeTarget(channelId, mergeDeep(destination.target, patch.target));
    target = normalized.target;
    captured = normalized.captured;
  }
  const secretChanges = input?.secretChanges ?? [];
  if (!Array.isArray(secretChanges)) throw validationError('secretChanges must be an array');
  validateDestinationSecretChanges(channelId, secretChanges);
  const secrets = applySecretChanges({ ...destination.secrets, ...captured }, secretChanges);

  const next = { ...destination, target, secrets };
  if ('label' in patch) {
    requireLabel(patch.label);
    next.label = patch.label;
  }
  if ('enabled' in patch) {
    if (typeof patch.enabled !== 'boolean') throw validationError('enabled must be a boolean');
    next.enabled = patch.enabled;
  }
  next.revision = destination.revision + 1;
  next.updatedAt = nowOf(ctx);
  draft.destinations[destination.id] = next;
  appendActivity(draft, { kind: 'connection', accountId: account.id, status: 'destination-updated' }, { now: next.updatedAt });
  return next;
}

/** Remove a destination and clear every route/settings reference to it. */
export function deleteDestination(draft, input, ctx = {}) {
  const destination = draft.destinations[input?.id];
  if (!destination) throw notFound('destination not found');
  if (input.expectedRevision !== destination.revision) {
    throw conflict('destination revision changed', { currentRevision: destination.revision });
  }
  for (const route of Object.values(draft.routes)) {
    if (Array.isArray(route.destinationIds)) {
      route.destinationIds = route.destinationIds.filter((id) => id !== destination.id);
    }
  }
  draft.settings.defaultDestinationIds = draft.settings.defaultDestinationIds.filter((id) => id !== destination.id);
  delete draft.destinations[destination.id];
  appendActivity(draft, { kind: 'connection', accountId: destination.accountId, status: 'destination-removed' }, { now: nowOf(ctx) });
  return { removed: true };
}

/** DestinationView: the record without secrets, plus secretFields. */
export function destinationView(destination) {
  const { secrets, ...rest } = destination;
  return { ...structuredClone(rest), secretFields: secretFieldStatus(secrets) };
}

export function listDestinations(store, { accountId = null, limit = 50, cursor = null } = {}) {
  const draft = store.snapshot();
  if (accountId !== null) requireId(accountId, 'accountId');
  const rows = Object.values(draft.destinations)
    .filter((d) => accountId === null || d.accountId === accountId)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  const filter = accountId === null ? {} : { accountId };
  const page = paginate(rows, filterHash(filter), { limit, cursor });
  return { ...page, items: page.items.map(destinationView) };
}

export function getDestination(store, { id }) {
  const draft = store.snapshot();
  requireId(id);
  const destination = draft.destinations[id];
  if (!destination) throw notFound('destination not found');
  return destinationView(destination);
}

export function createDestination(store, input, ctx = {}) {
  return commit(store, ctx.expectedGlobalRevision ?? null, (draft) => {
    const destination = insertDestination(draft, input, ctx);
    return destinationView(destination);
  });
}

export function updateDestination(store, input, ctx = {}) {
  return commit(store, ctx.expectedGlobalRevision ?? null, (draft) => {
    const destination = patchDestination(draft, input, ctx);
    return destinationView(destination);
  });
}

export function removeDestination(store, input, ctx = {}) {
  return commit(store, ctx.expectedGlobalRevision ?? null, (draft) => deleteDestination(draft, input, ctx));
}