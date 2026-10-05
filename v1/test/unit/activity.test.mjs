import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState } from '../../src/domain/schema.mjs';
import { LIMITS } from '../../src/domain/limits.mjs';
import { DomainError } from '../../src/domain/errors.mjs';
import {
  appendActivity, pruneActivity, listActivity, activityCount, normalizeRetentionDays,
} from '../../src/services/activity.mjs';

function state() {
  return createEmptyState();
}

function row(overrides = {}) {
  return { time: 1000, kind: 'notify', status: 'ok', code: null, ...overrides };
}

test('normalizeRetentionDays clamps to settings and defaults when invalid', () => {
  assert.equal(normalizeRetentionDays({ activityRetentionDays: 14 }), 14);
  assert.equal(normalizeRetentionDays({ activityRetentionDays: 0 }), LIMITS.ACTIVITY_RETENTION_DEFAULT_DAYS);
  assert.equal(normalizeRetentionDays({ activityRetentionDays: 99 }), LIMITS.ACTIVITY_RETENTION_DEFAULT_DAYS);
  assert.equal(normalizeRetentionDays({}), LIMITS.ACTIVITY_RETENTION_DEFAULT_DAYS);
  assert.equal(normalizeRetentionDays(undefined), LIMITS.ACTIVITY_RETENTION_DEFAULT_DAYS);
});

test('appendActivity records metadata only and ignores body/secret fields', () => {
  const draft = state();
  const record = appendActivity(draft, {
    time: 5000, kind: 'notify', accountId: 'acc1', sessionId: 'sess1',
    status: 'failed', code: 'NETWORK',
    text: 'leaked body', token: 'secret-token', body: { text: 'x' },
  }, { now: 5000 });
  assert.deepEqual(record, {
    id: record.id, time: 5000, kind: 'notify', accountId: 'acc1',
    sessionId: 'sess1', status: 'failed', code: 'NETWORK',
  });
  assert.deepEqual(Object.keys(record).sort(), ['accountId', 'code', 'id', 'kind', 'sessionId', 'status', 'time']);
  assert.equal('text' in record, false);
  assert.equal('token' in record, false);
  assert.equal('body' in record, false);
  assert.equal(draft.activity.length, 1);
  assert.equal(activityCount(draft), 1);
});

test('appendActivity rejects a missing kind and defaults optional fields', () => {
  const draft = state();
  assert.throws(
    () => appendActivity(draft, { time: 1, status: 'ok' }),
    (e) => e instanceof DomainError && e.code === 'INTERNAL',
  );
  const record = appendActivity(draft, { kind: 'account' }, { now: 777 });
  assert.equal(record.time, 777);
  assert.equal(record.accountId, null);
  assert.equal(record.sessionId, null);
  assert.equal(record.status, 'ok');
  assert.equal(record.code, null);
});

test('pruneActivity enforces the retention window (TTL)', () => {
  const draft = state();
  draft.settings.activityRetentionDays = 1;
  const day = 24 * 60 * 60 * 1000;
  const now = 10 * day;
  draft.activity.push(
    { id: 'old', time: now - day - 1, kind: 'notify', accountId: null, sessionId: null, status: 'ok', code: null },
    { id: 'edge', time: now - day + 1, kind: 'notify', accountId: null, sessionId: null, status: 'ok', code: null },
    { id: 'fresh', time: now, kind: 'notify', accountId: null, sessionId: null, status: 'ok', code: null },
  );
  const removed = pruneActivity(draft, { now });
  assert.equal(removed, 1);
  assert.deepEqual(draft.activity.map((a) => a.id), ['edge', 'fresh']);
});

test('pruneActivity honours an explicit retentionDays override', () => {
  const draft = state();
  const now = 5 * 24 * 60 * 60 * 1000;
  draft.activity.push({ id: 'a', time: now - 3 * 24 * 60 * 60 * 1000, kind: 'notify', accountId: null, sessionId: null, status: 'ok', code: null });
  assert.equal(pruneActivity(draft, { now, retentionDays: 7 }), 0);
  assert.equal(pruneActivity(draft, { now, retentionDays: 1 }), 1);
  assert.equal(draft.activity.length, 0);
});

test('pruneActivity enforces the hard cap keeping newest rows', () => {
  const draft = state();
  const now = 1_000_000;
  for (let i = 0; i < LIMITS.MAX_ACTIVITY + 5; i++) {
    draft.activity.push({ id: `a${i}`, time: now + i, kind: 'notify', accountId: null, sessionId: null, status: 'ok', code: null });
  }
  const removed = pruneActivity(draft, { now, retentionDays: LIMITS.ACTIVITY_RETENTION_MAX_DAYS });
  assert.equal(removed, 5);
  assert.equal(draft.activity.length, LIMITS.MAX_ACTIVITY);
  assert.equal(draft.activity[0].id, 'a5');
  assert.equal(draft.activity.at(-1).id, `a${LIMITS.MAX_ACTIVITY + 4}`);
});

test('appendActivity prunes on write so the log never exceeds the cap', () => {
  const draft = state();
  draft.settings.activityRetentionDays = LIMITS.ACTIVITY_RETENTION_MAX_DAYS;
  const base = Date.now();
  draft.activity = Array.from({ length: LIMITS.MAX_ACTIVITY }, (_, i) => ({
    id: `a${i}`, time: base - LIMITS.MAX_ACTIVITY + i, kind: 'notify', accountId: null, sessionId: null, status: 'ok', code: null,
  }));
  appendActivity(draft, row({ time: base + 1 }));
  assert.equal(draft.activity.length, LIMITS.MAX_ACTIVITY);
  assert.ok(draft.activity.some((a) => a.time === base + 1), 'newest row survives');
  assert.equal(draft.activity.some((a) => a.id === 'a0'), false, 'oldest row evicted by the cap');
});

test('listActivity paginates newest-first with an opaque cursor', () => {
  const draft = state();
  for (let i = 0; i < 5; i++) {
    draft.activity.push({ id: `a${i}`, time: i, kind: 'notify', accountId: null, sessionId: null, status: 'ok', code: null });
  }
  const first = listActivity(draft, { limit: 2 });
  assert.deepEqual(first.items.map((a) => a.id), ['a4', 'a3']);
  assert.equal(first.nextCursor, 'a3');
  assert.equal(first.total, 5);

  const second = listActivity(draft, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((a) => a.id), ['a2', 'a1']);
  assert.equal(second.nextCursor, 'a1');

  const third = listActivity(draft, { limit: 2, cursor: second.nextCursor });
  assert.deepEqual(third.items.map((a) => a.id), ['a0']);
  assert.equal(third.nextCursor, null);
});

test('listActivity treats an unknown cursor as end-of-list', () => {
  const draft = state();
  draft.activity.push({ id: 'a', time: 1, kind: 'notify', accountId: null, sessionId: null, status: 'ok', code: null });
  const page = listActivity(draft, { limit: 10, cursor: 'missing' });
  assert.deepEqual(page.items, []);
  assert.equal(page.nextCursor, null);
});