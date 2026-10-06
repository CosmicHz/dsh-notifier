// Runtime manager (T15; 03-SERVICES-RPC.md 生命周期, 18-WIRING.md, D04/D05).
//
// The manager owns the live per-account connections and the process-side ports
// that services and the plugin facade depend on. It never holds the Store mutex
// while waiting on the network, and it is the only place a connection epoch is
// minted.
//
// Two invariants drive the design:
//   D04 — an event carrying a superseded epoch is rejected before any durable
//         write, so a stale long-poll/transport can never commit a cursor.
//   D05 — after a restart the persisted side effects are reconciled: a `planned`
//         leaf never ran and is cancelled, a `started` leaf cannot be proven and
//         becomes uncertain, and nothing is re-dispatched automatically.
//
// Lifecycle order on stop: stop intake → abort in-flight → wait bounded for
// started effects → stop providers → dispose listeners/callbacks/timers. Every
// step is idempotent, and a partially started manager unwinds in reverse.
import { randomUUID } from 'node:crypto';
import { DomainError, notFound, validationError } from '../domain/errors.mjs';
import { commit } from '../storage/store.mjs';
import { createArbiterPool } from './arbiter.mjs';
import { createEventBus } from './event-bus.mjs';
import { reconcileStartedEffects } from '../services/effects.mjs';
import { reconcileCorrelations } from '../services/correlations.mjs';
import { reconcileInteractions } from '../services/interactions.mjs';
import {
  receiveInbound, claimInbound, completeInbound, markInboundUncertain, advanceCursor, pruneInbox,
} from '../services/inbox.mjs';
import { handleInbound as defaultHandleInbound } from '../services/conversation.mjs';
import { redeemPairing as defaultRedeemPairing } from '../services/pairing.mjs';
import { createHostReturn } from './host-return.mjs';
import { sendControlReply as defaultControlReply } from '../services/control-replies.mjs';
import { notify as defaultNotify } from '../services/notifications.mjs';
import { createCallbackMount } from '../host/callbacks.mjs';
import { getChannelProvider } from '../providers/registry.mjs';

export const RUNTIME_STATES = Object.freeze(['created', 'starting', 'running', 'stopping', 'stopped']);
export const CONNECTION_STATES = Object.freeze(['connecting', 'ready', 'degraded', 'outbound', 'stopped']);

/** Error codes that prove an inbound event was decided (safe to mark done). */
const DEFINITIVE_INBOUND = new Set([
  'VALIDATION', 'FORBIDDEN', 'NOT_FOUND', 'UNSUPPORTED', 'CONFLICT', 'EXPIRED', 'ALREADY_HANDLED', 'CAPACITY',
]);

function nowOf(clock) {
  return Number.isInteger(clock?.now) ? clock.now : Date.now();
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} options
 * @param {import('../storage/store.mjs').Store} options.store
 * @param {object} [options.host] HostPort (optional: honest absence degrades)
 * @param {object} [options.projection] read projection (surfaceVersion/health)
 * @param {(channelId:string)=>object|null} [options.resolveProvider]
 * @param {Function} [options.handleInbound]
 * @param {Function} [options.controlReplySender]
 * @param {Function} [options.notifySender]
 * @param {Function} [options.redeemPairing] Pairing redemption (store, input, ctx) -> principal
 * @param {object|null} [options.network]
 * @param {number} [options.eventBufferCapacity]
 * @param {number} [options.stopWaitMs]
 * @param {()=>number} [options.now]
 * @param {()=>string} [options.newId]
 */
