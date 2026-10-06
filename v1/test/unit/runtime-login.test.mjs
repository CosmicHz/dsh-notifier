// B03: read projection / surface version (W05/W28) and the login manager
// (W17/W18). Projection never writes state.json; a login result only commits
// through the Account service and only while the account revision is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/storage/store.mjs';
import { createAccount } from '../../src/services/accounts.mjs';
import { createProjection } from '../../src/runtime/projection.mjs';
import { createLoginManager } from '../../src/runtime/login-manager.mjs';

// --- projection (W05/W28) --------------------------------------------------

test('W05 surfaceVersion carries bootId+sequence and invalidate advances it', () => {
  const projection = createProjection({ bootId: 'boot-1', now: () => 0 });
  assert.deepEqual(projection.surfaceVersion(), { bootId: 'boot-1', sequence: 0 });
  assert.equal(projection.invalidate('health').sequence, 1);
  assert.equal(projection.surfaceVersion().sequence, 1);
});

test('W05 wait wakes on a later invalidation without a lost wakeup', async () => {
  const projection = createProjection({ bootId: 'boot-1', now: () => 0 });
  const pending = projection.wait({ afterVersion: { bootId: 'boot-1', sequence: 0 }, timeoutMs: 1000 });
  projection.invalidate('store');
  const result = await pending;
  assert.equal(result.changed, true);
  assert.equal(result.surfaceVersion.sequence, 1);
});

test('W05 wait returns immediately when the boot id differs', async () => {
  const projection = createProjection({ bootId: 'boot-2', now: () => 0 });
  const result = await projection.wait({ afterVersion: { bootId: 'boot-1', sequence: 9 }, timeoutMs: 1000 });
  assert.equal(result.changed, true);
  assert.equal(result.surfaceVersion.bootId, 'boot-2');
});

test('W05 wait times out with changed=false and honours an abort signal', async () => {
  const projection = createProjection({ bootId: 'boot-1', now: () => 0 });
  const timedOut = await projection.wait({ afterVersion: { bootId: 'boot-1', sequence: 0 }, timeoutMs: 5 });
  assert.equal(timedOut.changed, false);

  const controller = new AbortController();
  const pending = projection.wait({ afterVersion: { bootId: 'boot-1', sequence: 0 }, timeoutMs: 1000, signal: controller.signal });
  controller.abort();
  assert.equal((await pending).changed, false);
});

test('W05 a health change bumps the surface version without touching the store', () => {
  const projection = createProjection({ bootId: 'boot-1', now: () => 42 });
  const before = projection.surfaceVersion().sequence;
  const health = projection.setHealth({ status: 'degraded', code: 'HOST_CAPABILITY_MISSING' });
  assert.equal(projection.surfaceVersion().sequence, before + 1);
  assert.equal(health.status, 'degraded');
  assert.equal(projection.getHealth().updatedAt, 42);
});

// --- login manager (W17/W18) ----------------------------------------------

async function draftStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-login-'));
  const { store } = await openStore(dir);
  const account = await createAccount(store, {
    channelId: 'telegram',
    label: 'TG draft',
    enabled: false,
    config: { outbound: {}, inbound: {} },
    notificationEnabled: false,
    controlEnabled: false,
  }, { now: 100 });
  return { store, account };
}

function fakeDriver({ begin } = {}) {
  let resolveDone;
  let rejectDone;
  const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });
  return {
    capabilities: { login: true },
    async begin(args) {
      if (begin) return begin(args, { done });
      // A generous window: these managers use a fixed now() of 150, so a short
      // expiresAt would race the (fsync-bound) commit under full-suite load.
      args.onQrCode?.({ text: 'qr-text', expiresAt: 60150 });
      return { done, qrText: 'qr-text', expiresAt: 60150 };
    },
    resolveDone,
    rejectDone,
  };
}

