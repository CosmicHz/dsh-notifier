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