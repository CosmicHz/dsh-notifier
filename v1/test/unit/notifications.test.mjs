// T14 notifications: routing, segmentation, retry, evidence layering and the
// bounded send queue. Acceptance targets D01 (partial not resent), D02 (accepted
// never promoted to confirmed) and D03 (retry/queue bounds).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/storage/store.mjs';
import { createConnection } from '../../src/services/connections.mjs';
import { saveRoute } from '../../src/services/routes.mjs';
import {
  notify,
  testNotification,
  runDelivery,
  segmentMessage,
  segmentText,
  retryPolicyOf,
  backoffFor,
  createSendLimiter,
} from '../../src/services/notifications.mjs';
import { makeNetwork } from '../protocol/helpers.mjs';

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-notify-'));
  const { store } = await openStore(dir);
  return store;
}

function slackConnection(overrides = {}) {
  return {
    channelId: 'slack',
    label: 'SL',
    config: { outbound: {} },
    secretChanges: [
      { path: 'outbound.webhook', op: 'set', value: { kind: 'literal', value: 'https://hooks.slack.com/services/T/B/X' } },
    ],
    notificationEnabled: true,
    destination: { label: 'chan', target: {} },
    ...overrides,
  };
}

function stubProvider(handler) {
  const calls = [];
  return {
    calls,
    async send(args) {
      calls.push(args);
      return handler(args, calls.length - 1);
    },
  };
}

const retryableError = () => Object.assign(new Error('boom'), { code: 'NETWORK', retryable: true, uncertain: false });

// --- segmentation ----------------------------------------------------------

test('segmentMessage keeps a single piece intact and folds a long title into the head', () => {
  const single = segmentMessage({ title: 'Hi', content: 'short' }, { maxCodepoints: 100 });
  assert.deepEqual(single, [{ title: 'Hi', content: 'short' }]);

  const many = segmentMessage({ title: 'T', content: 'aaaabbbbcccc' }, { maxCodepoints: 5 });
  assert.ok(many.length >= 3);
  assert.equal(many[0].title, '', 'multi-segment drops the title from every piece');
  assert.equal(many.map((p) => p.content).join(''), 'T\n\naaaabbbbcccc', 'segmentation preserves every character');
});

test('segmentText prefers a sentence boundary inside the window', () => {
  const parts = segmentText('hello。world!!extra', { maxCodepoints: 7 });
  assert.equal(parts[0], 'hello。');
  assert.equal(parts.join(''), 'hello。world!!extra');
});

// --- D01: partial sends are never resent -----------------------------------

