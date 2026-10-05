// Effects, request idempotency and per-leaf delivery evidence (02-DATA.md
// "实体"/"原子性", 03-SERVICES-RPC.md idempotency, W10/W11/W20).
//
// Two ideas live here:
//  - request records keyed by [actorKind,actorId,method,requestId]; a replay with
//    the same hash returns the stored redacted result, a different hash is a
//    CONFLICT. The key isolates callers, so one actor can never read another's
//    result.
//  - effects are the leaf evidence for one external action (one destination, one
//    segment, one attempt). Only a started effect with no result is reconciled to
//    uncertain on restart; work that never started is never dressed up as sent.
import { randomUUID, createHash } from 'node:crypto';
import { DomainError, conflict, validationError } from '../domain/errors.mjs';
import { LIMITS } from '../domain/limits.mjs';
import { compoundKey } from '../domain/schema.mjs';

export const EFFECT_KINDS = Object.freeze(['notify', 'controlReply', 'hostSubmit', 'hostSettle', 'hostStop']);
export const EFFECT_STATUSES = Object.freeze([
  'planned', 'started', 'accepted', 'confirmed', 'failed', 'uncertain', 'cancelled',
]);
export const REQUEST_KINDS = Object.freeze(['config', 'effect']);
export const REQUEST_STATUSES = Object.freeze(['pending', 'done', 'uncertain']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RETENTION_WINDOW_MS = 24 * 60 * 60 * 1000;

export function requireRequestId(value) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw validationError('requestId must be a UUID');
  return value;
}

/** Stable JSON: object keys sorted, arrays in order, so the hash is deterministic. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** Hash covers the method plus the normalized payload (03: "hash含method与规范化payload"). */
export function requestHashOf(method, payload) {
  if (typeof method !== 'string' || method === '') throw new DomainError('INTERNAL', 'method is required');
  return createHash('sha256').update(`${method}\n${canonicalJson(payload)}`).digest('hex');
}

/** Idempotency key = JSON.stringify([actorKind, actorId, method, requestId]). */
export function requestKeyOf(actorKind, actorId, method, requestId) {
  const kind = typeof actorKind === 'string' && actorKind !== '' ? actorKind : 'local-owner';
  const id = typeof actorId === 'string' && actorId !== '' ? actorId : 'local';
  if (typeof method !== 'string' || method === '') throw validationError('method is required');
  requireRequestId(requestId);
  const key = compoundKey([kind, id, method, requestId]);
  if (key.length > 512) throw validationError('requestKey is too long');
  return key;
}

function nowOf(ctx) {
  return Number.isInteger(ctx?.now) ? ctx.now : Date.now();
}

/**
 * Record or replay one idempotent request inside a store mutator.
 * @returns {{replayed:boolean, status:'pending'|'done'|'uncertain', result:unknown, key:string, hash:string}}
 */
export function beginRequest(draft, { actor, method, requestId, payload, kind = 'effect', now = Date.now(), ttlMs = LIMITS.REQUEST_TTL_MS }) {
  if (!REQUEST_KINDS.includes(kind)) throw new DomainError('INTERNAL', `unknown request kind ${kind}`);
  const key = requestKeyOf(actor?.kind, actor?.id, method, requestId);
  const hash = requestHashOf(method, payload);
  const existing = draft.requests[key];
  if (existing) {
    if (existing.hash !== hash) throw conflict('requestId was already used with a different payload');
    return { replayed: true, status: existing.status, result: existing.result, key, hash };
  }
  if (Object.keys(draft.requests).length >= LIMITS.MAX_REQUESTS) pruneRequests(draft, now - RETENTION_WINDOW_MS);
  draft.requests[key] = { hash, kind, status: 'pending', result: null, createdAt: now, expiresAt: now + ttlMs };
  return { replayed: false, status: 'pending', result: null, key, hash };
}

