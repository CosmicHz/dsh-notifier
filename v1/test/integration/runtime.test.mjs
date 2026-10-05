// T15 runtime acceptance (D04/D05; 18-WIRING.md). Real Store on a temp dir, a
// fake inbound provider and the in-memory Host fixture. Covers:
//   D04 — a superseded epoch event is rejected before any durable write
//   D05 — a restart reconciles: planned->cancelled, started->uncertain,
//         reserved correlation->cancelled, active correlation->uncertain
//   lifecycle — start/stop/dispose idempotent, no start after stop, bounded
//         event buffer reports degraded (never drops and pretends to continue)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/storage/store.mjs';
import { createAccount } from '../../src/services/accounts.mjs';
import { createProjection } from '../../src/runtime/projection.mjs';
import { createRuntimeManager } from '../../src/runtime/manager.mjs';
import { createFixtureHost } from '../fixtures/host.mjs';
import { createEffect, markEffectStarted } from '../../src/services/effects.mjs';
import { upsertReplyContext } from '../../src/services/reply-contexts.mjs';
import { reserveCorrelation, bindCorrelationTurn } from '../../src/services/correlations.mjs';
import { issuePairing } from '../../src/services/pairing.mjs';
import { openInteraction } from '../../src/services/interactions.mjs';
import { issueReplyRef } from '../../src/services/reply-refs.mjs';

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-runtime-'));
  const { store } = await openStore(dir);
  const account = await createAccount(store, {
    channelId: 'telegram',
    label: 'TG',
    enabled: true,
    config: { outbound: {}, inbound: {} },
    notificationEnabled: false,
    controlEnabled: true,  // ← R04: tests need ingest to work
    secretChanges: [{ op: 'set', path: 'inbound.botToken', value: { kind: 'literal', value: '"fake-token"' } }],
  }, { now: 100 });
  return { store, account };
}

/** A provider that records its lifecycle and can emit into the runtime. */
function fakeProvider({ onStart } = {}) {
  const state = { starts: 0, stops: 0, lastEpoch: null, emit: null, onFatal: null };
  return {
    id: 'telegram',
    capabilities: { outbound: true, inbound: true, controlReply: true },
    state,
    async start({ epoch, emit, cursorStore, onFatal }) {
      state.starts += 1;
      state.lastEpoch = epoch;
      state.emit = emit;
      state.cursorStore = cursorStore;
      state.onFatal = onFatal ?? null;
      onStart?.({ emit, epoch, cursorStore, onFatal });
      return { async stop() { state.stops += 1; } };
    },
  };
}

test('D04 a stale-epoch inbound is rejected before any durable inbox write', async () => {
  const { store, account } = await scratch();
  const provider = fakeProvider();
  const manager = createRuntimeManager({
    store,
    host: createFixtureHost(),
    resolveProvider: () => provider,
    handleInbound: async () => ({ kind: 'converse' }),
    now: () => 200,
  });
  await manager.start();
  const firstEpoch = manager.connections().find((c) => c.accountId === account.id).epoch;

  // Reconnect mints a fresh epoch; the old one is superseded.
  await manager.restartAccount(account.id);
  const secondEpoch = manager.connections().find((c) => c.accountId === account.id).epoch;
  assert.notEqual(firstEpoch, secondEpoch);

  const rejected = await manager.ingest({
    accountId: account.id, eventId: 'e-old', epoch: firstEpoch,
    userId: 'u1', chatId: 'c1', kind: 'message', text: 'hi',
  });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.code, 'STALE_EPOCH');
  assert.equal(Object.keys(store.snapshot().inbox).length, 0, 'no durable write for a stale event');

  const accepted = await manager.ingest({
    accountId: account.id, eventId: 'e-new', epoch: secondEpoch,
    userId: 'u1', chatId: 'c1', kind: 'message', text: 'hi',
  });
  assert.equal(accepted.accepted, true);
  assert.equal(Object.values(store.snapshot().inbox)[0].status, 'done');
  await manager.stop();
});

test('D04 a duplicate event is replayed, never handled twice', async () => {
  const { store, account } = await scratch();
  let handled = 0;
  const provider = fakeProvider();
  const manager = createRuntimeManager({
    store,
    host: createFixtureHost(),
    resolveProvider: () => provider,
    handleInbound: async () => { handled += 1; return { kind: 'converse' }; },
    now: () => 200,
  });
  await manager.start();
  const epoch = manager.connections().find((c) => c.accountId === account.id).epoch;
  const envelope = { accountId: account.id, eventId: 'dup-1', epoch, userId: 'u1', chatId: 'c1', kind: 'message', text: 'hi' };
  await manager.ingest(envelope);
  const again = await manager.ingest(envelope);
  assert.equal(again.replayed, true);
  assert.equal(handled, 1);
  await manager.stop();
});