test('D01 a partially-sent message stops and never resends accepted segments', async () => {
  const provider = stubProvider((_args, index) => {
    if (index === 1) throw retryableError();
    return { status: 'accepted' };
  });
  const sleeps = [];
  const result = await runDelivery({
    provider,
    config: {},
    message: { title: '', content: 'aaaabbbbcccc', level: 'active' },
    level: 'active',
    maxCodepoints: 5,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(provider.calls.length, 2, 'segment 3 is never attempted after the failure');
  assert.equal(result.segmentCount, 3);
  assert.equal(result.sentCount, 1);
  assert.equal(result.delivery, 'partial');
  assert.equal(result.status, 'failed');
  assert.deepEqual(provider.calls.map((c) => c.message.content), ['aaaab', 'bbbcc']);
  assert.equal(sleeps.length, 0, 'a partial send is not retried as a whole');
  assert.equal(result.attempts.length, 1);
});

// --- D02: accepted never masquerades as confirmed --------------------------

test('D02 an accepted provider result stays accepted, never confirmed', async () => {
  const provider = stubProvider(() => ({ status: 'accepted' }));
  const result = await runDelivery({ provider, config: {}, message: { title: 'T', content: 'C' }, level: 'passive' });
  assert.equal(result.status, 'accepted');
  assert.equal(result.delivery, 'complete');
  assert.deepEqual(result.providerMessageIds, []);
});

test('D02 a confirmed provider result is confirmed and keeps its message id', async () => {
  const provider = stubProvider(() => ({ status: 'confirmed', providerMessageId: 'mid-1' }));
  const result = await runDelivery({ provider, config: {}, message: { title: 'T', content: 'C' }, level: 'active' });
  assert.equal(result.status, 'confirmed');
  assert.deepEqual(result.providerMessageIds, ['mid-1']);
});

// --- retry policy ----------------------------------------------------------

test('retry policy: passive never retries, active retries once, timeSensitive twice', async () => {
  assert.equal(retryPolicyOf('passive').attempts, 1);
  assert.equal(retryPolicyOf('active').attempts, 2);
  assert.equal(retryPolicyOf('timeSensitive').attempts, 3);

  const passive = stubProvider(() => { throw retryableError(); });
  const passiveSleeps = [];
  await runDelivery({ provider: passive, config: {}, message: { title: '', content: 'x' }, level: 'passive', sleep: async (m) => passiveSleeps.push(m) });
  assert.equal(passive.calls.length, 1);
  assert.equal(passiveSleeps.length, 0);

  const active = stubProvider((_a, i) => { if (i === 0) throw retryableError(); return { status: 'accepted' }; });
  const activeSleeps = [];
  const activeResult = await runDelivery({ provider: active, config: {}, message: { title: '', content: 'x' }, level: 'active', sleep: async (m) => activeSleeps.push(m), random: () => 0 });
  assert.equal(active.calls.length, 2);
  assert.deepEqual(activeSleeps, [1000]);
  assert.equal(activeResult.status, 'accepted');

  const ts = stubProvider((_a, i) => { if (i < 2) throw retryableError(); return { status: 'accepted' }; });
  const tsSleeps = [];
  await runDelivery({ provider: ts, config: {}, message: { title: '', content: 'x' }, level: 'timeSensitive', sleep: async (m) => tsSleeps.push(m), random: () => 0 });
  assert.equal(ts.calls.length, 3);
  assert.deepEqual(tsSleeps, [1000, 2000]);
});

test('D03 a 429 beyond the Retry-After cap is not retried even when timeSensitive', async () => {
  const provider = stubProvider(() => {
    throw Object.assign(new Error('rate limited'), { code: 'HTTP_ERROR', retryable: false, retryAfterMs: 60000, status: 429 });
  });
  const sleeps = [];
  const result = await runDelivery({ provider, config: {}, message: { title: '', content: 'x' }, level: 'timeSensitive', sleep: async (m) => sleeps.push(m) });
  assert.equal(provider.calls.length, 1);
  assert.equal(sleeps.length, 0);
  assert.equal(result.status, 'failed');
  assert.equal(result.errorCode, 'HTTP_ERROR');
});

test('backoffFor floors by Retry-After and adds bounded jitter', () => {
  const policy = retryPolicyOf('active');
  assert.equal(backoffFor(1, policy, null, () => 0), 1000);
  assert.equal(backoffFor(1, policy, { retryAfterMs: 3000 }, () => 0), 3000);
  assert.equal(backoffFor(2, policy, null, () => 0), 2000);
  assert.ok(backoffFor(1, policy, null, () => 0.999999) <= 1250, 'jitter stays within its bound');
});

// --- D03: bounded queue ----------------------------------------------------

test('D03 the send queue rejects overflow with CAPACITY instead of growing unbounded', async () => {
  const limiter = createSendLimiter({ globalMax: 1, perAccountMax: 1, queueMax: 1 });
  let releaseFirst;
  const first = limiter.run('a', () => new Promise((resolve) => { releaseFirst = resolve; }));
  const second = limiter.run('a', () => Promise.resolve('second'));
  await assert.rejects(
    limiter.run('a', () => Promise.resolve('third')),
    (e) => e.code === 'CAPACITY',
  );
  releaseFirst('first');
  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
  assert.equal(limiter.running, 0);
  assert.equal(limiter.queued, 0);
});

test('D03 per-account concurrency frees a slot when a task settles', async () => {
  const limiter = createSendLimiter({ globalMax: 4, perAccountMax: 1, queueMax: 8 });
  const order = [];
  const a = limiter.run('a', async () => { order.push('a'); });
  const b = limiter.run('b', async () => { order.push('b'); });
  await Promise.all([a, b]);
  assert.deepEqual(order.sort(), ['a', 'b']);
});

// --- facade + persistence --------------------------------------------------

test('notify resolves an explicit destination and persists a receipt + effect', async () => {
  const store = await freshStore();
  const conn = await createConnection(store, slackConnection(), { now: 10 });
  const network = makeNetwork(() => ({ status: 200, text: 'ok' }));
  const { receipts } = await notify(
    store,
    { requestId: crypto.randomUUID(), text: 'hello', destinationIds: [conn.destination.id] },
    { now: 1000, network, limiter: createSendLimiter() },
  );
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, 'accepted');
  assert.equal(receipts[0].delivery, 'complete');
  assert.equal(receipts[0].accountId, conn.account.id);
  assert.equal(receipts[0].destinationLabel, 'chan');
  assert.equal(network.calls.length, 1);

  const snap = store.snapshot();
  assert.equal(Object.keys(snap.receipts).length, 1);
  const effects = Object.values(snap.effects);
  assert.equal(effects.length, 1);
  assert.equal(effects[0].status, 'accepted');
  assert.deepEqual(receipts[0].effectIds, [effects[0].id]);
  assert.equal(effects[0].requestKey.includes('hello'), false, 'requestKey never contains message content');
});

test('notify honours a quiet route and records skipped receipts without sending', async () => {
  const store = await freshStore();
  const conn = await createConnection(store, slackConnection(), { now: 10 });
  await saveRoute(store, { scope: 'global', scopeId: '*', destinationIds: [conn.destination.id], quiet: true }, { now: 20 });
  const network = makeNetwork(() => ({ status: 200, text: 'ok' }));
  const { receipts } = await notify(
    store,
    { requestId: crypto.randomUUID(), text: 'hello' },
    { now: 1000, network, limiter: createSendLimiter() },
  );
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, 'skipped');
  assert.equal(receipts[0].errorCode, 'QUIET');
  assert.equal(network.calls.length, 0);
});

