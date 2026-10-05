// Single-owner runtime lock (02-DATA.md "Store与恢复").
// Exclusive create (wx/0600); never auto-steals; offline unlock is explicit.
import { open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';

export const LOCK_FILE = 'runtime.lock';

export function lockPath(dir) {
  return join(dir, LOCK_FILE);
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH: no such process. EPERM: exists but not ours -> treat as alive.
    return err.code !== 'ESRCH';
  }
}

export async function readLock(dir) {
  try {
    const raw = await readFile(lockPath(dir), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { corrupt: true, raw };
    }
    return { corrupt: false, lock: parsed };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return { corrupt: true, error: err.code ?? 'READ_ERROR' };
  }
}

/**
 * Try to acquire exclusive ownership of a state directory.
 * @returns {{ok:true, lock:object, nonce:string} | {ok:false, reason:'EXISTS'|'CORRUPT', existing:unknown}}
 */
export async function acquireLock(dir, { host = os.hostname(), pid = process.pid, nonce } = {}) {
  const token = nonce ?? cryptoId();
  const payload = { pid, host, nonce: token, acquiredAt: Date.now() };
  try {
    const handle = await open(lockPath(dir), 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(payload));
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { ok: true, lock: payload, nonce: token };
  } catch (err) {
    if (err.code === 'EEXIST') {
      const existing = await readLock(dir);
      return { ok: false, reason: existing?.corrupt ? 'CORRUPT' : 'EXISTS', existing };
    }
    throw err;
  }
}

/** Remove the lock only if we still own it. */
export async function releaseLock(dir, nonce) {
  const existing = await readLock(dir);
  if (!existing || existing.corrupt) return { ok: false, reason: 'NOT_FOUND' };
  if (existing.lock.nonce !== nonce) return { ok: false, reason: 'NOT_OWNER' };
  await unlink(lockPath(dir));
  return { ok: true };
}

/**
 * Offline unlock is allowed only when the lock is from this host and its pid is
 * truly gone. A live process or EPERM is refused.
 */
export function canUnlock(lock, { host = os.hostname(), alive = isProcessAlive } = {}) {
  if (!lock || typeof lock !== 'object') return { ok: false, reason: 'NOT_FOUND' };
  if (lock.host !== host) return { ok: false, reason: 'OTHER_HOST' };
  if (alive(lock.pid)) return { ok: false, reason: 'ALIVE' };
  return { ok: true };
}

export async function unlock(dir, options = {}) {
  const existing = await readLock(dir);
  if (!existing || existing.corrupt) return { ok: false, reason: 'NOT_FOUND' };
  const verdict = canUnlock(existing.lock, options);
  if (!verdict.ok) return verdict;
  await unlink(lockPath(dir));
  return { ok: true, released: existing.lock };
}

function cryptoId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}