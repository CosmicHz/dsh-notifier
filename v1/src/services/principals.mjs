// Principals service (02-DATA.md; 03-SERVICES-RPC.md principals.*).
// Permission changes advance the owning account's policyRevision in the same
// transaction; disabling or removing a principal revokes its outstanding refs.
import { DomainError, notFound, validationError, conflict } from '../domain/errors.mjs';
import { commit } from '../storage/store.mjs';
import { paginate, filterHash, requireId } from './accounts.mjs';
import { appendActivity } from './activity.mjs';

function nowOf(ctx) {
  return Number.isInteger(ctx?.now) ? ctx.now : Date.now();
}

const PATCHABLE = new Set(['enabled', 'role', 'canConverse', 'sessionIds']);

function bumpAccountPolicy(draft, accountId) {
  const account = draft.accounts[accountId];
  if (account) account.policyRevision += 1;
}

function assertSingleOwner(draft, principal) {
  if (principal.role !== 'owner' || principal.enabled !== true) return;
  const other = Object.values(draft.principals).find(
    (p) => p.id !== principal.id && p.accountId === principal.accountId && p.role === 'owner' && p.enabled === true,
  );
  if (other) throw new DomainError('FORBIDDEN', 'account already has an enabled owner');
}

function revokePrincipalRefs(draft, principalId) {
  for (const replyRef of Object.values(draft.replyRefs)) {
    if (replyRef.principalId === principalId && replyRef.state === 'active') replyRef.state = 'revoked';
  }
  delete draft.bindings[principalId];
}

/** Patch a principal in place; advances the account policy revision. */
export function patchPrincipal(draft, input, ctx = {}) {
  const principal = draft.principals[input?.id];
  if (!principal) throw notFound('principal not found');
  if (input.expectedRevision !== principal.revision) {
    throw conflict('principal revision changed', { currentRevision: principal.revision });
  }
  const patch = input?.patch ?? {};
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw validationError('patch must be an object');
  }
  const errors = [];
  for (const key of Object.keys(patch)) if (!PATCHABLE.has(key)) errors.push(`patch.${key}: field is not writable`);
  if (errors.length) throw validationError('invalid principal patch', errors);

  const next = { ...principal };
  if ('role' in patch) {
    if (patch.role !== 'owner' && patch.role !== 'member') throw validationError('role must be owner|member');
    next.role = patch.role;
  }
  if ('enabled' in patch) {
    if (typeof patch.enabled !== 'boolean') throw validationError('enabled must be a boolean');
    next.enabled = patch.enabled;
  }
  if ('canConverse' in patch) {
    if (typeof patch.canConverse !== 'boolean') throw validationError('canConverse must be a boolean');
    next.canConverse = patch.canConverse;
  }
  if ('sessionIds' in patch) {
    if (!Array.isArray(patch.sessionIds) || !patch.sessionIds.every((id) => requireId(id, 'sessionIds[]') && true)) {
      throw validationError('sessionIds must be an id array');
    }
    next.sessionIds = [...patch.sessionIds];
  }
  assertSingleOwner(draft, next);

  next.revision = principal.revision + 1;
  next.updatedAt = nowOf(ctx);
  draft.principals[principal.id] = next;
  bumpAccountPolicy(draft, next.accountId);
  if (next.enabled === false) revokePrincipalRefs(draft, next.id);
  appendActivity(draft, { kind: 'account', accountId: next.accountId, status: 'principal-updated' }, { now: next.updatedAt });
  return next;
}

/** Remove a principal and its binding/replyRefs/correlations; bumps policy. */
export function deletePrincipal(draft, input, ctx = {}) {
  const principal = draft.principals[input?.id];
  if (!principal) throw notFound('principal not found');
  if (input.expectedRevision !== principal.revision) {
    throw conflict('principal revision changed', { currentRevision: principal.revision });
  }
  for (const [id, replyRef] of Object.entries(draft.replyRefs)) {
    if (replyRef.principalId === principal.id) delete draft.replyRefs[id];
  }
  for (const [id, correlation] of Object.entries(draft.correlations)) {
    if (correlation.principalId === principal.id) delete draft.correlations[id];
  }
  delete draft.bindings[principal.id];
  delete draft.principals[principal.id];
  bumpAccountPolicy(draft, principal.accountId);
  appendActivity(draft, { kind: 'account', accountId: principal.accountId, status: 'principal-removed' }, { now: nowOf(ctx) });
  return { removed: true };
}

export function principalView(principal) {
  return structuredClone(principal);
}

export function listPrincipals(store, { accountId = null, limit = 50, cursor = null } = {}) {
  const draft = store.snapshot();
  if (accountId !== null) requireId(accountId, 'accountId');
  const rows = Object.values(draft.principals)
    .filter((p) => accountId === null || p.accountId === accountId)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  const filter = accountId === null ? {} : { accountId };
  const page = paginate(rows, filterHash(filter), { limit, cursor });
  return { ...page, items: page.items.map(principalView) };
}

export function updatePrincipal(store, input, ctx = {}) {
  return commit(store, ctx.expectedGlobalRevision ?? null, (draft) => {
    const principal = patchPrincipal(draft, input, ctx);
    return principalView(principal);
  });
}

export function removePrincipal(store, input, ctx = {}) {
  return commit(store, ctx.expectedGlobalRevision ?? null, (draft) => deletePrincipal(draft, input, ctx));
}