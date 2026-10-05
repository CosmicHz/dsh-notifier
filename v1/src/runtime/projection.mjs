// Read projection + surface version (B03; 18-WIRING.md "健康"; W05/W28).
//
// Two revisions are deliberately separate: the Store's own revision (what is
// persisted, read through Store.snapshot) and the in-process surfaceVersion
// {bootId, sequence}. Health, login and Host-capability changes bump the
// surfaceVersion WITHOUT writing state.json, and `wait` re-checks the version
// after registering its listener so a wakeup is never lost.
import { randomUUID } from 'node:crypto';
import { validationError } from '../domain/errors.mjs';
import { LIMITS } from '../domain/limits.mjs';

function validAfterVersion(value) {
  return (
    value !== null && typeof value === 'object'
    && typeof value.bootId === 'string' && value.bootId !== ''
    && Number.isInteger(value.sequence) && value.sequence >= 0
  );
}

function clampTimeout(value) {
  if (value === undefined || value === null) return LIMITS.SURFACE_WAIT_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 0) throw validationError('timeoutMs must be a non-negative integer');
  return Math.min(value, LIMITS.SURFACE_WAIT_TIMEOUT_MS);
}

/**
 * @param {{bootId?:string, now?:()=>number}} [options]
 */
export function createProjection({ bootId = randomUUID(), now = Date.now } = {}) {
  let sequence = 0;
  const waiters = new Set();
  const listeners = new Set();
  let health = Object.freeze({ status: 'starting', code: null, detail: null, updatedAt: now() });

  function surfaceVersion() {
    return { bootId, sequence };
  }

  /** Bump the process-internal sequence and wake every listener/waiter. */
  function invalidate(reason = null) {
    sequence += 1;
    const version = surfaceVersion();
    for (const listener of [...listeners]) {
      try { listener(version, reason); } catch { /* a subscriber must not break the projection */ }
    }
    for (const waiter of [...waiters]) waiter.check();
    return version;
  }

  function subscribe(handler) {
    if (typeof handler !== 'function') throw validationError('subscribe(handler) requires a function');
    listeners.add(handler);
    return () => listeners.delete(handler);
  }

  /**
   * Wait until the surface version moves past `afterVersion` (or the boot id
   * changes, which always means refresh). Registers first, re-checks second.
   * @returns {Promise<{changed:boolean, surfaceVersion:{bootId:string,sequence:number}}>}
   */
  function wait({ afterVersion, timeoutMs, signal = null } = {}) {
    if (!validAfterVersion(afterVersion)) throw validationError('afterVersion must be {bootId, sequence}');
    if (signal !== null && typeof signal.addEventListener !== 'function') throw validationError('signal must be an AbortSignal');
    const budget = clampTimeout(timeoutMs);
    if (afterVersion.bootId !== bootId) {
      return Promise.resolve({ changed: true, surfaceVersion: surfaceVersion() });
    }
    if (sequence > afterVersion.sequence) {
      return Promise.resolve({ changed: true, surfaceVersion: surfaceVersion() });
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters.delete(waiter);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const onAbort = () => finish({ changed: false, surfaceVersion: surfaceVersion() });
      const waiter = {
        check() {
          if (settled) return;
          const version = surfaceVersion();
          if (version.sequence > afterVersion.sequence) finish({ changed: true, surfaceVersion: version });
        },
      };
      const timer = setTimeout(() => finish({ changed: false, surfaceVersion: surfaceVersion() }), budget);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      waiters.add(waiter);
      waiter.check();
    });
  }

  /** Health is runtime state, never persisted; a change still bumps the version. */
  function setHealth(next) {
    health = Object.freeze({ updatedAt: now(), code: null, detail: null, ...next });
    invalidate('health');
    return health;
  }

  function getHealth() {
    return health;
  }

  return {
    bootId,
    get sequence() { return sequence; },
    surfaceVersion,
    invalidate,
    subscribe,
    wait,
    setHealth,
    getHealth,
  };
}