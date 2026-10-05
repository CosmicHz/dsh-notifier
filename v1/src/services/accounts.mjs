// Accounts service (02-DATA.md; 03-SERVICES-RPC.md accounts.*).
// Pure draft mutators (used inside one store.transact) plus thin async wrappers.
// Views are built here and never contain secret values.
import { randomUUID, createHash } from 'node:crypto';
import { DomainError, conflict, notFound, validationError, isDomainError } from '../domain/errors.mjs';
import { LIMITS, codepointLength } from '../domain/limits.mjs';
import { channelById, fieldsFor, fieldRequired, validateAccountConfig } from '../domain/descriptors.mjs';
import { applySecretChanges, secretFieldStatus } from '../security/secrets.mjs';
import { commit } from '../storage/store.mjs';
import { appendActivity } from './activity.mjs';

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export function isId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

export function requireId(value, label = 'id') {
  if (!isId(value)) throw validationError(`${label} must be a non-empty opaque id`);
  return value;
}

export function requireLabel(value, label = 'label') {
  if (typeof value !== 'string' || codepointLength(value) < 1 || codepointLength(value) > LIMITS.MAX_NAME_CODEPOINTS) {
    throw validationError(`${label} must be 1..${LIMITS.MAX_NAME_CODEPOINTS} characters`);
  }
  return value;
}

function nowOf(ctx) {
  return Number.isInteger(ctx?.now) ? ctx.now : Date.now();
}

function newIdOf(ctx) {
  return typeof ctx?.newId === 'function' ? ctx.newId() : randomUUID();
}

export function mergeDeep(base, patch) {
  if (patch === null) return null;
  if (Array.isArray(patch)) return structuredClone(patch);
  if (typeof patch !== 'object') return patch;
  const out = base && typeof base === 'object' && !Array.isArray(base) ? structuredClone(base) : {};
  for (const [key, value] of Object.entries(patch)) out[key] = mergeDeep(out[key], value);
  return out;
}

/** Allowed account secret paths for a channel (outbound.* / inbound.*). */
export function accountSecretPaths(channelId, direction = null) {
  const directions = direction ? [direction] : ['outbound', 'inbound'];
  const paths = new Set();
  for (const dir of directions) {
    for (const field of fieldsFor(channelId, dir, 'account')) {
      if (field.exposure === 'secret') paths.add(field.path);
    }
  }
  return paths;
}

function validateSecretPaths(changes, channelId) {
  const allowed = accountSecretPaths(channelId);
  const errors = [];
  for (const change of changes) {
    if (change && typeof change.path === 'string' && !allowed.has(change.path)) {
      errors.push(`${change.path}: not an account secret for ${channelId}`);
    }
  }
  if (errors.length) throw validationError('invalid secretChanges', errors);
}

/** True when every visible required account field for a direction is configured. */
export function directionComplete(channelId, direction, config, secrets) {
  const fields = fieldsFor(channelId, direction, 'account');
  const context = { ...(config ?? {}) };
  for (const field of fields) {
    if (field.exposure === 'secret') context[field.field] = Boolean(secrets?.[field.path]);
  }
  for (const field of fields) {
    if (!fieldRequired(field, context)) continue;
    if (field.exposure === 'secret') {
      if (!secrets?.[field.path]) return false;
    } else {
      const value = config?.[field.field];
      if (value === undefined || value === null) return false;
    }
  }
  return true;
}

export function validateAccountConfigShape(channelId, config) {
  if (config === undefined || config === null) return { outbound: {}, inbound: {} };
  if (typeof config !== 'object' || Array.isArray(config)) throw validationError('config must be an object');
  const errors = [];
  for (const key of Object.keys(config)) {
    if (key !== 'outbound' && key !== 'inbound') errors.push(`config.${key}: unknown section`);
  }
  const out = {};
  for (const direction of ['outbound', 'inbound']) {
    const values = config[direction];
    if (values === undefined) continue;
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      errors.push(`config.${direction}: expected object`);
      continue;
    }
    for (const problem of validateAccountConfig(channelId, direction, values)) {
      errors.push(`config.${direction}.${problem}`);
    }
    out[direction] = values;
  }
  if (errors.length) throw validationError('invalid account config', errors);
  return { outbound: out.outbound ?? {}, inbound: out.inbound ?? {} };
}

function assertDirectionAvailable(channel, direction, enabledFlag) {
  if (!enabledFlag) return;
  if (direction === 'outbound' && channel.outbound !== true) {
    throw validationError(`${channel.id} has no outbound direction`);
  }
  if (direction === 'inbound' && channel.inbound !== true) {
    throw validationError(`${channel.id} has no inbound direction`);
  }
}

/**
 * Insert a new account into a draft. Returns the inserted account.
 * Enforces channel, 02 defaults, public-only config and secret path ownership.
 */
