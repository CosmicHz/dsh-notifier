// Bounded host-event buffer (T15; 18-WIRING.md 生命周期, 20-HOST-PROTOCOL-MAP.md).
//
// Host events are delivered through a bounded buffer so a slow/absent dispatcher
// can never grow memory without limit. Before the dispatcher runs the buffer
// holds events in order; once it runs, pushes are drained immediately and
// serially, preserving arrival order. If the buffer overflows the caller flips
// health to degraded instead of dropping events and pretending to continue
// ("缓冲满停止接收并health degraded，不丢事件假继续").
export const DEFAULT_EVENT_BUFFER_CAPACITY = 256;

export function createEventBus({ capacity = DEFAULT_EVENT_BUFFER_CAPACITY, onOverflow = null, logger = null } = {}) {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new TypeError('event bus capacity must be a positive integer');
  }
  const buffer = [];
  let handler = null;
  let running = false;
  let disposed = false;
  let overflowed = false;
  let dropped = 0;

  function warn(message) {
    try { logger?.warn?.(`[dsh-notifier/event-bus] ${message}`); } catch { /* logging is never fatal */ }
  }

  function overflow(event) {
    overflowed = true;
    dropped += 1;
    warn(`event buffer is full (${capacity}); reporting degraded`);
    try { onOverflow?.(event); } catch { /* observer failures never alter control flow */ }
    return { accepted: false, code: 'CAPACITY' };
  }

  /** Enqueue one event. Returns {accepted:false,code:'CAPACITY'|'DISPOSED'} when refused. */
  function push(event) {
    if (disposed) return { accepted: false, code: 'DISPOSED' };
    if (running && handler !== null) {
      // Running: hand off immediately, still bounded by one in-flight drain.
      void Promise.resolve().then(() => handler(event)).catch((error) => {
        warn(`event handler failed: ${error?.code ?? error?.message ?? 'error'}`);
      });
      return { accepted: true };
    }
    if (buffer.length >= capacity) return overflow(event);
    buffer.push(event);
    return { accepted: true };
  }

  /**
   * Start dispatching. Buffered events are drained in arrival order, then new
   * pushes are handled serially. Idempotent.
   */
  function start(nextHandler) {
    if (disposed) throw new Error('event bus was disposed');
    if (typeof nextHandler !== 'function') throw new TypeError('event bus handler must be a function');
    handler = nextHandler;
    running = true;
    drain();
    return api;
  }

  function drain() {
    while (buffer.length > 0) {
      const event = buffer.shift();
      try {
        const result = handler(event);
        if (result && typeof result.then === 'function') {
          result.catch((error) => warn(`event handler failed: ${error?.code ?? error?.message ?? 'error'}`));
        }
      } catch (error) {
        warn(`event handler failed: ${error?.code ?? error?.message ?? 'error'}`);
      }
    }
  }

  /** Stop dispatching; queued events are dropped (a restart must not replay them). */
  function stop() {
    running = false;
    const droppedNow = buffer.length;
    buffer.length = 0;
    return { dropped: droppedNow };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stop();
    handler = null;
  }

  const api = {
    push,
    start,
    stop,
    dispose,
    get size() { return buffer.length; },
    get capacity() { return capacity; },
    get running() { return running; },
    get overflowed() { return overflowed; },
    get dropped() { return dropped; },
  };
  return api;
}