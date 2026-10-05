// B02: control replies are an inbound-channel return path, not a notification
// (W01). They ignore route/quiet but honour account.enabled + controlEnabled and a
// usable reply context, and always leave a control receipt + controlReply effect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, commit } from '../../src/storage/store.mjs';
import { createAccount } from '../../src/services/accounts.mjs';
import { upsertReplyContext } from '../../src/services/reply-contexts.mjs';
import { updateSettings } from '../../src/services/settings.mjs';
import { sendControlReply, normalizeControlContent } from '../../src/services/control-replies.mjs';

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-control-'));
  const { store } = await openStore(dir);
  return store;
}

async function accountWithContext(store, { controlEnabled = true } = {}) {
  const account = await createAccount(store, {
    channelId: 'telegram',
    label: 'TG',
    config: { outbound: {}, inbound: {} },
    secretChanges: [{ path: 'inbound.botToken', op: 'set', value: { kind: 'literal', value: '"tok-1"' } }],
    notificationEnabled: false,
    controlEnabled,
  }, { now: 100 });
  const context = await commit(store, null, (draft) =>
    upsertReplyContext(draft, { accountId: account.id, userId: 'u-1', chatId: 'c-1', transportData: { t: 1 } }, { now: 100 }));
  return { account, context };
}

function fakeProvider(impl = {}) {
  return {
    id: 'telegram',
    capabilities: { outbound: true, inbound: true, controlReply: true },
    async sendControlReply(x) {
      if (impl.throw) throw impl.throw;
      return impl.result ?? { status: 'accepted', providerMessageId: 'pm-1' };
    },
  };
}

test('W01 a control reply ignores route/quiet and lands on the inbound channel', async () => {
  const store = await freshStore();
  const { account, context } = await accountWithContext(store);
  // Make notification delivery impossible: quiet on + no routes.
  await updateSettings(store, { expectedRevision: 0, patch: { quiet: true } }, { now: 1 });

  const receipt = await sendControlReply(store, {
    accountId: account.id,
    replyContextId: context.id,
    content: { text: 'approved' },
    requestId: '11111111-1111-4111-8111-111111111111',
  }, { now: 200, provider: fakeProvider() });

  assert.equal(receipt.kind, 'control');
  assert.equal(receipt.status, 'accepted');
  assert.deepEqual(receipt.providerMessageIds, ['pm-1']);
  const state = store.snapshot();
  const effect = Object.values(state.effects)[0];
  assert.equal(effect.kind, 'controlReply');
  assert.equal(effect.status, 'accepted');
  assert.equal(effect.destinationId, null);
});

test('W01 control requires controlEnabled and a usable reply context', async () => {
  const store = await freshStore();
  const { account, context } = await accountWithContext(store, { controlEnabled: false });
  await assert.rejects(
    sendControlReply(store, { accountId: account.id, replyContextId: context.id, content: { text: 'x' } }, { provider: fakeProvider() }),
    (e) => e.code === 'FORBIDDEN',
  );
});

test('W01 an expired reply context reports CONTEXT_EXPIRED instead of guessing', async () => {
  const store = await freshStore();
  const { account, context } = await accountWithContext(store);
  await commit(store, null, (draft) => { draft.replyContexts[context.id].expiresAt = 150; });
  await assert.rejects(
    sendControlReply(store, { accountId: account.id, replyContextId: context.id, content: { text: 'x' } }, { now: 200, provider: fakeProvider() }),
    (e) => e.code === 'EXPIRED' && e.details.code === 'CONTEXT_EXPIRED',
  );
});

test('W01 an uncertain send records an uncertain-effect receipt and never claims success', async () => {
  const store = await freshStore();
  const { account, context } = await accountWithContext(store);
  const boom = Object.assign(new Error('socket reset'), { code: 'NETWORK_ERROR', uncertain: true });
  await assert.rejects(
    sendControlReply(store, { accountId: account.id, replyContextId: context.id, content: { text: 'x' } }, { now: 200, provider: fakeProvider({ throw: boom }) }),
    (e) => e.code === 'NETWORK_ERROR',
  );
  const state = store.snapshot();
  const effect = Object.values(state.effects)[0];
  const receipt = Object.values(state.receipts)[0];
  assert.equal(effect.status, 'uncertain');
  assert.equal(receipt.status, 'uncertain');
  assert.equal(receipt.delivery, 'none');
});

test('a channel without controlReply capability is UNSUPPORTED, not a fake send', async () => {
  const store = await freshStore();
  const { account, context } = await accountWithContext(store);
  await assert.rejects(
    sendControlReply(store, { accountId: account.id, replyContextId: context.id, content: { text: 'x' } },
      { provider: { capabilities: { controlReply: false } } }),
    (e) => e.code === 'UNSUPPORTED',
  );
});