export function insertAccount(draft, input, ctx = {}) {
  const channel = channelById(input?.channelId);
  if (!channel) throw validationError('unknown channelId');
  if (Object.keys(draft.accounts).length >= LIMITS.MAX_ACCOUNTS) {
    throw new DomainError('CAPACITY', `accounts limit ${LIMITS.MAX_ACCOUNTS} reached`);
  }
  const label = requireLabel(input?.label);
  const config = validateAccountConfigShape(channel.id, input?.config);
  const secretChanges = input?.secretChanges ?? [];
  if (!Array.isArray(secretChanges)) throw validationError('secretChanges must be an array');
  validateSecretPaths(secretChanges, channel.id);
  const secrets = applySecretChanges({}, secretChanges, { creating: true });

  const enabled = input?.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== 'boolean') throw validationError('enabled must be a boolean');
  const notificationEnabled = input?.notificationEnabled === true;
  const controlEnabled = input?.controlEnabled === true;
  assertDirectionAvailable(channel, 'outbound', notificationEnabled);
  assertDirectionAvailable(channel, 'inbound', controlEnabled);
  if (notificationEnabled && !directionComplete(channel.id, 'outbound', config.outbound, secrets)) {
    throw validationError('outbound credentials are incomplete');
  }
  if (controlEnabled && !directionComplete(channel.id, 'inbound', config.inbound, secrets)) {
    throw validationError('inbound credentials are incomplete');
  }

  const now = nowOf(ctx);
  const account = {
    id: newIdOf(ctx),
    revision: 0,
    channelId: channel.id,
    label,
    enabled,
    notificationEnabled,
    controlEnabled,
    config,
    secrets,
    policyRevision: 0,
    createdAt: now,
    updatedAt: now,
  };
  draft.accounts[account.id] = account;
  appendActivity(draft, { kind: 'account', accountId: account.id, status: 'created' }, { now });
  return account;
}

const PATCHABLE = new Set(['label', 'enabled', 'notificationEnabled', 'controlEnabled', 'config']);

/**
 * Patch an account in place. Only label/enabled/notificationEnabled/controlEnabled/
 * config are writable; id/revision/policyRevision/timestamps are never accepted.
 * policyRevision advances for permission/flag/credential changes, not label alone.
 */
export function patchAccount(draft, input, ctx = {}) {
  const account = draft.accounts[input?.id];
  if (!account) throw notFound('account not found');
  if (input.expectedRevision !== account.revision) {
    throw conflict('account revision changed', { currentRevision: account.revision });
  }
  const patch = input?.patch ?? {};
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw validationError('patch must be an object');
  }
  const errors = [];
  for (const key of Object.keys(patch)) if (!PATCHABLE.has(key)) errors.push(`patch.${key}: field is not writable`);
  if (errors.length) throw validationError('invalid account patch', errors);

  let config = account.config;
  let policyChanged = false;
  if ('config' in patch) {
    config = validateAccountConfigShape(account.channelId, mergeDeep(account.config, patch.config));
    policyChanged = true;
  }
  const secretChanges = input?.secretChanges ?? [];
  if (!Array.isArray(secretChanges)) throw validationError('secretChanges must be an array');
  validateSecretPaths(secretChanges, account.channelId);
  if (secretChanges.length) policyChanged = true;
  const secrets = applySecretChanges(account.secrets, secretChanges);

  const next = { ...account, config, secrets };
  for (const flag of ['enabled', 'notificationEnabled', 'controlEnabled']) {
    if (flag in patch) {
      if (typeof patch[flag] !== 'boolean') throw validationError(`${flag} must be a boolean`);
      next[flag] = patch[flag];
      policyChanged = true;
    }
  }
  if ('label' in patch) {
    requireLabel(patch.label);
    next.label = patch.label;
  }
  const channel = channelById(account.channelId);
  assertDirectionAvailable(channel, 'outbound', next.notificationEnabled);
  assertDirectionAvailable(channel, 'inbound', next.controlEnabled);
  if (next.notificationEnabled && !directionComplete(account.channelId, 'outbound', next.config.outbound, next.secrets)) {
    throw validationError('outbound credentials are incomplete');
  }
  if (next.controlEnabled && !directionComplete(account.channelId, 'inbound', next.config.inbound, next.secrets)) {
    throw validationError('inbound credentials are incomplete');
  }

  next.revision = account.revision + 1;
  next.policyRevision = account.policyRevision + (policyChanged ? 1 : 0);
  next.updatedAt = nowOf(ctx);
  draft.accounts[account.id] = next;
  appendActivity(draft, { kind: 'account', accountId: account.id, status: 'updated' }, { now: next.updatedAt });
  return next;
}

function cleanRoutesForDestinations(draft, removedDestinations) {
  if (removedDestinations.size === 0) return;
  for (const route of Object.values(draft.routes)) {
    if (Array.isArray(route.destinationIds)) {
      route.destinationIds = route.destinationIds.filter((id) => !removedDestinations.has(id));
    }
  }
  draft.settings.defaultDestinationIds = draft.settings.defaultDestinationIds.filter((id) => !removedDestinations.has(id));
}