export function completeRequest(draft, key, result, { now = Date.now() } = {}) {
  const record = draft.requests[key];
  if (!record) throw new DomainError('INTERNAL', 'request record is missing');
  if (record.status !== 'pending') return record;
  record.status = 'done';
  record.result = result ?? null;
  record.expiresAt = Math.max(record.expiresAt, now + RETENTION_WINDOW_MS);
  return record;
}

export function markRequestUncertain(draft, key, reason = 'UNCERTAIN') {
  const record = draft.requests[key];
  if (!record) throw new DomainError('INTERNAL', 'request record is missing');
  record.status = 'uncertain';
  record.result = { reason };
  return record;
}

export function pruneRequests(draft, cutoff) {
  for (const [key, record] of Object.entries(draft.requests)) {
    if (record.expiresAt <= cutoff) delete draft.requests[key];
  }
  const keys = Object.keys(draft.requests);
  if (keys.length <= LIMITS.MAX_REQUESTS) return;
  keys.sort((a, b) => draft.requests[a].createdAt - draft.requests[b].createdAt || (a < b ? -1 : 1));
  for (let i = 0; i < keys.length - LIMITS.MAX_REQUESTS; i++) delete draft.requests[keys[i]];
}

// --- effects ---------------------------------------------------------------

function requireEffectKind(kind) {
  if (!EFFECT_KINDS.includes(kind)) throw validationError(`kind must be one of ${EFFECT_KINDS.join('|')}`);
  return kind;
}

/** Create a planned leaf effect (persist before any external call). */
export function createEffect(draft, input, { now = Date.now(), newId = randomUUID } = {}) {
  requireEffectKind(input?.kind);
  const effect = {
    id: input.id ?? newId(),
    requestKey: String(input.requestKey ?? ''),
    accountId: input.accountId ?? null,
    destinationId: input.destinationId ?? null,
    segmentIndex: Number.isInteger(input.segmentIndex) ? input.segmentIndex : 0,
    attempt: Number.isInteger(input.attempt) && input.attempt > 0 ? input.attempt : 1,
    kind: input.kind,
    status: 'planned',
    providerMessageId: null,
    errorCode: null,
    createdAt: now,
    updatedAt: now,
  };
  draft.effects[effect.id] = effect;
  pruneEffects(draft, now - RETENTION_WINDOW_MS);
  return effect;
}

export function markEffectStarted(draft, effectId, { now = Date.now() } = {}) {
  const effect = draft.effects[effectId];
  if (!effect) throw new DomainError('INTERNAL', 'effect not found');
  effect.status = 'started';
  effect.updatedAt = now;
  return effect;
}

/**
 * Record a terminal result for one effect. A later, more conclusive result may
 * upgrade accepted->confirmed but never downgrade a terminal success.
 */
export function applyEffectResult(draft, effectId, { status, providerMessageId = null, errorCode = null, now = Date.now() } = {}) {
  if (!EFFECT_STATUSES.includes(status)) throw validationError(`status must be one of ${EFFECT_STATUSES.join('|')}`);
  const effect = draft.effects[effectId];
  if (!effect) throw new DomainError('INTERNAL', 'effect not found');
  effect.status = status;
  if (providerMessageId !== null) effect.providerMessageId = providerMessageId;
  if (errorCode !== null) effect.errorCode = errorCode;
  effect.updatedAt = now;
  return effect;
}

/**
 * Aggregate per-leaf evidence into one receipt status (18: 全confirmed=confirmed;
 * 全部至少accepted=accepted; 部分成功余失败=failed+partial; 任一无法确认=uncertain;
 * 全部跳过=skipped).
 */