test('D05 a restart reconciles effects and correlations without replaying', async () => {
  const { store, account } = await scratch();
  // Seed evidence from a previous boot using the real services.
  await store.transact(null, (draft) => {
    upsertReplyContext(draft, { accountId: account.id, userId: 'u1', chatId: 'c1', id: 'rc-1' }, { now: 10 });
    draft.principals['p-1'] = {
      id: 'p-1', revision: 0, accountId: account.id, userId: 'u1', role: 'owner', canConverse: true,
      sessionIds: ['s-1'], enabled: true, replyContextId: 'rc-1', createdAt: 10, updatedAt: 10,
    };
    const planned = createEffect(draft, { kind: 'notify', accountId: account.id, requestKey: 'rk-planned' }, { now: 10, newId: () => 'eff-planned' });
    const started = createEffect(draft, { kind: 'notify', accountId: account.id, requestKey: 'rk-started' }, { now: 10, newId: () => 'eff-started' });
    markEffectStarted(draft, started.id, { now: 10 });
    assert.equal(planned.status, 'planned');
    const reserved = reserveCorrelation(draft, {
      accountId: account.id, principalId: 'p-1', replyContextId: 'rc-1', sessionId: 's-1', requestId: 'req-a',
    }, { now: 10, newId: () => 'cor-reserved' });
    const active = reserveCorrelation(draft, {
      accountId: account.id, principalId: 'p-1', replyContextId: 'rc-1', sessionId: 's-1', requestId: 'req-b',
    }, { now: 10, newId: () => 'cor-active' });
    bindCorrelationTurn(draft, active.correlation.id, { hostRef: 'h-1', turnId: 't-1', now: 10 });
    assert.equal(reserved.correlation.state, 'reserved');
    return null;
  });

  const provider = fakeProvider();
  const manager = createRuntimeManager({
    store, host: createFixtureHost(), resolveProvider: () => provider, handleInbound: async () => ({}), now: () => 500,
  });
  await manager.start();
  const state = store.snapshot();
  assert.equal(state.effects['eff-planned'].status, 'cancelled');
  assert.equal(state.effects['eff-started'].status, 'uncertain', 'a started leaf cannot be proven');
  assert.equal(state.correlations['cor-reserved'].state, 'cancelled');
  assert.equal(state.correlations['cor-active'].state, 'uncertain');
  await manager.stop();
});

test('lifecycle: start/stop/dispose are idempotent and stop is terminal', async () => {
  const { store, account } = await scratch();
  const provider = fakeProvider();
  const projection = createProjection({ bootId: 'boot-t15', now: () => 0 });
  const manager = createRuntimeManager({ store, host: createFixtureHost(), projection, resolveProvider: () => provider });

  await manager.start();
  assert.equal(manager.state, 'running');
  const epoch = manager.connections().find((c) => c.accountId === account.id).epoch;

  await manager.stop();
  assert.equal(manager.state, 'stopped');
  assert.equal(provider.state.stops, 1);
  await manager.stop();
  assert.equal(provider.state.stops, 1, 'stop is idempotent');

  await assert.rejects(() => manager.start(), (e) => e.code === 'CANCELLED');
  assert.ok(projection.surfaceVersion().sequence > 0);
  await manager.dispose();
  assert.equal(manager.state, 'stopped');
});