test('normalizeControlContent enforces the control content shape', () => {
  assert.deepEqual(normalizeControlContent({ text: 'hi' }), { text: 'hi', attachments: [], actions: [] });
  assert.throws(() => normalizeControlContent(null), (e) => e.code === 'VALIDATION');
  assert.throws(() => normalizeControlContent({ text: 'x'.repeat(20001) }), (e) => e.code === 'VALIDATION');
});

test('R07 control actions use the frozen {label, token} contract', () => {
  assert.deepEqual(
    normalizeControlContent({ text: 'pick', actions: [{ label: 'Yes', token: 'tok-1' }] }).actions,
    [{ label: 'Yes', token: 'tok-1' }],
  );
  // Legacy/旁路 fields are rejected rather than silently ignored.
  assert.throws(() => normalizeControlContent({ text: 'x', actions: [{ id: 'yes', label: 'Yes', value: 'v' }] }), (e) => e.code === 'VALIDATION');
  assert.throws(() => normalizeControlContent({ text: 'x', actions: [{ label: 'Yes' }] }), (e) => e.code === 'VALIDATION');
  assert.throws(() => normalizeControlContent({ text: 'x', actions: [{ label: 'Yes', token: 'x'.repeat(65) }] }), (e) => e.code === 'VALIDATION');
});

test('R13 the same requestId is idempotent: the channel is called once and the receipt replayed', async () => {
  const store = await freshStore();
  const { account, context } = await accountWithContext(store);
  let calls = 0;
  const provider = {
    id: 'telegram',
    capabilities: { controlReply: true },
    async sendControlReply() { calls += 1; return { status: 'accepted', providerMessageId: 'pm-1' }; },
  };
  const input = { accountId: account.id, replyContextId: context.id, content: { text: 'hi' }, requestId: '22222222-2222-4222-8222-222222222222' };
  const first = await sendControlReply(store, input, { now: 200, provider });
  const second = await sendControlReply(store, input, { now: 201, provider });
  assert.equal(calls, 1);
  assert.equal(first.id, second.id);
  assert.equal(Object.keys(store.snapshot().receipts).length, 1);
});

test('R13 a partial segment failure preserves the accepted segment and a partial receipt', async () => {
  const store = await freshStore();
  const { account, context } = await accountWithContext(store);
  const error = Object.assign(new Error('second segment failed'), { code: 'API_ERROR', delivery: 'partial' });
  error.segments = [
    { index: 0, status: 'accepted', providerMessageId: 'pm-1', errorCode: null },
    { index: 1, status: 'failed', providerMessageId: null, errorCode: 'API_ERROR' },
  ];
  await assert.rejects(
    sendControlReply(store, {
      accountId: account.id, replyContextId: context.id, content: { text: 'x' },
      requestId: '33333333-3333-4333-8333-333333333333',
    }, { now: 200, provider: fakeProvider({ throw: error }) }),
    (e) => e.code === 'API_ERROR',
  );
  const state = store.snapshot();
  const receipt = Object.values(state.receipts)[0];
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.delivery, 'partial');
  assert.deepEqual(receipt.providerMessageIds, ['pm-1']);
  assert.equal(receipt.effectIds.length, 2);
  const effects = receipt.effectIds.map((id) => state.effects[id]);
  assert.equal(effects[0].status, 'accepted');
  assert.equal(effects[1].status, 'failed');
});

test('R14 an expired Host deadline is rejected; a future one is capped to the local TTL', async () => {
  const { openInteraction } = await import('../../src/services/interactions.mjs');
  const { createEmptyState } = await import('../../src/domain/schema.mjs');
  const { LIMITS } = await import('../../src/domain/limits.mjs');
  const draft = createEmptyState();
  draft.accounts['acc-1'] = {
    id: 'acc-1', revision: 0, channelId: 'telegram', label: 'TG', enabled: true,
    notificationEnabled: true, controlEnabled: true, config: { outbound: {}, inbound: {} },
    secrets: {}, policyRevision: 1, createdAt: 1, updatedAt: 1,
  };
  const base = { type: 'approval', sessionId: 's-1', hostRef: 'h-1', turnId: null, prompt: 'Allow?', choices: [] };
  assert.throws(() => openInteraction(draft, { ...base, expiresAt: 100 }, { now: 200 }), (e) => e.code === 'EXPIRED');
  const capped = openInteraction(draft, { ...base, expiresAt: 10_000_000 }, { now: 1_000 });
  assert.equal(capped.expiresAt, 1_000 + LIMITS.INTERACTION_TTL_MS);
  const shortened = openInteraction(draft, { ...base, expiresAt: 2_000 }, { now: 1_000 });
  assert.equal(shortened.expiresAt, 2_000);
  const defaulted = openInteraction(draft, base, { now: 1_000 });
  assert.equal(defaulted.expiresAt, 1_000 + LIMITS.INTERACTION_TTL_MS);
});