export function aggregateEffectStatus(effects) {
  const list = effects ?? [];
  if (list.length === 0) return { status: 'skipped', delivery: 'none' };
  const count = (s) => list.filter((e) => e.status === s).length;
  const skipped = count('skipped');
  if (skipped === list.length) return { status: 'skipped', delivery: 'none' };
  const uncertainCount = count('uncertain');
  const ok = list.filter((e) => e.status === 'accepted' || e.status === 'confirmed');
  const failed = list.filter((e) => e.status === 'failed' || e.status === 'cancelled');
  const delivery = ok.length === list.length ? 'complete' : ok.length > 0 ? 'partial' : 'none';
  if (uncertainCount > 0) return { status: 'uncertain', delivery };
  if (failed.length === 0) {
    return { status: ok.every((e) => e.status === 'confirmed') ? 'confirmed' : 'accepted', delivery };
  }
  return { status: failed.length === list.length ? 'failed' : 'failed', delivery: ok.length > 0 ? 'partial' : 'none' };
}

export function pruneEffects(draft, cutoff) {
  for (const [id, effect] of Object.entries(draft.effects)) {
    if (effect.createdAt < cutoff) delete draft.effects[id];
  }
  const ids = Object.keys(draft.effects);
  if (ids.length <= LIMITS.MAX_EFFECTS) return;
  ids.sort((a, b) => draft.effects[a].createdAt - draft.effects[b].createdAt || (a < b ? -1 : 1));
  for (let i = 0; i < ids.length - LIMITS.MAX_EFFECTS; i++) delete draft.effects[ids[i]];
}

/**
 * Restart reconciliation: an effect that recorded "started" but has no result
 * cannot be proven either way, so it becomes uncertain. Effects still "planned"
 * never ran and are cancelled (they must not be replayed on boot).
 */
export function reconcileStartedEffects(draft, { now = Date.now(), graceMs = LIMITS.EFFECT_STARTED_GRACE_MS } = {}) {
  let uncertainCount = 0;
  let cancelledCount = 0;
  for (const effect of Object.values(draft.effects)) {
    if (effect.status === 'planned') {
      effect.status = 'cancelled';
      effect.errorCode = effect.errorCode ?? 'NOT_STARTED';
      effect.updatedAt = now;
      cancelledCount += 1;
    } else if (effect.status === 'started') {
      const age = now - effect.updatedAt;
      if (age >= graceMs || graceMs === 0) {
        effect.status = 'uncertain';
        effect.errorCode = effect.errorCode ?? 'RESTART_UNCERTAIN';
        effect.updatedAt = now;
        uncertainCount += 1;
      }
    }
  }
  // Requests with a pending intent that never completed are uncertain too.
  for (const record of Object.values(draft.requests)) {
    if (record.status === 'pending') {
      record.status = 'uncertain';
      record.result = { reason: 'RESTART_UNFINISHED' };
    }
  }
  return { uncertain: uncertainCount, cancelled: cancelledCount };
}

/** Effects belonging to one request key, ordered by segment then attempt. */
export function effectsForRequest(draft, requestKey) {
  return Object.values(draft.effects)
    .filter((effect) => effect.requestKey === requestKey)
    .sort((a, b) => a.segmentIndex - b.segmentIndex || a.attempt - b.attempt || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/** Persist a batch of leaf effects from a delivery result (notifications reuse). */
export function recordDeliveryEffects(draft, { requestKey, accountId, destinationId, kind, attempts, now = Date.now(), newId = randomUUID }) {
  const ids = [];
  for (const attempt of attempts ?? []) {
    for (const outcome of attempt.outcomes ?? []) {
      const effect = createEffect(
        draft,
        {
          requestKey,
          accountId,
          destinationId,
          segmentIndex: outcome.index,
          attempt: attempt.attempt,
          kind,
        },
        { now, newId },
      );
      applyEffectResult(draft, effect.id, {
        status: outcome.status,
        providerMessageId: outcome.providerMessageId ?? null,
        errorCode: outcome.errorCode ?? null,
        now,
      });
      ids.push(effect.id);
    }
  }
  return ids;
}

export { RETENTION_WINDOW_MS as EFFECT_RETENTION_WINDOW_MS };