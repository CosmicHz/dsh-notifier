// Host interaction waiters (B04; 20-HOST-PROTOCOL-MAP.md "hostRef", W03).
//
// A hostRef is `bootUUID:waiterUUID`. The resolver map lives only in this process:
// rc.2 is `interactionRecovery=process-only`, so a restart can never resume a host
// request that already vanished. `query()` therefore distinguishes the honest
// cases instead of collapsing them:
//   - live in this boot                  -> pending
//   - settled in this boot (tombstone)   -> resolved | cancelled
//   - ref in our format, another boot    -> cancelled (the closure is gone)
//   - anything else (foreign opaque ref) -> unknown
// unknown is never reported as cancelled, and a missing host query capability must
// degrade honestly rather than claim recoverable pending interactions.
import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/errors.mjs';

export const WAITER_STATUSES = Object.freeze(['pending', 'resolved', 'cancelled', 'unknown']);
export const TERMINAL_WAITER_STATUSES = Object.freeze(['resolved', 'cancelled']);

const SEP = ':';

/** Parse `bootUUID:waiterUUID`; returns null for a foreign or malformed ref. */
export function parseHostRef(hostRef) {
  if (typeof hostRef !== 'string') return null;
  const at = hostRef.indexOf(SEP);
  if (at <= 0 || at === hostRef.length - 1) return null;
  return { bootId: hostRef.slice(0, at), waiterId: hostRef.slice(at + 1) };
}

export function makeHostRef(bootId, waiterId) {
  if (typeof bootId !== 'string' || bootId === '') throw new DomainError('INTERNAL', 'bootId is required');
  if (typeof waiterId !== 'string' || waiterId === '') throw new DomainError('INTERNAL', 'waiterId is required');
  return `${bootId}${SEP}${waiterId}`;
}

/**
 * @param {object} options
 * @param {string} options.bootId random per-process id embedded in every hostRef
 * @param {()=>number} [options.now]
 * @param {()=>string} [options.newId]
 */
export function createHostWaiters({ bootId, now = Date.now, newId = randomUUID } = {}) {
  if (typeof bootId !== 'string' || bootId === '') throw new DomainError('INTERNAL', 'bootId is required');
  const live = new Map(); // hostRef -> record
  const tombstones = new Map(); // hostRef -> {status, at}
  let disposed = false;

  function isOwnRef(hostRef) {
    const parsed = parseHostRef(hostRef);
    return parsed !== null && parsed.bootId === bootId;
  }

  /**
   * Register one in-memory waiter for a host request. The caller resolves it when
   * the host answers (approval/question) or abandons it on cancel/timeout.
   * @returns {{hostRef:string, waiterId:string, promise:Promise<object>, settled:boolean}}
   */
  function register(meta = {}) {
    if (disposed) throw new DomainError('CANCELLED', 'waiters were disposed');
    const waiterId = newId();
    const hostRef = makeHostRef(bootId, waiterId);
    let resolveFn;
    const promise = new Promise((resolve) => { resolveFn = resolve; });
    const record = {
      hostRef,
      waiterId,
      meta: { ...meta },
      promise,
      resolve: resolveFn,
      settled: false,
      createdAt: now(),
    };
    live.set(hostRef, record);
    return { hostRef, waiterId, promise, get settled() { return record.settled; } };
  }

  /** Resolve a live waiter and move it to the tombstone so it never resolves twice. */
  function settle(hostRef, status) {
    if (!TERMINAL_WAITER_STATUSES.includes(status)) {
      throw new DomainError('INTERNAL', `waiter status must be one of ${TERMINAL_WAITER_STATUSES.join('|')}`);
    }
    const record = live.get(hostRef);
    if (!record) {
      // Already settled or never ours: keep the first terminal answer.
      if (tombstones.has(hostRef)) return tombstones.get(hostRef);
      return null;
    }
    record.settled = true;
    live.delete(hostRef);
    const entry = { status, at: now() };
    tombstones.set(hostRef, entry);
    record.resolve({ hostRef, status });
    return entry;
  }

  /**
   * queryInteraction semantics (03: pending/resolved/cancelled/unknown).
   * @returns {'pending'|'resolved'|'cancelled'|'unknown'}
   */
  function query(hostRef) {
    if (typeof hostRef !== 'string') return 'unknown';
    if (live.has(hostRef)) return 'pending';
    const tomb = tombstones.get(hostRef);
    if (tomb) return tomb.status === 'resolved' ? 'resolved' : 'cancelled';
    const parsed = parseHostRef(hostRef);
    if (parsed === null) return 'unknown'; // foreign opaque ref we never issued
    if (parsed.bootId === bootId) return 'unknown'; // ours-this-boot but unknown waiter
    return 'cancelled'; // ours-format, previous boot: the wait closure no longer exists
  }

  function count() {
    return live.size;
  }

  /** Cancel every live waiter (stop/dispose); idempotent. */
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const hostRef of [...live.keys()]) settle(hostRef, 'cancelled');
    live.clear();
  }

  return { bootId, isOwnRef, register, settle, query, count, dispose };
}