/**
 * Remove an account and every strongly-referenced record in the same draft.
 * Historical receipts/activity/effects/imports keep dangling ids by design.
 */
export function deleteAccount(draft, input, ctx = {}) {
  const account = draft.accounts[input?.id];
  if (!account) throw notFound('account not found');
  if (input.expectedRevision !== account.revision) {
    throw conflict('account revision changed', { currentRevision: account.revision });
  }
  const accountId = account.id;
  const removedDestinations = new Set();
  for (const destination of Object.values(draft.destinations)) {
    if (destination.accountId === accountId) removedDestinations.add(destination.id);
  }
  const principalIds = new Set();
  for (const principal of Object.values(draft.principals)) {
    if (principal.accountId === accountId) principalIds.add(principal.id);
  }
  const replyContextIds = new Set();
  for (const context of Object.values(draft.replyContexts)) {
    if (context.accountId === accountId) replyContextIds.add(context.id);
  }

  for (const id of removedDestinations) delete draft.destinations[id];
  for (const id of principalIds) delete draft.principals[id];
  for (const [id, pairing] of Object.entries(draft.pairing)) if (pairing.accountId === accountId) delete draft.pairing[id];
  for (const id of replyContextIds) delete draft.replyContexts[id];
  for (const [id, replyRef] of Object.entries(draft.replyRefs)) if (replyRef.accountId === accountId) delete draft.replyRefs[id];
  for (const [id, correlation] of Object.entries(draft.correlations)) if (correlation.accountId === accountId) delete draft.correlations[id];
  for (const [id, binding] of Object.entries(draft.bindings)) if (principalIds.has(binding.principalId)) delete draft.bindings[id];
  delete draft.cursors[accountId];
  cleanRoutesForDestinations(draft, removedDestinations);

  for (const interaction of Object.values(draft.interactions)) {
    if (interaction.state !== 'pending' && interaction.state !== 'claimed') continue;
    interaction.targets = interaction.targets.filter((target) => target.accountId !== accountId);
  }

  delete draft.accounts[accountId];
  appendActivity(draft, { kind: 'account', accountId, status: 'removed' }, { now: nowOf(ctx) });
  return { removed: true };
}

/** AccountView: the record without secrets, plus secretFields + destinationCount. */
export function accountView(account, draft) {
  const { secrets, ...rest } = account;
  const destinationCount = draft
    ? Object.values(draft.destinations).filter((d) => d.accountId === account.id).length
    : 0;
  return { ...structuredClone(rest), secretFields: secretFieldStatus(secrets), destinationCount };
}

export function findAccount(draft, id) {
  return draft.accounts[id] ?? null;
}

// ---------------------------------------------------------------------------
// pagination (03-SERVICES-RPC.md: {limit,cursor} -> {items,nextCursor,total})
// ---------------------------------------------------------------------------

export function filterHash(filter) {
  return createHash('sha256').update(JSON.stringify(filter ?? {})).digest('hex').slice(0, 16);
}

function encodeCursor(after, hash) {
  return Buffer.from(JSON.stringify({ after, f: hash }), 'utf8').toString('base64url');
}

function decodeCursor(cursor, hash) {
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (parsed.f !== hash || typeof parsed.after !== 'string') throw new Error('mismatch');
    return parsed.after;
  } catch (err) {
    if (isDomainError(err)) throw err;
    throw validationError('invalid cursor');
  }
}

export function paginate(items, hash, { limit = 50, cursor = null } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw validationError('limit must be 1..100');
  let start = 0;
  if (cursor !== null) {
    const after = decodeCursor(cursor, hash);
    const index = items.findIndex((item) => item.id === after);
    if (index !== -1) start = index + 1;
  }
  const slice = items.slice(start, start + limit);
  const nextCursor = start + limit < items.length ? encodeCursor(slice[slice.length - 1].id, hash) : null;
  return { items: slice, nextCursor, total: items.length };
}

export function listAccounts(store, { limit = 50, cursor = null } = {}) {
  const draft = store.snapshot();
  const rows = Object.values(draft.accounts)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  const page = paginate(rows, filterHash({}), { limit, cursor });
  return { ...page, items: page.items.map((account) => accountView(account, draft)) };
}

export function getAccount(store, { id }) {
  const draft = store.snapshot();
  requireId(id);
  const account = draft.accounts[id];
  if (!account) throw notFound('account not found');
  return accountView(account, draft);
}

export function createAccount(store, input, ctx = {}) {
  return commit(store, ctx.expectedGlobalRevision ?? null, (draft) => {
    const account = insertAccount(draft, input, ctx);
    return accountView(account, draft);
  });
}

export function updateAccount(store, input, ctx = {}) {
  return commit(store, ctx.expectedGlobalRevision ?? null, (draft) => {
    const account = patchAccount(draft, input, ctx);
    return accountView(account, draft);
  });
}

export function removeAccount(store, input, ctx = {}) {
  return commit(store, ctx.expectedGlobalRevision ?? null, (draft) => deleteAccount(draft, input, ctx));
}