// R11: Host events must produce a real return path - the original chat gets the
// answer and control cards - not just a projection invalidate. One settle only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/storage/store.mjs';
import { createAccount } from '../../src/services/accounts.mjs';
import { upsertReplyContext } from '../../src/services/reply-contexts.mjs';
import { createRuntimeManager } from '../../src/runtime/manager.mjs';
import { createFixtureHost } from '../fixtures/host.mjs';
import { reserveCorrelation, bindCorrelationTurn } from '../../src/services/correlations.mjs';

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-loop-'));
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

async function seedPrincipal(store, account) {
  await store.transact(null, (draft) => {
    upsertReplyContext(draft, { accountId: account.id, userId: 'u-1', chatId: 'c-1', id: 'rc-1' }, { now: 10 });
    draft.principals['p-1'] = {
      id: 'p-1', revision: 0, accountId: account.id, userId: 'u-1', role: 'owner', canConverse: true,
      sessionIds: ['s-1'], enabled: true, replyContextId: 'rc-1', createdAt: 10, updatedAt: 10,
    };
    return null;
  });
}

function replyCapturingProvider(sent) {
  return {
    id: 'telegram',
    capabilities: { outbound: true, inbound: true, controlReply: true },
    async start() { return { async stop() {} }; },
    async sendControlReply({ content }) { sent.push(content); return { status: 'accepted', providerMessageId: `pm-${sent.length}` }; },
  };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

async function seedCorrelation(store, account, { id, requestId, hostRef, turnId, now = 20 }) {
  await store.transact(null, (draft) => {
    const { correlation } = reserveCorrelation(draft, {
      accountId: account.id, principalId: 'p-1', replyContextId: 'rc-1', sessionId: 's-1', requestId,
    }, { now, newId: () => id });
    bindCorrelationTurn(draft, correlation.id, { hostRef, turnId, now: now + 1 });
    return null;
  });
}

test('R11 turn.output/turn.completed delivers the answer to the original chat', async () => {
  const { store, account } = await scratch();
  await seedPrincipal(store, account);
  const sent = [];
  const host = createFixtureHost();
  const manager = createRuntimeManager({ store, host, resolveProvider: () => replyCapturingProvider(sent) });
  await manager.start();
  await seedCorrelation(store, account, { id: 'cor-1', requestId: 'req-1', hostRef: 'h-1', turnId: 'turn-1' });
  host.emitted({ eventId: 'ev-o', at: 30, type: 'turn.output', sessionId: 's-1', turnId: 'turn-1', text: 'the answer', attachments: [] });
  host.emitted({ eventId: 'ev-c', at: 31, type: 'turn.completed', sessionId: 's-1', turnId: 'turn-1' });
  assert.ok(await waitFor(() => store.snapshot().correlations['cor-1'].state === 'completed'));
  assert.equal(sent.at(-1).text, 'the answer');
  await manager.stop();
});

test('R11 a completed turn with no body sends an explicit notice, never a fake recovery', async () => {
  const { store, account } = await scratch();
  await seedPrincipal(store, account);
  const sent = [];
  const host = createFixtureHost();
  const manager = createRuntimeManager({ store, host, resolveProvider: () => replyCapturingProvider(sent) });
  await manager.start();
  await seedCorrelation(store, account, { id: 'cor-2', requestId: 'req-2', hostRef: 'h-2', turnId: 'turn-2' });
  host.emitted({ eventId: 'ev-c2', at: 31, type: 'turn.completed', sessionId: 's-1', turnId: 'turn-2' });
  assert.ok(await waitFor(() => store.snapshot().correlations['cor-2'].state === 'completed'));
  assert.equal(sent.at(-1).text, '任务已结束，请在DSH查看结果');
  await manager.stop();
});

test('R11 interaction.opened opens a pending interaction and delivers a control card', async () => {
  const { store, account } = await scratch();
  await seedPrincipal(store, account);
  const sent = [];
  const host = createFixtureHost();
  const manager = createRuntimeManager({ store, host, resolveProvider: () => replyCapturingProvider(sent) });
  await manager.start();
  host.emitted({
    eventId: 'ev-i', at: 40, type: 'interaction.opened',
    request: {
      hostRef: 'h-9', sessionId: 's-1', turnId: null, type: 'approval', prompt: '允许执行?',
      choices: [], multiple: false, allowText: false, expiresAt: Date.now() + 60000,
    },
  });
  assert.ok(await waitFor(() => sent.length === 1));
  const state = store.snapshot();
  assert.equal(Object.values(state.interactions)[0].state, 'pending');
  assert.equal(Object.values(state.replyRefs).filter((r) => r.state === 'active').length, 2);
  assert.deepEqual(sent.at(-1).actions.map((a) => a.label), ['批准', '拒绝']);
  await manager.stop();
});

test('R11 a repeated turn.completed settles the correlation exactly once', async () => {
  const { store, account } = await scratch();
  await seedPrincipal(store, account);
  const sent = [];
  const host = createFixtureHost();
  const manager = createRuntimeManager({ store, host, resolveProvider: () => replyCapturingProvider(sent) });
  await manager.start();
  await seedCorrelation(store, account, { id: 'cor-3', requestId: 'req-3', hostRef: 'h-3', turnId: 'turn-3' });
  host.emitted({ eventId: 'ev-c3a', at: 31, type: 'turn.completed', sessionId: 's-1', turnId: 'turn-3' });
  assert.ok(await waitFor(() => store.snapshot().correlations['cor-3'].state === 'completed'));
  const delivered = sent.length;
  host.emitted({ eventId: 'ev-c3b', at: 32, type: 'turn.completed', sessionId: 's-1', turnId: 'turn-3' });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sent.length, delivered, 'a second completion never re-delivers');
  await manager.stop();
});

test('R11 session.closed cancels the session interactions and live correlations', async () => {
  const { store, account } = await scratch();
  await seedPrincipal(store, account);
  const sent = [];
  const host = createFixtureHost();
  const manager = createRuntimeManager({ store, host, resolveProvider: () => replyCapturingProvider(sent) });
  await manager.start();
  await seedCorrelation(store, account, { id: 'cor-4', requestId: 'req-4', hostRef: 'h-4', turnId: 'turn-4' });
  host.emitted({
    eventId: 'ev-i4', at: 40, type: 'interaction.opened',
    request: {
      hostRef: 'h-4', sessionId: 's-1', turnId: 'turn-4', type: 'approval', prompt: 'go?',
      choices: [], multiple: false, allowText: false, expiresAt: Date.now() + 60000,
    },
  });
  assert.ok(await waitFor(() => Object.values(store.snapshot().interactions).some((i) => i.state === 'pending')));
  host.emitted({ eventId: 'ev-sc', at: 50, type: 'session.closed', sessionId: 's-1' });
  assert.ok(await waitFor(() => store.snapshot().correlations['cor-4'].state === 'cancelled'), 'the live correlation is cancelled');
  assert.ok(
    await waitFor(() => Object.values(store.snapshot().interactions).every((i) => i.state !== 'pending' && i.state !== 'claimed')),
    'no pending interaction survives the close',
  );
  await manager.stop();
});
