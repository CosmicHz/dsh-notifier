// Activity log and retention (02-DATA.md "限额与保留", 03-SERVICES-RPC.md).
// Activity carries metadata only: no message bodies, no secrets.
import { randomUUID } from 'node:crypto';
import { LIMITS } from '../domain/limits.mjs';
import { DomainError } from '../domain/errors.mjs';

const KINDS = new Set([
  'account', 'connection', 'login', 'route', 'notify', 'control', 'interaction',
  'inbound', 'maintenance',
]);

export function normalizeRetentionDays(settings) {
  const days = settings?.activityRetentionDays;
  if (!Number.isInteger(days) || days < LIMITS.ACTIVITY_RETENTION_MIN_DAYS || days > LIMITS.ACTIVITY_RETENTION_MAX_DAYS) {
    return LIMITS.ACTIVITY_RETENTION_DEFAULT_DAYS;
  }
  return days;
}

/** Append one metadata-only activity row in place (call inside a store mutator). */
export function appendActivity(draft, entry, { now = Date.now() } = {}) {
  if (!entry || typeof entry.kind !== 'string') throw new DomainError('INTERNAL', 'activity.kind is required');
  const record = {
    id: entry.id ?? randomUUID(),
    time: entry.time ?? now,
    kind: entry.kind,
    accountId: entry.accountId ?? null,
    sessionId: entry.sessionId ?? null,
    status: entry.status ?? 'ok',
    code: entry.code ?? null,
  };
  for (const forbidden of ['body', 'text', 'message', 'secret', 'token', 'content']) {
    if (forbidden in record) throw new DomainError('INTERNAL', `activity must not carry ${forbidden}`);
  }
  if (!KINDS.has(record.kind)) record.kind = 'account';
  draft.activity.push(record);
  pruneActivity(draft, { now });
  return record;
}

/**
 * Enforce retention and the hard cap. Returns the number removed. Pure: mutates
 * only the passed draft and never performs IO.
 */
export function pruneActivity(draft, { now = Date.now(), retentionDays = null } = {}) {
  const days = retentionDays ?? normalizeRetentionDays(draft.settings);
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const kept = [];
  let removed = 0;
  for (const item of draft.activity) {
    if (item.time < cutoff) {
      removed += 1;
      continue;
    }
    kept.push(item);
  }
  if (kept.length > LIMITS.MAX_ACTIVITY) {
    const overflow = kept.length - LIMITS.MAX_ACTIVITY;
    kept.sort((a, b) => a.time - b.time);
    kept.splice(0, overflow);
    removed += overflow;
  }
  if (removed > 0) draft.activity = kept;
  return removed;
}

/** Paginate activity newest-first for the diagnostics/overview surfaces. */
export function listActivity(draft, { limit = 50, cursor = null } = {}) {
  const sorted = [...draft.activity].sort((a, b) => b.time - a.time || (a.id < b.id ? 1 : -1));
  let start = 0;
  if (cursor !== null) {
    const index = sorted.findIndex((item) => item.id === cursor);
    start = index === -1 ? sorted.length : index + 1;
  }
  const slice = sorted.slice(start, start + limit);
  const nextCursor = start + limit < sorted.length ? slice[slice.length - 1].id : null;
  return { items: slice, nextCursor, total: sorted.length };
}

export function activityCount(draft) {
  return draft.activity.length;
}