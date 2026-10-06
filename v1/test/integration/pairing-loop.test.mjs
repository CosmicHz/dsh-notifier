// R10: the default manager chain redeems pairings and /unpair only ever removes
// the caller. Real Store + manager + pairing/conversation wiring (no overrides).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/storage/store.mjs';
import { createAccount } from '../../src/services/accounts.mjs';
import { issuePairing } from '../../src/services/pairing.mjs';
import { createRuntimeManager } from '../../src/runtime/manager.mjs';
import { createFixtureHost } from '../fixtures/host.mjs';
import { openInteraction } from '../../src/services/interactions.mjs';
import { issueReplyRef } from '../../src/services/reply-refs.mjs';

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pair-'));
  const { store } = await openStore(dir);
  const account = await createAccount(store, {
    channelId: 'telegram',
    label: 'TG',
    enabled: true,
    config: { outbound: {}, inbound: {} },
    notificationEnabled: false,
    controlEnabled: true,
    secretChanges: [{ op: 'set', path: 'inbound.botToken', value: { kind: 'literal', value: '"fake-token"' } }],
  }, { now: 100 });
  return { store, account };
}

function controlProvider(sent) {
  return {
    id: 'telegram',
    capabilities: { outbound: true, inbound: true, controlReply: true },
    async start() { return { async stop() {} }; },
    async sendControlReply({ content }) { sent.push(content.text); return { status: 'accepted', providerMessageId: `pm-${sent.length}` }; },
  };
}

test('R10 a pairing code redeems exactly once through the default chain', async () => {
  const { store, account } = await scratch();
  const sent = [];
  const manager = createRuntimeManager({ store, host: createFixtureHost(), resolveProvider: () => controlProvider(sent) });
  await manager.start();
  const epoch = manager.connectionView(account.id).epoch;
  await issuePairing(store, { accountId: account.id, code: 'ONCE1234' });
  const first = await manager.ingest({
    accountId: account.id, eventId: 'e-1', epoch, userId: 'u-1', chatId: 'c-1', kind: 'message', text: '/pair ONCE1234',
  });
  assert.ok(first.outcome, `no outcome: ${JSON.stringify(first)}`);
  assert.equal(first.outcome.paired, true);
  const second = await manager.ingest({
    accountId: account.id, eventId: 'e-2', epoch, userId: 'u-2', chatId: 'c-2', kind: 'message', text: '/pair ONCE1234',
  });
  assert.equal(second.outcome.paired, false, 'a code is never redeemed twice');
  assert.equal(Object.keys(store.snapshot().principals).length, 1);
  await manager.stop();
});

test('R10 /unpair removes only the caller; another paired identity is untouched', async () => {
  const { store, account } = await scratch();
  const sent = [];
  const manager = createRuntimeManager({ store, host: createFixtureHost(), resolveProvider: () => controlProvider(sent) });
  await manager.start();
  const epoch = manager.connectionView(account.id).epoch;
  await issuePairing(store, { accountId: account.id, code: 'AAAA1111' });
  await issuePairing(store, { accountId: account.id, code: 'BBBB2222' });
  await manager.ingest({ accountId: account.id, eventId: 'e-p1', epoch, userId: 'u-1', chatId: 'c-1', kind: 'message', text: '/pair AAAA1111' });
  await manager.ingest({ accountId: account.id, eventId: 'e-p2', epoch, userId: 'u-2', chatId: 'c-2', kind: 'message', text: '/pair BBBB2222' });
  const principals = Object.values(store.snapshot().principals);
  assert.equal(principals.length, 2);
  const a = principals.find((p) => p.userId === 'u-1');
  const b = principals.find((p) => p.userId === 'u-2');

  await store.transact(null, (draft) => {
    draft.bindings[a.id] = { principalId: a.id, sessionId: 's-1', updatedAt: 900 };
    draft.bindings[b.id] = { principalId: b.id, sessionId: 's-2', updatedAt: 900 };
    const ia = openInteraction(draft, { type: 'approval', sessionId: 's-1', hostRef: 'h-a', prompt: 'a?', id: 'int-a' }, { now: 900 });
    const ib = openInteraction(draft, { type: 'approval', sessionId: 's-2', hostRef: 'h-b', prompt: 'b?', id: 'int-b' }, { now: 900 });
    issueReplyRef(draft, { accountId: account.id, principalId: a.id, replyContextId: a.replyContextId, interactionId: ia.id, action: 'approve', expiresAt: 9_000_000, token: 'tok-a', id: 'ref-a' }, { now: 900 });
    issueReplyRef(draft, { accountId: account.id, principalId: b.id, replyContextId: b.replyContextId, interactionId: ib.id, action: 'approve', expiresAt: 9_000_000, token: 'tok-b', id: 'ref-b' }, { now: 900 });
    return null;
  });

  const unpaired = await manager.ingest({
    accountId: account.id, eventId: 'e-u1', epoch, userId: 'u-1', chatId: 'c-1', kind: 'message', text: '/unpair',
  });
  assert.equal(unpaired.outcome.name, 'unpair');
  const after = store.snapshot();
  assert.equal(after.principals[a.id], undefined, 'the caller is removed');
  assert.equal(after.bindings[a.id], undefined);
  assert.equal(after.replyRefs['ref-a'].state, 'revoked');
  assert.ok(after.principals[b.id], 'the other identity survives');
  assert.equal(after.bindings[b.id].sessionId, 's-2');
  assert.equal(after.replyRefs['ref-b'].state, 'active');
  await manager.stop();
});
