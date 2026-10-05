// Pairing service (02-DATA.md; T06 acceptance P01-P04).
// A pairing code is a one-time, 5-minute secret: only its SHA256 hash is stored.
// Redemption, lockout accounting and principal creation share one transaction, so
// a write failure can never leave an authorization behind.
import { createHash, randomUUID } from 'node:crypto';
import { DomainError, notFound, validationError } from '../domain/errors.mjs';
import { LIMITS } from '../domain/limits.mjs';
import { compoundKey } from '../domain/schema.mjs';
import { commit } from '../storage/store.mjs';
import { appendActivity } from './activity.mjs';
import { requireId, filterHash, paginate } from './accounts.mjs';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1
const CODE_LENGTH = 8;

function nowOf(ctx) {
  return Number.isInteger(ctx?.now) ? ctx.now : Date.now();
}

function newIdOf(ctx) {
  return typeof ctx?.newId === 'function' ? ctx.newId() : randomUUID();
}

function randomCode(random = Math.random) {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return out;
}

export function hashCode(accountId, code) {
  return createHash('sha256').update(JSON.stringify([accountId, code])).digest('hex');
}

function requireUserId(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > LIMITS.MAX_ID_LENGTH) {
    throw validationError('userId must be a non-empty string');
  }
  return value;
}

function hasEnabledOwner(draft, accountId) {
  return Object.values(draft.principals).some((p) => p.accountId === accountId && p.role === 'owner' && p.enabled === true);
}

function hasActiveOwnerPairing(draft, accountId) {
  return Object.values(draft.pairing).some((p) => p.accountId === accountId && p.role === 'owner' && p.state === 'active');
}

export function issuePairing(store, input, ctx = {}) {
  return commit(store, ctx.expectedGlobalRevision ?? null, (draft) => {
    const account = draft.accounts[input?.accountId];
    if (!account) throw notFound('account not found');
    const role = input?.role ?? (hasEnabledOwner(draft, account.id) || hasActiveOwnerPairing(draft, account.id) ? 'member' : 'owner');
    if (role !== 'owner' && role !== 'member') throw validationError('role must be owner|member');
    if (role === 'owner' && (hasEnabledOwner(draft, account.id) || hasActiveOwnerPairing(draft, account.id))) {
      throw new DomainError('FORBIDDEN', 'account already has an owner');
    }
    const canConverse = input?.canConverse === true;
    const code = input?.code ?? randomCode(ctx?.random);
    const now = nowOf(ctx);
    const pairing = {
      id: newIdOf(ctx),
      accountId: account.id,
      codeHash: hashCode(account.id, code),
      role,
      canConverse,
      expiresAt: now + LIMITS.PAIRING_TTL_MS,
      state: 'active',
      createdAt: now,
    };
    draft.pairing[pairing.id] = pairing;
    appendActivity(draft, { kind: 'account', accountId: account.id, status: 'pairing-issued' }, { now });
    return { id: pairing.id, code, expiresAt: pairing.expiresAt };
  });
}

export function revokePairing(store, input, ctx = {}) {
  return commit(store, ctx.expectedGlobalRevision ?? null, (draft) => {
    const pairing = draft.pairing[input?.id];
    if (!pairing) throw notFound('pairing not found');
    if (pairing.state !== 'active') throw new DomainError('ALREADY_HANDLED', 'pairing is not active');
    pairing.state = 'revoked';
    appendActivity(draft, { kind: 'account', accountId: pairing.accountId, status: 'pairing-revoked' }, { now: nowOf(ctx) });
    return { revoked: true };
  });
}

function registerFailure(draft, accountId, userId, now) {
  const key = compoundKey([accountId, userId]);
  const current = draft.lockouts[key] ?? { failures: 0, lockedUntil: 0, lastAttemptAt: 0 };
  const failures = current.failures + 1;
  draft.lockouts[key] = {
    failures,
    lockedUntil: failures >= LIMITS.PAIRING_FAILURE_LIMIT ? now + LIMITS.PAIRING_LOCKOUT_MS : 0,
    lastAttemptAt: now,
  };
}

/**
 * Redeem a pairing code. Returns the created Principal. Rejected on unknown code,
 * cross-account use, expiry or lockout. Only one concurrent redemption succeeds
 * because the whole check/create runs inside a single serialized transaction.
 *
 * Failure outcomes are RETURNED (not thrown) from the mutator so that lockout
 * accounting commits; the typed error is raised after the commit. Authorization
 * and the pairing state transition together remain one atomic write.
 */
export function redeemPairing(store, input, ctx = {}) {
  const accountId = requireId(input?.accountId, 'accountId');
  const userId = requireUserId(input?.userId);
  const code = input?.code;
  if (typeof code !== 'string' || code.length === 0) throw validationError('code is required');

  return commit(store, ctx.expectedGlobalRevision ?? null, (draft) => {
    const account = draft.accounts[accountId];
    if (!account) throw notFound('account not found');
    const now = nowOf(ctx);
    const lockKey = compoundKey([accountId, userId]);
    const lockout = draft.lockouts[lockKey];
    if (lockout && lockout.lockedUntil > now) {
      return { ok: false, code: 'FORBIDDEN', message: 'too many failed pairing attempts; try later' };
    }

    const wanted = hashCode(accountId, code);
    let match = null;
    for (const pairing of Object.values(draft.pairing)) {
      if (pairing.accountId === accountId && pairing.codeHash === wanted) {
        match = pairing;
        break;
      }
    }
    if (!match) {
      registerFailure(draft, accountId, userId, now);
      return { ok: false, code: 'FORBIDDEN', message: 'invalid pairing code' };
    }
    if (match.state !== 'active') {
      return { ok: false, code: 'ALREADY_HANDLED', message: 'pairing code already used' };
    }
    if (match.expiresAt <= now) {
      match.state = 'revoked';
      return { ok: false, code: 'EXPIRED', message: 'pairing code expired' };
    }

    const replyContextId = input?.replyContextId;
    if (!replyContextId || !draft.replyContexts[replyContextId]) {
      throw validationError('a valid replyContextId is required');
    }

    const principal = {
      id: newIdOf(ctx),
      revision: 0,
      accountId,
      userId,
      role: match.role,
      canConverse: match.canConverse === true,
      sessionIds: [],
      enabled: true,
      replyContextId,
      createdAt: now,
      updatedAt: now,
    };
    draft.principals[principal.id] = principal;
    match.state = 'redeemed';
    delete draft.lockouts[lockKey];
    appendActivity(draft, { kind: 'account', accountId, status: 'pairing-redeemed' }, { now });
    return { ok: true, principal: structuredClone(principal) };
  }).then((outcome) => {
    if (!outcome.ok) throw new DomainError(outcome.code, outcome.message);
    return outcome.principal;
  });
}

export function listPairings(store, { accountId = null, limit = 50, cursor = null } = {}) {
  const draft = store.snapshot();
  const rows = Object.values(draft.pairing)
    .filter((p) => accountId === null || p.accountId === accountId)
    .map((p) => ({ ...p, revision: 0 }))
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  const filter = accountId === null ? {} : { accountId };
  const page = paginate(rows, filterHash(filter), { limit, cursor });
  return { ...page, items: page.items.map((p) => { const { codeHash, ...rest } = p; return rest; }) };
}