export function createRuntimeManager({
  store,
  host = null,
  projection = null,
  resolveProvider = null,
  handleInbound = defaultHandleInbound,
  controlReplySender = defaultControlReply,
  notifySender = defaultNotify,
  redeemPairing = defaultRedeemPairing,
  network = null,
  limiter = null,
  eventBufferCapacity = 256,
  stopWaitMs = 10000,
  now = Date.now,
  newId = randomUUID,
  sleep = defaultSleep,
  logger = null,
  epochFactory = null,
} = {}) {
  if (!store || typeof store.snapshot !== 'function') {
    throw new DomainError('INTERNAL', 'createRuntimeManager requires a Store');
  }
  const resolve = resolveProvider ?? defaultResolveProvider;
  const clock = { now };
  const bus = createEventBus({
    capacity: eventBufferCapacity,
    onOverflow: () => setHealth('degraded', 'EVENT_BUFFER_OVERFLOW'),
    logger,
  });
  const arbiters = createArbiterPool({ now });
  const connections = new Map(); // accountId -> connection record
  const unsubscribers = [];
  const inFlight = new Set(); // AbortControllers of dispatched inbound work
  let state = 'created';
  let intakeClosed = false;
  let health = { status: 'starting', code: null, detail: null, updatedAt: now() };

  function warn(message) {
    try { logger?.warn?.(`[dsh-notifier/runtime] ${message}`); } catch { /* logging is never fatal */ }
  }

  function setHealth(status, code = null, detail = null) {
    health = { status, code, detail, updatedAt: now() };
    try { projection?.setHealth?.(health); } catch { /* projection is an observer */ }
    return health;
  }

  function mintEpoch() {
    return typeof epochFactory === 'function' ? epochFactory() : newId();
  }

  function requireRunning(action) {
    if (state !== 'running') {
      throw new DomainError('NOT_READY', `runtime manager is ${state}; ${action} is not available`);
    }
  }

  // -------------------------------------------------------------------------
  // inbound ingest (D04)
  // -------------------------------------------------------------------------

  /**
   * Durably receive one provider-emitted envelope, then process it. A stale epoch
   * is rejected BEFORE any store write so a superseded transport can neither
   * persist an event nor advance a cursor.
   */
  async function ingest(envelope) {
    if (intakeClosed) return { accepted: false, code: 'CANCELLED' };
    if (state !== 'running' && state !== 'starting') return { accepted: false, code: 'NOT_READY' };
    if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
      throw validationError('inbound envelope must be an object');
    }
    const accountId = envelope.accountId;
    if (typeof accountId !== 'string' || accountId === '') throw validationError('envelope.accountId is required');
    if (typeof envelope.eventId !== 'string' || envelope.eventId === '') throw validationError('envelope.eventId is required');
    const account = store.snapshot().accounts[accountId];
    if (!account) throw notFound('account not found');
    const connection = connections.get(accountId);
    if (!connection) return { accepted: false, code: 'NO_CONNECTION' };
    if (envelope.epoch !== connection.epoch) {
      return { accepted: false, code: 'STALE_EPOCH' };
    }
    // D04 satisfied: stale epoch rejected before checking controlEnabled
    if (account.enabled !== true || account.controlEnabled !== true) {
      return { accepted: false, code: 'FORBIDDEN' };
    }
    const at = nowOf(clock);
    let received;
    try {
      received = await commit(store, null, (draft) => receiveInbound(draft, { accountId, eventId: envelope.eventId, now: at }));
    } catch (error) {
      return { accepted: false, code: typeof error?.code === 'string' ? error.code : 'INTERNAL' };
    }
    if (received.replayed) return { accepted: true, replayed: true, key: received.key };
    const claimed = await commit(store, null, (draft) => claimInbound(draft, received.key, { now: at }));
    if (!claimed.claimed) return { accepted: true, replayed: true, key: received.key };

    const controller = new AbortController();
    inFlight.add(controller);
    let outcome;
    try {
      // N01: give the conversation policy the current Host session set so an
      // owner with no declared scope can still resolve a single active session.
      let activeSessionIds = null;
      if (host && typeof host.listSessions === 'function') {
        try { activeSessionIds = (await host.listSessions()).map((s) => s.id); }
        catch { activeSessionIds = null; }
      }
      outcome = await handleInbound(store, envelope, {
        host,
        network,
        now: at,
        activeSessionIds,
        signal: controller.signal,
        arbiterFor: (sessionId) => arbiters.for(sessionId),
        controlReply: (input) => controlReply(input, { signal: controller.signal }),
        // R10: pairing redemption is the runtime's composition-root
        // responsibility; the service stays free of concrete pairing wiring.
        redeemPairing: (input) => redeemPairing(store, input, { now: at }),
      });
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'INTERNAL';
      await commit(store, null, (draft) => {
        if (DEFINITIVE_INBOUND.has(code)) completeInbound(draft, received.key, { now: nowOf(clock) });
        else markInboundUncertain(draft, received.key, { now: nowOf(clock) });
        return null;
      }).catch(() => null);
      inFlight.delete(controller);
      projection?.invalidate?.('inbound');
      return { accepted: true, key: received.key, code };
    }
    inFlight.delete(controller);
    await commit(store, null, (draft) => {
      completeInbound(draft, received.key, { now: nowOf(clock) });
      return null;
    });
    projection?.invalidate?.('inbound');
    return { accepted: true, key: received.key, outcome };
  }

  // -------------------------------------------------------------------------
  // ports
  // -------------------------------------------------------------------------

  async function controlReply(input, ctx = {}) {
    requireRunning('controlReply');
    const accountId = input?.accountId;
    const account = typeof accountId === 'string' ? store.snapshot().accounts[accountId] : null;
    if (!account) throw notFound('account not found');
    const provider = resolve(account.channelId);
    return controlReplySender(store, input, {
      provider,
      network,
      now: nowOf(clock),
      signal: ctx.signal ?? null,
    });
  }

  async function sendNotification(input, ctx = {}) {
    requireRunning('notify');
    return notifySender(store, input, {
      network,
      limiter,
      now: nowOf(clock),
      ...ctx,
    });
  }

  const notificationPort = Object.freeze({
    notify: (input) => sendNotification(input),
    getCapabilities: () => Object.freeze({ apiVersion: 1, notify: true }),
  });

  const controlReplyPort = Object.freeze({
    controlReply: (input) => controlReply(input),
  });

  // R11: Host event -> correlation/Interaction -> control reply (18 链4/链5).
  const hostReturn = createHostReturn({
    store,
    controlReply: (input) => controlReply(input),
    now,
    newId,
    logger,
  });

  // -------------------------------------------------------------------------
  // connections
  // -------------------------------------------------------------------------

  function connectionView(accountId) {
    const connection = connections.get(accountId);
    if (!connection) return { accountId, state: 'stopped', epoch: null, errorCode: null };
    return { accountId, state: connection.state, epoch: connection.epoch, errorCode: connection.errorCode ?? null };
  }

  function makeCursorStore(accountId, epoch) {
    return {
      load() {
        return store.snapshot().cursors[accountId]?.transportData ?? {};
      },
      async commit(_accountId, transportData) {
        const connection = connections.get(accountId);
        if (!connection || connection.epoch !== epoch) {
          return { advanced: false, reason: 'STALE_EPOCH' };
        }
        return commit(store, null, (draft) => advanceCursor(draft, accountId, transportData, { now: nowOf(clock) }));
      },
    };
  }

  async function stopConnection(accountId) {
    const connection = connections.get(accountId);
    if (!connection) return false;
    connection.state = 'stopped';
    try { connection.controller?.abort(); } catch { /* already gone */ }
    try { await connection.stop?.(); } catch (error) { warn(`connection stop failed: ${error?.message ?? 'error'}`); }
    try { connection.callbackMount?.dispose?.(); } catch { /* best effort */ }
    connections.delete(accountId);
    return true;
  }

  /**
   * (Re)connect one account with a fresh epoch. An outbound-only account gets a
   * connection record too, so the plugin facade can honestly report its state.
   */
  async function applyAccount(accountId) {
    await stopConnection(accountId);
    const account = store.snapshot().accounts[accountId];
    const epoch = mintEpoch();
    if (!account) return { accountId, state: 'stopped', epoch: null };
    const provider = resolve(account.channelId);
    if (!provider || provider.capabilities?.inbound !== true || typeof provider.start !== 'function') {
      connections.set(accountId, { epoch, state: 'outbound', provider: null, controller: null, stop: null });
      return connectionView(accountId);
    }
    if (account.enabled !== true || account.controlEnabled !== true) {
      connections.set(accountId, { epoch, state: 'stopped', provider: null, controller: null, stop: null });
      return connectionView(accountId);
    }
    const controller = new AbortController();
    const connection = { epoch, state: 'connecting', provider, controller, stop: null, errorCode: null, callbackMount: null };
    connections.set(accountId, connection);
    try {
      const started = await provider.start({
        account,
        epoch,
        emit: (envelope) => ingest(envelope),
        signal: controller.signal,
        network,
        clock,
        cursorStore: makeCursorStore(accountId, epoch),
        // A fatal background exit (e.g. HTTP 401/403) must project a real
        // degraded connection, never a fake `ready`. Ignore the callback if the
        // connection was already superseded or removed (swap/stop), so a dying
        // loop cannot knock out its replacement.
        onFatal: (info) => {
          const current = connections.get(accountId);
          if (!current || current.epoch !== epoch || current.state === 'stopped') return;
          current.state = 'degraded';
          current.errorCode = typeof info?.code === 'string' ? info.code : 'INTERNAL';
          warn(`account ${accountId} background exit: ${current.errorCode}`);
          setHealth('degraded', 'CHANNEL_DEGRADED', accountId);
          projection?.invalidate?.('runtime-degraded');
        },
      });
      connection.stop = typeof started?.stop === 'function' ? started.stop : null;
      // N03: promote to ready only while this is still the current connection, it was
      // not aborted, and start did not already report a fatal. onFatal is a monotonic
      // state change, so a late start can never overwrite it back to ready.
      if (connections.get(accountId) !== connection) {
        // Superseded by a restart/stop while starting: release the late handle so the
        // replaced connection cannot keep running (no leak).
        try { await connection.stop?.(); } catch { /* best effort */ }
        connection.stop = null;
      } else if (connection.state === 'connecting' && !controller.signal.aborted) {
        connection.state = 'ready';
      }
    } catch (error) {
      // Only the current, non-superseded connection may degrade its own health.
      if (connections.get(accountId) === connection) {
        connection.state = 'degraded';
        connection.errorCode = typeof error?.code === 'string' ? error.code : 'INTERNAL';
        warn(`account ${accountId} failed to start: ${connection.errorCode}`);
        setHealth('degraded', 'CHANNEL_DEGRADED', accountId);
      }
    }
    // Callback-mounted channels (Feishu/WxPusher/...): the mount shares this
    // connection's epoch so a callback carrying an old epoch is rejected.
    if (state !== 'stopping' && state !== 'stopped' && typeof provider.handleCallback === 'function') {
      const mount = createCallbackMount({
        host,
        resolveAccount: (id) => store.snapshot().accounts[id] ?? null,
        resolveProvider: resolve,
        ingest: (envelope) => ingest(envelope),
        epoch,
        onUnavailable: () => setHealth('degraded', 'CALLBACK_UNAVAILABLE', accountId),
        logger,
      });
      const mounted = await mount.mountAccount(account);
      if (mounted.mounted) connection.callbackMount = mount;
      else mount.dispose();
    }
    return connectionView(accountId);
  }

  async function restartAccount(accountId) {
    requireRunning('restartAccount');
    const account = store.snapshot().accounts[accountId];
    if (!account) throw notFound('account not found');
    const view = await applyAccount(accountId);
    projection?.invalidate?.('runtime-restart');
    return view;
  }

  // -------------------------------------------------------------------------
  // reconcile (D05)
  // -------------------------------------------------------------------------

  async function reconcile() {
    const at = nowOf(clock);
    await commit(store, null, (draft) => {
      reconcileStartedEffects(draft, { now: at, graceMs: 0 });
      reconcileCorrelations(draft, { now: at });
      pruneInbox(draft, { now: at });
      return null;
    });
    const clone = store.snapshot();
    const interactions = await reconcileInteractions(clone, { host, now: at });
    await commit(store, null, (draft) => {
      draft.interactions = clone.interactions;
      return null;
    });
    return interactions;
  }

  async function reconcileAccounts() {
    const accounts = Object.values(store.snapshot().accounts);
    const views = [];
    for (const account of accounts) {
      views.push(await applyAccount(account.id));
    }
    return views;
  }

  // -------------------------------------------------------------------------
  // host events
  // -------------------------------------------------------------------------

  async function onHostEvent(event) {
    if (bus.push(event).accepted !== true) return;
  }

  async function dispatch(event) {
    if (event === null || typeof event !== 'object') return;
    try {
      if (event.type === 'capabilities.changed') {
        projection?.invalidate?.('capabilities');
        return;
      }
      // Turn output/completion and opened interactions are business events: the
      // return path turns them into a control reply (R11).
      if (event.type === 'turn.output' || event.type === 'turn.completed' || event.type === 'turn.failed'
        || event.type === 'interaction.opened' || event.type === 'session.closed') {
        await hostReturn.handle(event);
        projection?.invalidate?.(event.type);
        return;
      }
      projection?.invalidate?.(event.type);
    } catch (error) {
      warn(`host event ${event?.type ?? 'unknown'} failed: ${error?.code ?? error?.message ?? 'error'}`);
      setHealth('degraded', 'HOST_EVENT_FAILED');
    }
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  async function start() {
    if (state === 'running') return { status: 'running' };
    if (state === 'starting') throw new DomainError('CONFLICT', 'runtime manager is already starting');
    if (state === 'stopping' || state === 'stopped') {
      throw new DomainError('CANCELLED', 'runtime manager can no longer start');
    }
    state = 'starting';
    intakeClosed = false;
    const started = [];
    try {
      setHealth('starting', null, null);
      if (host && typeof host.subscribe === 'function') {
        const dispose = host.subscribe((event) => onHostEvent(event));
        if (typeof dispose === 'function') unsubscribers.push(dispose);
      }
      const interactions = await reconcile();
      started.push(() => reconcile());
      bus.start((event) => dispatch(event));
      started.push(() => bus.dispose());
      await reconcileAccounts();
      state = 'running';
      setHealth('ready', null, null);
      projection?.invalidate?.('runtime-started');
      return { status: 'running', interactions };
    } catch (error) {
      // Unwind the steps that already completed, in reverse, without throwing.
      for (const undo of started.reverse()) {
        try { await undo(); } catch { /* best effort */ }
      }
      state = 'stopped';
      setHealth('degraded', typeof error?.code === 'string' ? error.code : 'START_FAILED', error?.message ?? null);
      throw error;
    }
  }

  /** Wait (bounded) until no effect is still `started`, then reconcile. */
  async function settleStartedEffects(deadline) {
    while (now() < deadline) {
      const pending = Object.values(store.snapshot().effects).filter((effect) => effect.status === 'started');
      if (pending.length === 0) return;
      await sleep(Math.min(50, Math.max(0, deadline - now())));
    }
    await commit(store, null, (draft) => {
      reconcileStartedEffects(draft, { now: nowOf(clock), graceMs: 0 });
      return null;
    });
  }

  async function stop({ timeoutMs = stopWaitMs } = {}) {
    if (state === 'stopped' || state === 'stopping') return { status: 'stopped' };
    if (state === 'created') { state = 'stopped'; return { status: 'stopped' }; }
    state = 'stopping';
    intakeClosed = true;
    bus.stop();
    const deadline = now() + Math.max(0, timeoutMs);
    for (const controller of [...inFlight]) {
      try { controller.abort(); } catch { /* already aborted */ }
    }
    await settleStartedEffects(deadline).catch(() => null);
    for (const accountId of [...connections.keys()]) {
      await stopConnection(accountId);
    }
    for (const dispose of unsubscribers.splice(0)) {
      try { dispose(); } catch { /* best effort */ }
    }
    arbiters.dispose();
    bus.dispose();
    hostReturn.dispose();
    inFlight.clear();
    state = 'stopped';
    setHealth('stopped', null, null);
    projection?.invalidate?.('runtime-stopped');
    return { status: 'stopped' };
  }

  async function dispose() {
    if (state === 'stopped') {
      bus.dispose();
      return { status: 'stopped' };
    }
    return stop();
  }

  return {
    start,
    stop,
    dispose,
    ingest,
    restartAccount,
    controlReply,
    sendNotification,
    connectionView,
    get state() { return state; },
    get health() { return health; },
    get epoch() { return connections.size === 0 ? null : null; },
    connections() { return [...connections.keys()].map((id) => connectionView(id)); },
    notificationPort,
    controlReplyPort,
    eventBus: bus,
  };
}

function defaultResolveProvider(channelId) {
  // Resolve any implementation (outbound or inbound-only); null is an honest
  // "not implemented" that degrades the connection instead of faking success.
  return getChannelProvider(channelId);
}