async function until(fn, tries = 5000) {
  // Counter-based (no Date.now): a neighbouring case must not be able to skew the
  // wait through a mocked clock. Up to ~5s of 1ms macrotasks.
  for (let i = 0; i < tries; i++) {
    try { const value = fn(); if (value) return value; } catch { /* keep waiting */ }
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error('condition not met');
}

const LOGIN_SECRETS = [{ path: 'inbound.botToken', op: 'set', value: { kind: 'literal', value: '"tok-1"' } }];

test('W18 a successful login commits credentials and enables control in one transaction', async () => {
  const { store, account } = await draftStore();
  const manager = createLoginManager({ store, now: () => 150 });
  const driver = fakeDriver();
  const started = await manager.start({ accountId: account.id }, { driver });
  assert.equal(started.status, 'pending');
  assert.equal(started.qrText, 'qr-text');

  driver.resolveDone({ secretChanges: LOGIN_SECRETS });
  const view = await until(() => { const v = manager.status({ loginId: started.loginId }); return v.status === 'succeeded' ? v : null; });
  assert.deepEqual(view, { status: 'succeeded', accountId: account.id });

  const saved = store.snapshot().accounts[account.id];
  assert.equal(saved.enabled, true);
  assert.equal(saved.controlEnabled, true);
  assert.equal(saved.secrets['inbound.botToken'].kind, 'literal');
});

test('W18 one session per account: a new scan cancels the old and its late result is ignored', async () => {
  const { store, account } = await draftStore();
  const manager = createLoginManager({ store, now: () => 150 });
  const first = fakeDriver();
  const started = await manager.start({ accountId: account.id }, { driver: first });
  const second = fakeDriver();
  await manager.start({ accountId: account.id }, { driver: second });
  assert.equal(manager.status({ loginId: started.loginId }).status, 'cancelled');

  first.resolveDone({ secretChanges: LOGIN_SECRETS });
  await new Promise((r) => setImmediate(r));
  assert.equal(store.snapshot().accounts[account.id].secrets['inbound.botToken'], undefined, 'stale result never commits');
});

test('W18 cancel aborts a login and a late success does not commit', async () => {
  const { store, account } = await draftStore();
  const manager = createLoginManager({ store, now: () => 150 });
  const driver = fakeDriver();
  const started = await manager.start({ accountId: account.id }, { driver });
  assert.deepEqual(manager.cancel({ loginId: started.loginId }), { status: 'cancelled' });
  driver.resolveDone({ secretChanges: LOGIN_SECRETS });
  await new Promise((r) => setImmediate(r));
  assert.equal(store.snapshot().accounts[account.id].secrets['inbound.botToken'], undefined);
});

test('W18 a loginId from a previous boot reports EXPIRED', async () => {
  const { store, account } = await draftStore();
  const manager = createLoginManager({ store });
  await manager.start({ accountId: account.id }, { driver: fakeDriver() });
  const fresh = createLoginManager({ store });
  assert.throws(
    () => fresh.status({ loginId: 'old-login-id' }),
    (e) => e.code === 'EXPIRED' && e.details.code === 'LOGIN_EXPIRED',
  );
});

test('W17 a late result never overwrites a newer account edit', async () => {
  const { store, account } = await draftStore();
  const manager = createLoginManager({ store, now: () => 150 });
  const driver = fakeDriver();
  const started = await manager.start({ accountId: account.id }, { driver });

  // The user edits the draft (revision 0 -> 1) while the scan is still pending.
  const { updateAccount } = await import('../../src/services/accounts.mjs');
  await updateAccount(store, { id: account.id, expectedRevision: 0, patch: { label: 'renamed' } }, { now: 140 });

  driver.resolveDone({ secretChanges: LOGIN_SECRETS });
  const view = await until(() => { const v = manager.status({ loginId: started.loginId }); return v.status === 'failed' ? v : null; });
  assert.equal(view.errorCode, 'LOGIN_STALE');
  assert.equal(store.snapshot().accounts[account.id].secrets['inbound.botToken'], undefined);
});

test('W18 an expired deadline marks the login expired', async () => {
  const { store, account } = await draftStore();
  let clock = 100;
  const manager = createLoginManager({ store, now: () => clock, maxMs: 1000 });
  const driver = fakeDriver({ begin: (args, { done }) => { args.onQrCode?.({ text: 'q', expiresAt: 1100 }); return { done, qrText: 'q', expiresAt: 1100 }; } });
  const started = await manager.start({ accountId: account.id }, { driver });
  clock = 5000;
  assert.equal(manager.status({ loginId: started.loginId }).status, 'expired');
  driver.resolveDone({ secretChanges: LOGIN_SECRETS });
  await new Promise((r) => setImmediate(r));
  assert.equal(store.snapshot().accounts[account.id].secrets['inbound.botToken'], undefined);
});

test('a channel without login capability is UNSUPPORTED', async () => {
  const { store, account } = await draftStore();
  const manager = createLoginManager({ store });
  await assert.rejects(
    manager.start({ accountId: account.id }, { driver: { capabilities: { login: false } } }),
    (e) => e.code === 'UNSUPPORTED',
  );
});