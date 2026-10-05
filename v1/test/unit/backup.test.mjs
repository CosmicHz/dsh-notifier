import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, STATE_FILE } from '../../src/storage/store.mjs';
import {
  createBackup, listBackups, restoreBackup, quarantineCorrupt, pruneBackups,
} from '../../src/storage/backup.mjs';
import { DomainError } from '../../src/domain/errors.mjs';

async function tmp() {
  return mkdtemp(join(tmpdir(), 'dsh-backup-'));
}

test('S05: backup captures a committed snapshot and restores it', async () => {
  const dir = await tmp();
  const { store } = await openStore(dir);
  await store.transact(0, (draft) => {
    draft.settings.activityRetentionDays = 21;
  });
  const backup = await createBackup(dir, store);
  assert.equal(backup.revision, 1);

  // Change state after the backup.
  await store.transact(1, (draft) => {
    draft.settings.activityRetentionDays = 3;
  });
  await store.close();

  const restored = await restoreBackup(dir, backup.path);
  assert.equal(restored.revision, 1);
  assert.ok(restored.preserved, 'previous state must be preserved');

  const reopened = await openStore(dir);
  assert.equal(reopened.status, 'ready');
  assert.equal(reopened.store.snapshot().settings.activityRetentionDays, 21);
});

test('a corrupt backup is refused and the current state is left intact', async () => {
  const dir = await tmp();
  const { store } = await openStore(dir);
  await store.transact(0, (draft) => {
    draft.settings.quiet = true;
  });
  await store.close();

  const bad = join(dir, 'broken.json');
  await writeFile(bad, '{"schemaVersion":1,"revision":0,"settings":{"activityRetentionDays":999}}');
  await assert.rejects(restoreBackup(dir, bad), (e) => e instanceof DomainError && e.code === 'VALIDATION');

  const still = await openStore(dir);
  assert.equal(still.store.snapshot().settings.quiet, true, 'current state untouched');
  assert.equal((await readdir(dir)).some((n) => n.includes('pre-restore')), false);
});

test('non-JSON backup is refused', async () => {
  const dir = await tmp();
  const bad = join(dir, 'nope.json');
  await writeFile(bad, 'not json');
  await assert.rejects(restoreBackup(dir, bad), (e) => e instanceof DomainError && e.code === 'VALIDATION');
});

test('corrupt original is preserved as .invalid and never used as a backup', async () => {
  const dir = await tmp();
  await writeFile(join(dir, STATE_FILE), '{ broken');
  const quarantined = await quarantineCorrupt(dir);
  assert.ok(quarantined);
  assert.equal(await readFile(quarantined.path, 'utf8'), '{ broken');
  assert.equal(await readFile(join(dir, STATE_FILE), 'utf8'), '{ broken', 'original preserved verbatim');
  // The quarantined copy must not be offered as a valid backup.
  assert.deepEqual(await listBackups(dir), []);
});

test('quarantine is a no-op when there is no state file', async () => {
  const dir = await tmp();
  assert.equal(await quarantineCorrupt(dir), null);
});

test('backups are pruned to MAX_BACKUPS, newest kept', async () => {
  const dir = await tmp();
  const { store } = await openStore(dir);
  for (let i = 0; i < 14; i++) {
    await store.transact(null, (draft) => {
      draft.settings.quiet = i % 2 === 0;
    });
    await createBackup(dir, store, { now: 1_700_000_000_000 + i * 1000 });
  }
  const kept = await listBackups(dir);
  assert.equal(kept.length, 10);
  assert.ok(kept[0].mtime >= kept[kept.length - 1].mtime, 'newest first');
  assert.deepEqual(await pruneBackups(dir, 10), []);
});

test('backup format is a plain state snapshot (no runtime-control)', async () => {
  const dir = await tmp();
  const { store } = await openStore(dir);
  const { path } = await createBackup(dir, store);
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'runtimeControl'), false);
});