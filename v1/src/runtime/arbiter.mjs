// Per-session control arbiter (T10; 18-WIRING.md "并发与副作用", C04).
//
// One arbiter per session serializes the admission decisions for submit / stop /
// settle. It never holds the Store mutex while waiting on the network: the queue
// only orders the decisions, and the actual external call happens inside the task
// the caller supplies.
//
// Precedence rule (W12/18): a stop that has *run* cancels everything still queued
// behind it, but a settle that already dequeued completes (or becomes uncertain) —
// the linearization point is the claim, not the queue.
import { DomainError } from '../domain/errors.mjs';

export const ARBITER_KINDS = Object.freeze(['submit', 'stop', 'settle', 'steer']);

export function createSessionArbiter({ sessionId, now = Date.now, onEvent = null } = {}) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new DomainError('INTERNAL', 'session arbiter requires a sessionId');
  }
  let tail = Promise.resolve();
  let stopped = false;
  let disposed = false;
  let inFlight = 0;
  const pending = [];

  function emit(entry) {
    try {
      onEvent?.({ sessionId, kind: entry.kind, status: entry.status, at: entry.at });
    } catch { /* audit must never change control flow */ }
  }

  function run(kind, task) {
    if (!ARBITER_KINDS.includes(kind)) throw new DomainError('INTERNAL', `unknown arbiter kind ${kind}`);
    if (typeof task !== 'function') throw new DomainError('INTERNAL', 'arbiter task must be a function');
    const entry = { kind, status: 'queued', at: now() };
    pending.push(entry);
    emit(entry);

    const execute = async () => {
      if (disposed) {
        entry.status = 'cancelled';
        emit(entry);
        throw new DomainError('CANCELLED', 'session controller was disposed');
      }
      if (stopped && kind !== 'stop') {
        entry.status = 'cancelled';
        emit(entry);
        throw new DomainError('CANCELLED', `session ${sessionId} was stopped`);
      }
      entry.status = 'running';
      emit(entry);
      inFlight += 1;
      try {
        const value = await task();
        entry.status = 'done';
        return value;
      } catch (error) {
        entry.status = 'failed';
        throw error;
      } finally {
        inFlight -= 1;
        const index = pending.indexOf(entry);
        if (index >= 0) pending.splice(index, 1);
        emit(entry);
      }
    };

    const result = tail.then(execute, execute);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    sessionId,
    submit(task) { return run('submit', task); },
    steer(task) { return run('steer', task); },
    settle(task) { return run('settle', task); },
    stop(task) {
      return run('stop', async () => {
        // The moment the stop is admitted, nothing new may be admitted behind it.
        stopped = true;
        return task();
      });
    },
    get stopped() { return stopped; },
    get busy() { return inFlight > 0 || pending.some((entry) => entry.status === 'queued'); },
    pendingKinds() { return pending.map((entry) => `${entry.kind}:${entry.status}`); },
    dispose() {
      disposed = true;
      pending.length = 0;
    },
  };
}

/** Lazily create one arbiter per session id. */
export function createArbiterPool(options = {}) {
  const arbiters = new Map();
  return {
    for(sessionId) {
      let arbiter = arbiters.get(sessionId);
      if (!arbiter) {
        arbiter = createSessionArbiter({ ...options, sessionId });
        arbiters.set(sessionId, arbiter);
      }
      return arbiter;
    },
    size() { return arbiters.size; },
    dispose() {
      for (const arbiter of arbiters.values()) arbiter.dispose();
      arbiters.clear();
    },
  };
}