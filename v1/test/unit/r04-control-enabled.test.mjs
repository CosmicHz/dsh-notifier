// R04: controlEnabled=false should not start control transport and reject control events
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/storage/store.mjs';
import { createAccount } from '../../src/services/accounts.mjs';
import { createRuntimeManager } from '../../src/runtime/manager.mjs';
import { randomUUID } from 'node:crypto';

function fakeProvider() {
  const state = { starts: 0, stops: 0, accounts: new Set() };
  return {
    id: 'telegram',
    capabilities: { outbound: true, inbound: true },
    state,
    async start({ account, epoch, emit }) {
      state.starts += 1;
      state.accounts.add(account.id);
      return { async stop() { state.stops += 1; } };
    },
  };
}

test('R04: controlEnabled=false should NOT start inbound transport', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'r04-'));
  const { store } = await openStore(dir);

  const account = await createAccount(store, {
    channelId: 'telegram',
    label: 'Control Disabled',
    enabled: true,
    notificationEnabled: false,  // ← disable to avoid needing credentials
    controlEnabled: false,  // ← disabled
    config: { outbound: {}, inbound: {} },
  }, { now: 100 });

  const provider = fakeProvider();
  const manager = createRuntimeManager({
    store,
    resolveProvider: () => provider,
    handleInbound: async () => ({ kind: 'converse' }),
  });

  await manager.start();

  // R04: Should NOT have started the transport
  assert.equal(provider.state.starts, 0, 'Should not start when controlEnabled=false');
  assert.ok(!provider.state.accounts.has(account.id));

  const connections = manager.connections();
  // Connection record exists but in 'stopped' state
  const conn = connections.find(c => c.accountId === account.id);
  assert.ok(conn, 'Should have connection record');
  assert.equal(conn.state, 'stopped', 'Connection should be stopped');
});

test('R04: controlEnabled=false should reject inbound events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'r04-'));
  const { store } = await openStore(dir);

  const account = await createAccount(store, {
    channelId: 'telegram',
    label: 'Control Disabled',
    enabled: true,
    notificationEnabled: false,  // ← disable to avoid needing credentials
    controlEnabled: false,
    config: { outbound: {}, inbound: {} },
  }, { now: 100 });

  const provider = fakeProvider();
  const manager = createRuntimeManager({
    store,
    resolveProvider: () => provider,
    handleInbound: async () => ({ kind: 'converse' }),
  });

  await manager.start();

  // Supply the connection's own (freshly minted) epoch so ingest reaches the
  // controlEnabled gate rather than short-circuiting on STALE_EPOCH (D04).
  const epoch = manager.connectionView(account.id).epoch;

  // Try to ingest an event
  const result = await manager.ingest({
    accountId: account.id,
    eventId: randomUUID(),
    epoch,
    userId: 'u-test',
    chatId: 'c-test',
    kind: 'message',
    text: '/status',
  });

  // Should reject because controlEnabled=false
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'FORBIDDEN', 'Should reject with FORBIDDEN when controlEnabled=false');
});

test('R04: stale epoch is rejected before the controlEnabled gate (D04 precedence)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'r04-'));
  const { store } = await openStore(dir);

  const account = await createAccount(store, {
    channelId: 'telegram',
    label: 'Control Disabled',
    enabled: true,
    notificationEnabled: false,
    controlEnabled: false,
    config: { outbound: {}, inbound: {} },
  }, { now: 100 });

  const provider = fakeProvider();
  const manager = createRuntimeManager({
    store,
    resolveProvider: () => provider,
    handleInbound: async () => ({ kind: 'converse' }),
  });

  await manager.start();

  const result = await manager.ingest({
    accountId: account.id,
    eventId: randomUUID(),
    epoch: 'superseded-epoch',
    userId: 'u-test',
    chatId: 'c-test',
    kind: 'message',
    text: '/status',
  });

  assert.equal(result.accepted, false);
  assert.equal(result.code, 'STALE_EPOCH', 'STALE_EPOCH must win over FORBIDDEN');
});