test('notify skips a disabled account instead of sending', async () => {
  const store = await freshStore();
  const conn = await createConnection(store, slackConnection({ notificationEnabled: false }), { now: 10 });
  const network = makeNetwork(() => ({ status: 200, text: 'ok' }));
  const { receipts } = await notify(
    store,
    { requestId: crypto.randomUUID(), text: 'hello', destinationIds: [conn.destination.id] },
    { now: 1000, network, limiter: createSendLimiter() },
  );
  assert.equal(receipts[0].status, 'skipped');
  assert.equal(receipts[0].errorCode, 'DISABLED');
  assert.equal(network.calls.length, 0);
});

test('notify without any resolved destination returns no receipts and does not broadcast', async () => {
  const store = await freshStore();
  await createConnection(store, slackConnection(), { now: 10 });
  const { receipts } = await notify(store, { requestId: crypto.randomUUID(), text: 'hello' }, { now: 1000 });
  assert.deepEqual(receipts, []);
});

test('notify rejects a non-UUID requestId and empty text', async () => {
  const store = await freshStore();
  await assert.rejects(notify(store, { requestId: 'nope', text: 'x' }), (e) => e.code === 'VALIDATION');
  await assert.rejects(notify(store, { requestId: crypto.randomUUID(), text: '' }), (e) => e.code === 'VALIDATION');
});

test('notifications.test sends fixed content and returns one receipt', async () => {
  const store = await freshStore();
  const conn = await createConnection(store, slackConnection(), { now: 10 });
  const network = makeNetwork(() => ({ status: 200, text: 'ok' }));
  const receipt = await testNotification(
    store,
    { requestId: crypto.randomUUID(), destinationId: conn.destination.id },
    { now: 1000, network, limiter: createSendLimiter() },
  );
  assert.equal(receipt.kind, 'notification');
  assert.equal(receipt.status, 'accepted');
  assert.equal(network.calls.length, 1);
  const body = new TextDecoder().decode(network.calls[0].body);
  assert.match(body, /Test notification/);
});