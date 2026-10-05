// Bounded inbound inbox (02-DATA.md inbox, 04-PROVIDERS.md callback, W20).
//
// Reliability rule: persist receipt BEFORE the platform ACK, and never advance a
// transport cursor past an event that is not durably received. The inbox stores
// no chat text; when a restart loses the payload a `received` record is marked
// uncertain rather than pretending the journal can rebuild the message.
import { DomainError, validationError } from '../domain/errors.mjs';
import { LIMITS } from '../domain/limits.mjs';
import { compoundKey } from '../domain/schema.mjs';

export const INBOX_STATUSES = Object.freeze(['received', 'claimed', 'done', 'uncertain']);

export function inboxKeyOf(accountId, eventId) {
  if (typeof accountId !== 'string' || accountId === '') throw validationError('accountId is required');
  if (typeof eventId !== 'string' || eventId === '' || eventId.length > 512) {
    throw validationError('eventId must be a non-empty string <=512');
  }
  return compoundKey([accountId, eventId]);
}

function nowOf(ctx) {
  return Number.isInteger(ctx?.now) ? ctx.now : Date.now();
}

function accountEntries(draft, accountId) {
  return Object.entries(draft.inbox).filter(([, record]) => record.accountId === accountId);
}

/**
 * Durably receive one inbound event. A duplicate is reported as replayed and the
 * caller must not process it again, except the narrow redelivery case: a record
 * that is `uncertain`, whose work never started (no effectIds) and whose original
 * text is recoverable, may be re-received once.
 */
export function receiveInbound(draft, { accountId, eventId, now = Date.now(), ttlMs = LIMITS.INBOX_WINDOW_MS, canRecover = false }) {
  const key = inboxKeyOf(accountId, eventId);
  const existing = draft.inbox[key];
  if (existing) {
    const recoverable =
      existing.status === 'uncertain' && canRecover === true && (existing.effectIds ?? []).length === 0;
    if (recoverable) {
      existing.status = 'received';
      existing.receivedAt = now;
      existing.expiresAt = now + ttlMs;
      return { key, replayed: false, recovered: true, status: 'received' };
    }
    return { key, replayed: true, recovered: false, status: existing.status };
  }

  const entries = accountEntries(draft, accountId);
  if (entries.length >= LIMITS.INBOX_PER_ACCOUNT) {
    throw new DomainError('CAPACITY', `inbox for account has reached ${LIMITS.INBOX_PER_ACCOUNT} entries`);
  }
  draft.inbox[key] = {
    accountId,
    eventId,
    status: 'received',
    receivedAt: now,
    expiresAt: now + ttlMs,
    effectIds: [],
  };
  return { key, replayed: false, recovered: false, status: 'received' };
}

export function getInbound(draft, key) {
  return draft.inbox[key] ?? null;
}

/**
 * Atomically claim an event for processing. Returns the claimed record. A
 * duplicate delivery that is already claimed/done is returned as-is so the caller
 * can skip; an uncertain record refuses re-execution.
 */
export function claimInbound(draft, key, { now = Date.now() } = {}) {
  const record = draft.inbox[key];
  if (!record) throw new DomainError('INTERNAL', 'inbox record not found');
  if (record.status === 'received') {
    record.status = 'claimed';
    record.receivedAt = record.receivedAt;
    record.expiresAt = Math.max(record.expiresAt, now + LIMITS.INBOX_WINDOW_MS);
    return { record, claimed: true };
  }
  if (record.status === 'uncertain') throw new DomainError('UNCERTAIN', 'inbound event outcome is uncertain');
  return { record, claimed: false };
}

export function completeInbound(draft, key, { effectIds = null, now = Date.now() } = {}) {
  const record = draft.inbox[key];
  if (!record) throw new DomainError('INTERNAL', 'inbox record not found');
  record.status = 'done';
  if (Array.isArray(effectIds)) record.effectIds = [...effectIds];
  record.receivedAt = record.receivedAt;
  record.expiresAt = Math.max(record.expiresAt, now + LIMITS.INBOX_WINDOW_MS);
  return record;
}

export function markInboundUncertain(draft, key, { now = Date.now() } = {}) {
  const record = draft.inbox[key];
  if (!record) throw new DomainError('INTERNAL', 'inbox record not found');
  if (record.status === 'done') return record;
  record.status = 'uncertain';
  record.expiresAt = Math.max(record.expiresAt, now + LIMITS.INBOX_WINDOW_MS);
  return record;
}

/**
 * True only when the account has no in-flight (received/claimed) events: the
 * transport cursor may advance to the continuous received watermark.
 */
export function canAdvanceCursor(draft, accountId) {
  return !accountEntries(draft, accountId).some(
    ([, record]) => record.status === 'received' || record.status === 'claimed',
  );
}

/** Record a provider cursor only when it is safe to advance (W20). */
export function advanceCursor(draft, accountId, transportData, { now = Date.now() } = {}) {
  if (!canAdvanceCursor(draft, accountId)) {
    return { advanced: false, reason: 'IN_FLIGHT_EVENTS' };
  }
  const bytes = Buffer.byteLength(JSON.stringify(transportData ?? {}), 'utf8');
  if (bytes > LIMITS.CURSOR_MAX_BYTES) throw validationError(`cursor exceeds ${LIMITS.CURSOR_MAX_BYTES} bytes`);
  draft.cursors[accountId] = { transportData: structuredClone(transportData ?? {}), updatedAt: now };
  return { advanced: true };
}

/**
 * Expire old records and enforce the per-account cap. In-flight records are never
 * evicted early; if the cap is hit by in-flight work the caller already fails
 * closed at receive time with CAPACITY.
 */
export function pruneInbox(draft, { now = Date.now() } = {}) {
  for (const [key, record] of Object.entries(draft.inbox)) {
    if (record.expiresAt <= now) delete draft.inbox[key];
  }
  const accounts = new Set(Object.values(draft.inbox).map((record) => record.accountId));
  for (const accountId of accounts) {
    const entries = accountEntries(draft, accountId);
    if (entries.length <= LIMITS.INBOX_PER_ACCOUNT) continue;
    const removable = entries
      .filter(([, record]) => record.status === 'done' || record.status === 'uncertain')
      .sort((a, b) => a[1].receivedAt - b[1].receivedAt);
    for (let i = 0; i < entries.length - LIMITS.INBOX_PER_ACCOUNT && i < removable.length; i++) {
      delete draft.inbox[removable[i][0]];
    }
  }
  return Object.keys(draft.inbox).length;
}

export { nowOf as inboxNowOf };