// Conversation correlations (02-DATA.md Correlation, W02, 18-WIRING.md 链4).
//
// Before any Host submit the caller's return path is persisted as a correlation:
// [accountId, principalId, replyContextId, sessionId] for one request. A turn
// start binds the reserved correlation to the real hostRef/turnId. The reply is
// routed only to the original principal, and only while that principal is still
// authorized — a revoked principal's correlation is cancelled, never retargeted.
import { randomUUID } from 'node:crypto';
import { conflict, notFound, validationError } from '../domain/errors.mjs';
import { LIMITS } from '../domain/limits.mjs';
import { compoundKey } from '../domain/schema.mjs';

export const CORRELATION_STATES = Object.freeze([
  'reserved', 'active', 'completed', 'cancelled', 'uncertain',
]);

const TERMINAL = new Set(['completed', 'cancelled', 'uncertain']);

export function correlationKeyOf(accountId, principalId, sessionId, requestId) {
  for (const [label, value] of [['accountId', accountId], ['principalId', principalId], ['sessionId', sessionId], ['requestId', requestId]]) {
    if (typeof value !== 'string' || value === '') throw validationError(`${label} is required`);
  }
  const key = compoundKey([accountId, principalId, sessionId, requestId]);
  if (key.length > 512) throw validationError('correlation key is too long');
  return key;
}

