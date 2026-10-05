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

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-runtime-'));
  const { store } = await openStore(dir);
  const account = await createAccount(store, {
    channelId: 'telegram',
    label: 'TG',
    enabled: true,
    config: { outbound: {}, inbound: {} },
    notificationEnabled: false,
    controlEnabled: false,
  }, { now: 100 });
  return { store, account };
}

/** A provider that records its lifecycle and can emit into the runtime. */
function fakeProvider({ onStart } = {}) {
  const state = { starts: 0, stops: 0, lastEpoch: null, emit: null };
  return {
    id: 'telegram',
    capabilities: { outbound: true, inbound: true, controlReply: true },
    state,
    async start({ epoch, emit, cursorStore }) {
      state.starts += 1;
      state.lastEpoch = epoch;
      state.emit = emit;
      state.cursorStore = cursorStore;
      onStart?.({ emit, epoch, cursorStore });
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