test('the bounded event buffer refuses on overflow and reports degraded', async () => {
  const { store } = await scratch();
  const host = createFixtureHost();
  // Flood 5 events while the buffer is not yet dispatched (start reconciles first).
  const floodingHost = {
    ...host,
    subscribe(handler) {
      const dispose = host.subscribe(handler);
      queueMicrotask(() => {
        for (let i = 0; i < 5; i += 1) {
          host.emitted({ eventId: `ev-${i}`, at: i, type: 'capabilities.changed', capabilities: {} });
        }
      });
      return dispose;
    },
  };
  const manager = createRuntimeManager({
    store,
    host: floodingHost,
    resolveProvider: () => null,
    eventBufferCapacity: 2,
  });
  await manager.start();
  assert.equal(manager.eventBus.overflowed, true);
  assert.ok(manager.eventBus.dropped >= 1, 'overflowed events are dropped, not silently queued');
  await manager.stop();
});
test('R06 a background fatal exit from the provider degrades the connection (no fake ready)', async () => {
  const { store, account } = await scratch();
  const provider = fakeProvider();
  const manager = createRuntimeManager({ store, resolveProvider: () => provider });
  await manager.start();
  // The manager must pass onFatal into provider.start so a later async exit can degrade.
  assert.equal(typeof provider.state.onFatal, 'function', 'manager must wire onFatal');
  assert.equal(manager.connectionView(account.id).state, 'ready');

  provider.state.onFatal({ code: 'FORBIDDEN', message: 'auth failed' });

  const view = manager.connectionView(account.id);
  assert.equal(view.state, 'degraded', 'background fatal exit must degrade');
  assert.equal(view.errorCode, 'FORBIDDEN');
  assert.equal(manager.health.status, 'degraded');
  await manager.stop();
});

test('R06 a fatal exit from a superseded epoch does not degrade the replacement', async () => {
  const { store, account } = await scratch();
  const provider = fakeProvider();
  const manager = createRuntimeManager({ store, resolveProvider: () => provider });
  await manager.start();
  const staleOnFatal = provider.state.onFatal;
  // Restart mints a new epoch and swaps in a fresh loop; the old loop dying must not win.
  const restarted = await manager.restartAccount(account.id);
  assert.notEqual(restarted.epoch, null);
  staleOnFatal({ code: 'FORBIDDEN', message: 'stale' });
  assert.equal(manager.connectionView(account.id).state, 'ready', 'stale onFatal is ignored');
  await manager.stop();
});

test('R10 /pair and /unpair work through the real manager, conversation and pairing wiring', async () => {
  const { store, account } = await scratch();
  const sent = [];
  const provider = {
    id: 'telegram',
    capabilities: { outbound: true, inbound: true, controlReply: true },
    async start() { return { async stop() {} }; },
    async sendControlReply({ content }) {
      sent.push(content.text);
      return { status: 'accepted', providerMessageId: `pm-${sent.length}` };
    },
  };
  const manager = createRuntimeManager({
    store, host: createFixtureHost(), resolveProvider: () => provider,
  });
  await manager.start();
  const epoch = manager.connectionView(account.id).epoch;

  // Pairing TTL is wall-clock in the ingest path, so issue at real time.
  await issuePairing(store, { accountId: account.id, code: 'ABCD2345' });
  const paired = await manager.ingest({
    accountId: account.id, eventId: 'e-pair', epoch, userId: 'u-1', chatId: 'c-1',
    kind: 'message', text: '/pair ABCD2345',
  });
  assert.equal(paired.outcome.name, 'pair');
  assert.equal(paired.outcome.paired, true);
  assert.equal(sent.at(-1), 'paired as owner');
  const principals = Object.values(store.snapshot().principals);
  assert.equal(principals.length, 1);
  const principal = principals[0];
  assert.equal(principal.role, 'owner');

  // Seed a binding and an outstanding reply ref that /unpair must clean up.
  await store.transact(null, (draft) => {
    draft.bindings[principal.id] = { principalId: principal.id, sessionId: 's-1', updatedAt: 900 };
    const interaction = openInteraction(draft, {
      type: 'approval', sessionId: 's-1', hostRef: 'h-1', prompt: 'approve?',
    }, { now: 900, newId: () => 'int-1' });
    issueReplyRef(draft, {
      accountId: account.id, principalId: principal.id, replyContextId: principal.replyContextId,
      interactionId: interaction.id, action: 'approve', expiresAt: 5000, token: 'tok-1', id: 'ref-1',
    }, { now: 900 });
    return null;
  });
  assert.equal(store.snapshot().replyRefs['ref-1'].state, 'active');

  const unpaired = await manager.ingest({
    accountId: account.id, eventId: 'e-unpair', epoch, userId: 'u-1', chatId: 'c-1',
    kind: 'message', text: '/unpair',
  });
  assert.equal(unpaired.outcome.name, 'unpair');
  const after = store.snapshot();
  assert.equal(Object.keys(after.principals).length, 0, 'only the caller principal is removed');
  assert.equal(after.bindings[principal.id], undefined, 'the binding is dropped');
  assert.equal(after.replyRefs['ref-1'].state, 'revoked', 'outstanding refs are revoked');

  const plain = await manager.ingest({
    accountId: account.id, eventId: 'e-plain', epoch, userId: 'u-1', chatId: 'c-1',
    kind: 'message', text: 'hello',
  });
  assert.equal(plain.outcome.code, 'NOT_PAIRED');
  await manager.stop();
});

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

