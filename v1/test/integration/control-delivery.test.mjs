// R13: control delivery is idempotent and segment-accurate. A platform 200 proves
// receipt, never delivery; an uncertain outcome is journaled and never resent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, commit } from '../../src/storage/store.mjs';
import { createAccount } from '../../src/services/accounts.mjs';
import { upsertReplyContext } from '../../src/services/reply-contexts.mjs';
import { sendControlReply } from '../../src/services/control-replies.mjs';

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-delivery-'));
  const { store } = await openStore(dir);
  return store;
}

async function accountWithContext(store) {
  const account = await createAccount(store, {
    channelId: 'telegram',
    label: 'TG',
    config: { outbound: {}, inbound: {} },
    secretChanges: [{ path: 'inbound.botToken', op: 'set', value: { kind: 'literal', value: '"tok-1"' } }],
    notificationEnabled: false,
    controlEnabled: true,
  }, { now: 100 });
  const context = await commit(store, null, (draft) =>
    upsertReplyContext(draft, { accountId: account.id, userId: 'u-1', chatId: 'c-1', transportData: { t: 1 } }, { now: 100 }));
  return { account, context };
}

function provider(impl = {}) {
  return {
    id: 'telegram',
    capabilities: { outbound: true, inbound: true, controlReply: true },
    async sendControlReply(x) {
      impl.calls?.push(x);
      if (impl.throw) throw impl.throw;
      return impl.result ?? { status: 'accepted', providerMessageId: 'pm-1' };
    },
  };
}

const REQ = '22222222-2222-4222-8222-222222222222';

test('R13 the same requestId calls the channel once and replays the receipt', async () => {
  const store = await freshStore();
  const { account, context } = await accountWithContext(store);
  const calls = [];
  const p = provider({ calls });
  const input = { accountId: account.id, replyContextId: context.id, content: { text: 'hi' }, requestId: REQ };
  const first = await sendControlReply(store, input, { now: 200, provider: p });
  const second = await sendControlReply(store, input, { now: 201, provider: p });
  assert.equal(calls.length, 1, 'a retry must not resend the same request');
  assert.equal(first.id, second.id);
  assert.equal(Object.keys(store.snapshot().receipts).length, 1);
});

test('R13 a partial segment failure keeps the accepted segment and journals both', async () => {
  const store = await freshStore();
  const { account, context } = await accountWithContext(store);
  const error = Object.assign(new Error('second segment failed'), { code: 'API_ERROR', delivery: 'partial' });
  error.segments = [
    { index: 0, status: 'accepted', providerMessageId: 'pm-1', errorCode: null },
    { index: 1, status: 'failed', providerMessageId: null, errorCode: 'API_ERROR' },
  ];
  await assert.rejects(
    sendControlReply(store, {
      accountId: account.id, replyContextId: context.id, content: { text: 'x' }, requestId: REQ,
    }, { now: 200, provider: provider({ throw: error }) }),
    (e) => e.code === 'API_ERROR',
  );
  const state = store.snapshot();
  const receipt = Object.values(state.receipts)[0];
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.delivery, 'partial');
  assert.deepEqual(receipt.providerMessageIds, ['pm-1'], 'the accepted segment is never lost');
  const effects = receipt.effectIds.map((id) => state.effects[id]);
  assert.equal(effects[0].status, 'accepted');
  assert.equal(effects[1].status, 'failed');
});

test('R13 an uncertain outcome is journaled and never resent automatically', async () => {
  const store = await freshStore();
  const { account, context } = await accountWithContext(store);
  const calls = [];
  const uncertain = Object.assign(new Error('timeout'), { code: 'TIMEOUT', uncertain: true });
  const input = { accountId: account.id, replyContextId: context.id, content: { text: 'x' }, requestId: REQ };
  await assert.rejects(sendControlReply(store, input, { now: 200, provider: provider({ calls, throw: uncertain }) }));
  const state = store.snapshot();
  const receipt = Object.values(state.receipts)[0];
  assert.equal(receipt.status, 'uncertain');
  assert.equal(state.effects[Object.keys(state.effects)[0]].status, 'uncertain');
  assert.equal(calls.length, 1);
  // A retry must not silently resend something that may already have arrived: the
  // journaled uncertain receipt is replayed and the channel is not called again.
  const replay = await sendControlReply(store, input, { now: 201, provider: provider({ calls }) });
  assert.equal(calls.length, 1, 'no automatic resend of an uncertain delivery');
  assert.equal(replay.status, 'uncertain');
});

test('R13 a platform 200 is accepted, never a fabricated confirmed', async () => {
  const store = await freshStore();
  const { account, context } = await accountWithContext(store);
  const accepted = await sendControlReply(store, {
    accountId: account.id, replyContextId: context.id, content: { text: 'x' }, requestId: REQ,
  }, { now: 200, provider: provider({ result: { status: 'accepted', providerMessageId: 'pm-9' } }) });
  assert.equal(accepted.status, 'accepted');
  const receipt = store.snapshot().receipts[accepted.id];
  assert.equal(receipt.status, 'accepted');
  assert.equal(receipt.delivery, 'complete');
});