/** Live (reserved/active) correlations for a session, oldest first. */
export function liveCorrelationsForSession(draft, sessionId) {
  return Object.values(draft.correlations)
    .filter((c) => c.sessionId === sessionId && !TERMINAL.has(c.state))
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/**
 * Reserve the return path for one conversation turn. Fails closed when another
 * principal already holds this session: two people must not share one session's
 * replies (18: 不同主体抢同会话 CONFLICT), but the same principal may queue.
 */
export function reserveCorrelation(draft, input, ctx = {}) {
  const account = draft.accounts[input?.accountId];
  if (!account) throw notFound('account not found');
  const principal = draft.principals[input?.principalId];
  if (!principal) throw notFound('principal not found');
  if (principal.accountId !== account.id) throw validationError('principal belongs to another account');
  const context = draft.replyContexts[input?.replyContextId];
  if (!context) throw notFound('reply context not found');
  if (context.accountId !== account.id) throw validationError('reply context belongs to another account');
  if (principal.replyContextId !== context.id) throw validationError('reply context is not this principal\'s current context');
  if (typeof input?.sessionId !== 'string' || input.sessionId === '') throw validationError('sessionId is required');
  const now = nowOf(ctx);
  const requestKey = input?.requestKey ?? correlationKeyOf(account.id, principal.id, input.sessionId, input.requestId ?? randomUUID());

  const existing = Object.values(draft.correlations).find((c) => c.requestKey === requestKey);
  if (existing) return { correlation: existing, replayed: true };

  for (const live of liveCorrelationsForSession(draft, input.sessionId)) {
    if (live.principalId !== principal.id) {
      throw conflict('another principal already owns this session', { correlationId: live.id });
    }
  }

  if (Object.keys(draft.correlations).length >= LIMITS.MAX_CORRELATIONS) pruneCorrelations(draft, { now });
  const correlation = {
    id: input?.id ?? (ctx.newId ? ctx.newId() : randomUUID()),
    requestKey,
    accountId: account.id,
    principalId: principal.id,
    replyContextId: context.id,
    sessionId: input.sessionId,
    hostRef: null,
    turnId: null,
    state: 'reserved',
    createdAt: now,
    updatedAt: now,
  };
  draft.correlations[correlation.id] = correlation;
  return { correlation, replayed: false };
}

export function getCorrelation(draft, id) {
  const correlation = draft.correlations[id];
  if (!correlation) throw notFound('correlation not found');
  return correlation;
}

/** Bind the reserved correlation to the Host turn that actually started. */
export function bindCorrelationTurn(draft, id, { hostRef, turnId = null, now = Date.now() } = {}) {
  const correlation = getCorrelation(draft, id);
  if (correlation.state === 'cancelled' || correlation.state === 'completed') {
    throw conflict('correlation is already finished');
  }
  if (typeof hostRef !== 'string' || hostRef === '') throw validationError('hostRef is required');
  if (turnId !== null && (typeof turnId !== 'string' || turnId === '')) throw validationError('turnId must be string|null');
  // A different turn must not overwrite a live binding; the first turn wins.
  if (correlation.hostRef !== null && correlation.hostRef !== hostRef) {
    throw conflict('correlation is already bound to another turn');
  }
  correlation.hostRef = hostRef;
  if (turnId !== null) correlation.turnId = turnId;
  correlation.state = 'active';
  correlation.updatedAt = now;
  return correlation;
}

/** The live correlation bound to a specific turn (busy inject/steer must match it). */
export function correlationForTurn(draft, { sessionId, turnId }) {
  if (typeof turnId !== 'string' || turnId === '') return null;
  return Object.values(draft.correlations).find(
    (c) => c.sessionId === sessionId && c.turnId === turnId && !TERMINAL.has(c.state),
  ) ?? null;
}

/** The single live correlation for a session, or null (used to resolve a busy turn). */
export function soleLiveCorrelationForSession(draft, sessionId) {
  const live = liveCorrelationsForSession(draft, sessionId);
  return live.length === 1 ? live[0] : null;
}

export function completeCorrelation(draft, id, { now = Date.now() } = {}) {
  return setState(draft, id, 'completed', now);
}

export function cancelCorrelation(draft, id, { now = Date.now() } = {}) {
  return setState(draft, id, 'cancelled', now);
}

export function markCorrelationUncertain(draft, id, { now = Date.now() } = {}) {
  return setState(draft, id, 'uncertain', now);
}

function setState(draft, id, state, now) {
  const correlation = getCorrelation(draft, id);
  if (TERMINAL.has(correlation.state)) return correlation;
  correlation.state = state;
  correlation.updatedAt = now;
  return correlation;
}

/** Cancel every live correlation of a principal (revocation / unpair). */
export function cancelCorrelationsForPrincipal(draft, principalId, { now = Date.now() } = {}) {
  let count = 0;
  for (const correlation of Object.values(draft.correlations)) {
    if (correlation.principalId === principalId && !TERMINAL.has(correlation.state)) {
      correlation.state = 'cancelled';
      correlation.updatedAt = now;
      count += 1;
    }
  }
  return count;
}

/** Cancel live correlations whose reply context is gone; the user must re-chat. */
export function cancelCorrelationsForContext(draft, replyContextId, { now = Date.now() } = {}) {
  let count = 0;
  for (const correlation of Object.values(draft.correlations)) {
    if (correlation.replyContextId === replyContextId && !TERMINAL.has(correlation.state)) {
      correlation.state = 'cancelled';
      correlation.updatedAt = now;
      count += 1;
    }
  }
  return count;
}

/**
 * Reconcile a restart: a reserved correlation never reached the Host, so it is
 * cancelled; an active one whose turn evidence is gone is uncertain (its reply
 * text may be lost), never silently completed.
 */
export function reconcileCorrelations(draft, { now = Date.now() } = {}) {
  let cancelled = 0;
  let uncertainCount = 0;
  for (const correlation of Object.values(draft.correlations)) {
    if (correlation.state === 'reserved') {
      correlation.state = 'cancelled';
      correlation.updatedAt = now;
      cancelled += 1;
    } else if (correlation.state === 'active') {
      correlation.state = 'uncertain';
      correlation.updatedAt = now;
      uncertainCount += 1;
    }
  }
  return { cancelled, uncertain: uncertainCount };
}

export function pruneCorrelations(draft, { now = Date.now() } = {}) {
  const cutoff = now - LIMITS.CORRELATION_TERMINAL_RETENTION_MS;
  for (const [id, correlation] of Object.entries(draft.correlations)) {
    if (TERMINAL.has(correlation.state) && correlation.updatedAt < cutoff) delete draft.correlations[id];
  }
  const ids = Object.keys(draft.correlations);
  if (ids.length <= LIMITS.MAX_CORRELATIONS) return ids.length;
  const terminal = ids
    .filter((id) => TERMINAL.has(draft.correlations[id].state))
    .sort((a, b) => draft.correlations[a].updatedAt - draft.correlations[b].updatedAt || (a < b ? -1 : 1));
  for (let i = 0; i < ids.length - LIMITS.MAX_CORRELATIONS && i < terminal.length; i++) delete draft.correlations[terminal[i]];
  return Object.keys(draft.correlations).length;
}

function nowOf(ctx) {
  return Number.isInteger(ctx?.now) ? ctx.now : Date.now();
}