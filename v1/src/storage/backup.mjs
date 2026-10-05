// Backup / restore / corrupt quarantine (02-DATA.md "Store与恢复", 05-HOST-CLI.md).
// Backups are read-only snapshots taken from the store queue. runtime-control.json
// is never included. A corrupt original is preserved, never used as a backup.
import { open, readFile, writeFile, rename, mkdir, readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError } from '../domain/errors.mjs';
import { validateState } from '../domain/schema.mjs';
import { LIMITS } from '../domain/limits.mjs';
import { statePath, STATE_FILE } from './store.mjs';

export const BACKUP_DIR = 'backups';

export function backupDir(dir) {
  return join(dir, BACKUP_DIR);
}

export async function listBackups(dir) {
  try {
    const names = await readdir(backupDir(dir));
    const entries = [];
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      const info = await stat(join(backupDir(dir), name));
      entries.push({ name, path: join(backupDir(dir), name), size: info.size, mtime: info.mtimeMs });
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    return entries;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function stamp(now = Date.now()) {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

/**
 * Take a committed-snapshot backup. Serializes behind the store's write queue so
 * the snapshot is consistent, then prunes to MAX_BACKUPS.
 */
export async function createBackup(dir, store, { now = Date.now() } = {}) {
  await store.whenIdle();
  const snapshot = store.snapshot();
  validateState(snapshot);
  await mkdir(backupDir(dir), { recursive: true });
  const name = `state-${stamp(now)}-r${snapshot.revision}.json`;
  const target = join(backupDir(dir), name);
  const handle = await open(target, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(snapshot));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await pruneBackups(dir);
  return { path: target, name, revision: snapshot.revision };
}

export async function pruneBackups(dir, max = LIMITS.MAX_BACKUPS) {
  const entries = await listBackups(dir);
  const removed = [];
  for (const entry of entries.slice(max)) {
    await unlink(entry.path).catch(() => {});
    removed.push(entry.name);
  }
  return removed;
}

/**
 * Quarantine an unreadable state.json as a .invalid copy. The original bytes are
 * preserved verbatim and are never offered as a valid restore source.
 */
export async function quarantineCorrupt(dir, { now = Date.now() } = {}) {
  const source = statePath(dir);
  let raw;
  try {
    raw = await readFile(source, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const name = `${STATE_FILE}.invalid.${stamp(now)}`;
  await writeFile(join(dir, name), raw, { mode: 0o600 });
  return { path: join(dir, name), name };
}

/**
 * Restore a backup onto state.json. Validates the backup first; on success the
 * previous state.json is preserved as a .pre-restore copy, then replaced atomically.
 * Callers must hold exclusive maintenance ownership (offline restore).
 */
export async function restoreBackup(dir, backupPath, { now = Date.now() } = {}) {
  let parsed;
  let raw;
  try {
    raw = await readFile(backupPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new DomainError('VALIDATION', 'backup file is unreadable or not JSON', { reason: err.code ?? 'PARSE' });
  }
  // Corrupt / unsupported backups are refused outright.
  validateState(parsed);

  let preserved = null;
  try {
    const current = await readFile(statePath(dir), 'utf8');
    if (current !== raw) {
      const name = `${STATE_FILE}.pre-restore.${stamp(now)}`;
      await writeFile(join(dir, name), current, { mode: 0o600 });
      preserved = { path: join(dir, name), name };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const tmp = join(dir, `.restore.${stamp(now)}.tmp`);
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(raw);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, statePath(dir));
  try {
    const dirHandle = await open(dir, 'r');
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Durability of the directory entry is uncertain; the caller must verify by
    // reopening the store (02-DATA.md).
    throw new DomainError('STORAGE_UNAVAILABLE', 'restore durability is uncertain', {
      durability: 'uncertain',
    });
  }
  return { restoredFrom: backupPath, revision: parsed.revision, preserved };
}