async function seedPrincipal(store, account, { id = 'p-1', userId = 'u-1', chatId = 'c-1', rcId = 'rc-1', role = 'owner' } = {}) {
  await store.transact(null, (draft) => {
    upsertReplyContext(draft, { accountId: account.id, userId, chatId, id: rcId }, { now: 10 });
    draft.principals[id] = {
      id, revision: 0, accountId: account.id, userId, role, canConverse: true,
      sessionIds: ['s-1'], enabled: true, replyContextId: rcId, createdAt: 10, updatedAt: 10,
    };
    return null;
  });
}

function replyCapturingProvider(sent) {
  return {
    id: 'telegram',
    capabilities: { outbound: true, inbound: true, controlReply: true },
    async sendControlReply({ content }) {
      sent.push(content);
      return { status: 'accepted', providerMessageId: `pm-${sent.length}` };
    },
  };
}

test('R11 turn.output/turn.completed delivers the answer back to the original chat', async () => {
  const { store, account } = await scratch();
  await seedPrincipal(store, account);
  const sent = [];
  const host = createFixtureHost();
  const manager = createRuntimeManager({ store, host, resolveProvider: () => replyCapturingProvider(sent) });
  await manager.start();
  await store.transact(null, (draft) => {
    const { correlation } = reserveCorrelation(draft, {
      accountId: account.id, principalId: 'p-1', replyContextId: 'rc-1', sessionId: 's-1', requestId: 'req-1',
    }, { now: 20, newId: () => 'cor-1' });
    bindCorrelationTurn(draft, correlation.id, { hostRef: 'h-1', turnId: 'turn-1', now: 21 });
    return null;
  });

  host.emitted({ eventId: 'ev-o', at: 30, type: 'turn.output', sessionId: 's-1', turnId: 'turn-1', text: 'the answer', attachments: [] });
  host.emitted({ eventId: 'ev-c', at: 31, type: 'turn.completed', sessionId: 's-1', turnId: 'turn-1' });
  assert.ok(await waitFor(() => store.snapshot().correlations['cor-1'].state === 'completed'), 'correlation completes');

  assert.equal(sent.at(-1).text, 'the answer');
  assert.equal(store.snapshot().correlations['cor-1'].state, 'completed');
  await manager.stop();
});

test('R11 a completed turn with no cached body sends an explicit notice, never a fake recovery', async () => {
  const { store, account } = await scratch();
  await seedPrincipal(store, account);
  const sent = [];
  const host = createFixtureHost();
  const manager = createRuntimeManager({ store, host, resolveProvider: () => replyCapturingProvider(sent) });
  await manager.start();
  await store.transact(null, (draft) => {
    const { correlation } = reserveCorrelation(draft, {
      accountId: account.id, principalId: 'p-1', replyContextId: 'rc-1', sessionId: 's-1', requestId: 'req-2',
    }, { now: 20, newId: () => 'cor-2' });
    bindCorrelationTurn(draft, correlation.id, { hostRef: 'h-2', turnId: 'turn-2', now: 21 });
    return null;
  });

  host.emitted({ eventId: 'ev-c2', at: 31, type: 'turn.completed', sessionId: 's-1', turnId: 'turn-2' });
  assert.ok(await waitFor(() => store.snapshot().correlations['cor-2'].state === 'completed'), 'correlation completes');

  assert.equal(sent.at(-1).text, '任务已结束，请在DSH查看结果');
  assert.equal(store.snapshot().correlations['cor-2'].state, 'completed');
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
  assert.ok(await waitFor(() => sent.length === 1), 'control card is delivered');

  const state = store.snapshot();
  const interactions = Object.values(state.interactions);
  assert.equal(interactions.length, 1);
  assert.equal(interactions[0].state, 'pending');
  const activeRefs = Object.values(state.replyRefs).filter((ref) => ref.state === 'active');
  assert.equal(activeRefs.length, 2, 'one approve and one reject ref');
  const card = sent.at(-1);
  assert.equal(card.text, '允许执行?');
  assert.deepEqual(card.actions.map((a) => a.label), ['批准', '拒绝']);
  assert.ok(card.actions.every((a) => typeof a.token === 'string' && a.token !== ''));
  await manager.stop();
});
