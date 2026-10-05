import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, Store, STATE_FILE } from '../../src/storage/store.mjs';
import { acquireLock, releaseLock, unlock, readLock, canUnlock } from '../../src/storage/lock.mjs';
import { DomainError } from '../../src/domain/errors.mjs';

async function tmp() {
  return mkdtemp(join(tmpdir(), 'dsh-store-'));
}

test('S01: fresh directory opens ready with an empty store', async () => {
  const dir = await tmp();
  const opened = await openStore(dir);
  assert.equal(opened.status, 'ready');
  assert.equal(opened.store.revision, 0);
  assert.deepEqual(opened.store.snapshot().accounts, {});
});

test('S02: transact commits atomically and increments the global revision', async () => {
  const dir = await tmp();
  const { store } = await openStore(dir);
  const before = store.snapshot();
  const result = await store.transact(0, (draft) => {
    draft.settings.quiet = true;
    return 'ok';
  });
  assert.deepEqual(result, { revision: 1, value: 'ok' });
  assert.equal(store.revision, 1);
  assert.equal(before.settings.quiet, false, 'snapshot must not alias the draft');
  assert.equal(store.snapshot().settings.quiet, true);

  const file = JSON.parse(await readFile(join(dir, STATE_FILE), 'utf8'));
  assert.equal(file.revision, 1);
  assert.equal(file.settings.quiet, true);
});

test('S02b: a throwing or invalid mutator never publishes', async () => {
  const dir = await tmp();
  const { store } = await openStore(dir);
  await assert.rejects(
    store.transact(0, () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(store.revision, 0);
  await assert.rejects(
    store.transact(0, (draft) => {
      draft.schemaVersion = 2;
    }),
    (e) => e instanceof DomainError && e.code === 'VALIDATION',
  );
  assert.equal(store.revision, 0);
});

test('S02c: transactions run FIFO and never lose writes', async () => {
  const dir = await tmp();
  const { store } = await openStore(dir);
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      store.transact(null, (draft) => {
        draft.activity.push({
          id: `a${i}`, time: Date.now(), kind: 'send', accountId: null,
          sessionId: null, status: 'ok', code: null,
        });
      }),
    ),
  );
  assert.equal(store.revision, 20);
  assert.equal(store.snapshot().activity.length, 20);
});

test('S03: state is reloaded from disk', async () => {
  const dir = await tmp();
  const first = await openStore(dir);
  await first.store.transact(0, (draft) => {
    draft.settings.activityRetentionDays = 14;
  });
  await first.store.close();

  const second = await openStore(dir);
  assert.equal(second.status, 'ready');
  assert.equal(second.store.revision, 1);
  assert.equal(second.store.snapshot().settings.activityRetentionDays, 14);
});

test('S04: stale expected revision is a CONFLICT and does not commit', async () => {
  const dir = await tmp();
  const { store } = await openStore(dir);
  await store.transact(0, (draft) => {
    draft.settings.quiet = true;
  });
  await assert.rejects(
    store.transact(0, (draft) => {
      draft.settings.quiet = false;
    }),
    (e) => e instanceof DomainError && e.code === 'CONFLICT',
  );
  assert.equal(store.snapshot().settings.quiet, true);
});

test('S04b: a corrupt state.json opens degraded and is preserved', async () => {
  const dir = await tmp();
  await writeFile(join(dir, STATE_FILE), '{ not json');
  const opened = await openStore(dir);
  assert.equal(opened.status, 'degraded');
  assert.equal(opened.store, null);
  assert.equal(await readFile(join(dir, STATE_FILE), 'utf8'), '{ not json');
});

test('S04c: unsupported schemaVersion opens degraded', async () => {
  const dir = await tmp();
  await writeFile(join(dir, STATE_FILE), JSON.stringify({ schemaVersion: 99 }));
  const opened = await openStore(dir);
  assert.equal(opened.status, 'degraded');
});

test('lock: exclusive acquisition, ownership and release', async () => {
  const dir = await tmp();
  const first = await acquireLock(dir);
  assert.equal(first.ok, true);

  const second = await acquireLock(dir);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'EXISTS');

  const wrong = await releaseLock(dir, 'not-the-owner');
  assert.deepEqual(wrong, { ok: false, reason: 'NOT_OWNER' });
  assert.ok(await readLock(dir));

  assert.deepEqual(await releaseLock(dir, first.nonce), { ok: true });
  assert.equal(await readLock(dir), null);
});

test('lock: unlock refuses a live pid and a foreign host', async () => {
  const dir = await tmp();
  const held = await acquireLock(dir);
  assert.equal(canUnlock(held.lock, { host: 'other-host' }).reason, 'OTHER_HOST');
  assert.equal(canUnlock(held.lock, { alive: () => true }).reason, 'ALIVE');
  assert.equal((await unlock(dir, { host: 'other-host' })).reason, 'OTHER_HOST');
  assert.ok(await readLock(dir), 'lock must survive a refused unlock');
  assert.deepEqual(await unlock(dir, { alive: () => false }), {
    ok: true,
    released: held.lock,
  });
});

test('store files are written with 0600 permissions', async () => {
  const dir = await tmp();
  const saved = process.umask();
  process.umask(0);
  try {
    const { store } = await openStore(dir);
    await store.transact(0, (draft) => {
      draft.settings.quiet = true;
    });
    const mode = (await stat(join(dir, STATE_FILE))).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    process.umask(saved);
  }
});

test('Store.open rejects a directory containing a prototype-key state', async () => {
  const dir = await tmp();
  await writeFile(join(dir, STATE_FILE), '{"schemaVersion":1,"revision":0,"__proto__":{"x":1}}');
  await assert.rejects(Store.open(dir));
});