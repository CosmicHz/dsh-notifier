// Composition root (T26; 18-WIRING.md, 05-HOST-CLI.md).
//
// This is the ONLY place that builds the concrete ports, the Store, the services
// and the RuntimeManager. Ordering follows 18 "生命周期" exactly:
//
//   construct side-effect-free ports/descriptors
//     -> open Store
//     -> construct services/runtime (manager subscribes host events into the
//        bounded buffer, reconciles, THEN opens intake)
//     -> reconcile accounts
//
// A storage failure is a damaged state: only diagnostics are exposed and no
// half-usable business service or host tool is built. Teardown runs every
// registered disposer in reverse registration order, and `dispose()` is
// idempotent.
import { randomUUID, createHash } from 'node:crypto';
import { DomainError } from '../domain/errors.mjs';
import { LIMITS } from '../domain/limits.mjs';
import { commit, openStore } from '../storage/store.mjs';
import { createNetwork } from '../security/network.mjs';
import { createUnavailableHost } from '../host/port.mjs';
import { createDshHost, describeDshSeams } from '../host/dsh.mjs';
import { createProjection } from './projection.mjs';
import { createRuntimeManager } from './manager.mjs';
import { openInteraction, expireInteractions, TERMINAL_INTERACTION_STATES } from '../services/interactions.mjs';
import { testNotification } from '../services/notifications.mjs';

export const APPLICATION_STATES = Object.freeze(['created', 'starting', 'running', 'degraded', 'stopping', 'stopped']);

/** Stable UUID for a tool callId, so a retried call keeps the same requestId. */
export function stableRequestId(seed) {
  const hex = createHash('sha256').update(String(seed)).digest('hex').slice(0, 32).split('');
  hex[12] = '8';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20, 32).join('')}`;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

function idOf(value) {
  if (typeof value === 'string' && value !== '') return value;
  if (isRecord(value) && typeof value.id === 'string' && value.id !== '') return value.id;
  return null;
}

/**
 * @param {object} options
 * @param {object|null} [options.store] prebuilt Store (adopted; the caller owns it)
 * @param {string|null} [options.stateDir] opened with openStore() when no Store is injected
 * @param {object|null} [options.host] prebuilt HostPort
 * @param {object|null} [options.dsh] injected DSH seam bundle -> createDshHost()
 * @param {object|null} [options.network] NetworkPort
 * @param {object|null} [options.projection]
 * @param {object|null} [options.seams] seam description override (tests)
 * @param {()=>number} [options.clock]
 * @param {()=>string} [options.newId]
 * @param {string} [options.bootId]
 * @param {object|null} [options.logger]
 */
export function createApplication({
  store: injectedStore = null,
  stateDir = null,
  host: injectedHost = null,
  dsh = null,
  network: injectedNetwork = null,
  projection: injectedProjection = null,
  seams = null,
  clock = Date.now,
  newId = randomUUID,
  bootId = randomUUID(),
  logger = null,
  openStoreImpl = openStore,
  createNetworkImpl = createNetwork,
  createManagerImpl = createRuntimeManager,
  createDshHostImpl = createDshHost,
  managerOptions = {},
} = {}) {
  const now = typeof clock === 'function' ? clock : Date.now;
  const projection = injectedProjection ?? createProjection({ bootId, now });
  const hostSeams = seams ?? (dsh !== null
    ? describeDshSeams(dsh)
    : Object.freeze({ events: injectedHost !== null, conversation: injectedHost !== null }));
  const host = injectedHost ?? (dsh !== null
    ? createDshHostImpl({ dsh, bootId, now, newId, logger })
    : createUnavailableHost('no DSH host seam bundle was injected'));
  const network = injectedNetwork ?? createNetworkImpl();

  const disposers = []; // registration order; torn down in reverse
  let state = 'created';
  let store = null;
  let manager = null;
  let degraded = null;

  function warn(message) {
    try { logger?.warn?.(`[dsh-notifier/application] ${message}`); } catch { /* logging is never fatal */ }
  }

  function registerDisposer(fn) {
    if (typeof fn === 'function') disposers.push(fn);
    return fn;
  }

  function requireRunning(action) {
    if (state !== 'running') {
      throw new DomainError('CONFLICT', `application is ${state}; ${action} is not available`);
    }
  }

  function health() {
    if (state === 'degraded') {
      return { status: 'degraded', code: degraded?.code ?? 'DEGRADED', detail: degraded?.detail ?? null };
    }
    if (state === 'created' || state === 'starting') {
      return { status: 'starting', code: null, detail: null };
    }
    if (hostSeams.events !== true) {
      return { status: 'degraded', code: 'HOST_EVENTS_UNAVAILABLE', detail: 'the DSH host exposes no events service' };
    }
    const runtimeHealth = manager?.health;
    if (runtimeHealth && runtimeHealth.status !== 'ready') {
      return { status: runtimeHealth.status, code: runtimeHealth.code ?? null, detail: runtimeHealth.detail ?? null };
    }
    return { status: 'ready', code: null, detail: null };
  }

  function resolveRequestId(explicit, callId) {
    if (typeof explicit === 'string' && explicit !== '') return explicit;
    if (typeof callId === 'string' && callId !== '') return stableRequestId(callId);
    return newId();
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  async function unwind() {
    for (const dispose of disposers.splice(0).reverse()) {
      try { await dispose(); } catch (error) { warn(`teardown step failed: ${error?.code ?? error?.message ?? 'error'}`); }
    }
  }

  async function start() {
    if (state === 'running') return { status: 'running', reused: true };
    if (state === 'starting') throw new DomainError('CONFLICT', 'application is already starting');
    if (state === 'stopping' || state === 'stopped') {
      throw new DomainError('CANCELLED', 'application can no longer start');
    }
    state = 'starting';
    // 1. Store: a damaged/unopenable store is a DIAGNOSTIC-ONLY state — no
    //    half-usable business service is constructed from it.
    try {
      if (injectedStore !== null) {
        store = injectedStore;
      } else if (typeof stateDir !== 'string' || stateDir === '') {
        degraded = { code: 'STORAGE_UNAVAILABLE', detail: 'stateDir is required to open the Store' };
        state = 'degraded';
        return { status: 'degraded', code: degraded.code };
      } else {
        const opened = await openStoreImpl(stateDir);
        if (opened.status !== 'ready') {
          degraded = { code: 'STORAGE_UNAVAILABLE', detail: opened.error?.message ?? null };
          state = 'degraded';
          return { status: 'degraded', code: degraded.code };
        }
        store = opened.store;
        registerDisposer(() => opened.store.close());
      }
    } catch (error) {
      store = null;
      degraded = { code: 'STORAGE_UNAVAILABLE', detail: error?.message ?? null };
      state = 'degraded';
      return { status: 'degraded', code: degraded.code };
    }
    // 2. Runtime manager: it installs the Host subscription buffer, reconciles
    //    pending state, then opens intake and reconciles accounts (W08).
    try {
      manager = createManagerImpl({
        store, host, projection, network, now, newId, logger, ...managerOptions,
      });
      registerDisposer(() => manager.dispose());
      await manager.start();
    } catch (error) {
      // A partially started runtime unwinds in reverse; the error is real.
      await unwind();
      store = null;
      manager = null;
      degraded = { code: typeof error?.code === 'string' ? error.code : 'START_FAILED', detail: error?.message ?? null };
      state = 'degraded';
      throw error;
    }
    state = 'running';
    return { status: 'running' };
  }

  async function stop() {
    if (state === 'stopped' || state === 'stopping') return { status: 'stopped' };
    if (state === 'created' || state === 'degraded') { state = 'stopped'; return { status: 'stopped' }; }
    state = 'stopping';
    await unwind();
    state = 'stopped';
    return { status: 'stopped' };
  }

  async function dispose() {
    if (state === 'stopped') {
      await unwind(); // idempotent: a second call finds an empty stack
      return { status: 'stopped' };
    }
    return stop();
  }

  // -------------------------------------------------------------------------
  // trusted host tool operations
  // -------------------------------------------------------------------------

  function trustedScope(ctx) {
    const sessionId = idOf(ctx?.sessionId);
    if (sessionId === null) {
      throw new DomainError('FORBIDDEN', 'a trusted host call context with a sessionId is required');
    }
    return {
      sessionId,
      agentId: idOf(ctx?.agentId) ?? sessionId,
      workspaceId: idOf(ctx?.workspaceId) ?? '',
    };
  }

  /** notify DTO: {requestId?,title?,text,level?,destinationIds?} -> {receipts}. */
  async function notify(input, ctx = {}) {
    requireRunning('notify');
    const scope = trustedScope(ctx);
    const requestId = resolveRequestId(input?.requestId, ctx.callId);
    const result = await manager.sendNotification({
      requestId,
      title: input?.title ?? '',
      text: input?.text,
      level: input?.level,
      destinationIds: input?.destinationIds,
      sessionId: scope.sessionId,
      agentId: scope.agentId,
      workspaceId: scope.workspaceId,
    }, { actor: { kind: 'host', id: scope.agentId, sessionId: scope.sessionId } });
    return { receipts: Array.isArray(result?.receipts) ? result.receipts : [] };
  }

  /** notify_test DTO: {destinationId} -> {receipts}; local management context only. */
  async function notifyTest(input, ctx = {}) {
    requireRunning('notify_test');
    if (ctx.localAdmin !== true) {
      throw new DomainError('FORBIDDEN', 'notify_test requires a local management context');
    }
    const requestId = resolveRequestId(input?.requestId, ctx.callId);
    const receipt = await testNotification(store, {
      requestId,
      destinationId: input?.destinationId,
    }, { network, now: now(), actor: { kind: 'local-owner', id: 'notify_test' } });
    return { receipts: receipt === null || receipt === undefined ? [] : [receipt] };
  }

  function waitForTerminal(interactionId, { deadline, signal }) {
    return new Promise((resolve) => {
      let settled = false;
      let poll = null;
      let hard = null;
      const cleanup = () => {
        if (poll !== null) clearInterval(poll);
        if (hard !== null) clearTimeout(hard);
        if (signal) signal.removeEventListener?.('abort', onAbort);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(store.snapshot().interactions[interactionId] ?? null);
      };
      const check = () => {
        const row = store.snapshot().interactions[interactionId] ?? null;
        if (row !== null && TERMINAL_INTERACTION_STATES.has(row.state)) { finish(); return true; }
        return false;
      };
      function onAbort() { finish(); }
      if (signal) signal.addEventListener?.('abort', onAbort, { once: true });
      if (check()) return;
      poll = setInterval(() => {
        if (check()) return;
        if (now() >= deadline) finish();
      }, 20);
      poll.unref?.();
      hard = setTimeout(() => finish(), Math.max(0, deadline - now()));
      hard.unref?.();
    });
  }

  function askOutcome(row) {
    const state = row?.state ?? null;
    const result = row?.result ?? {};
    switch (state) {
      case 'resolved':
        if (result.decision === 'reject') return { status: 'rejected', choiceIds: [], text: null };
        return {
          status: 'answered',
          choiceIds: Array.isArray(result.choiceIds) ? result.choiceIds : [],
          text: typeof result.text === 'string' ? result.text : null,
        };
      case 'rejected':
        return { status: 'rejected', choiceIds: [], text: null };
      case 'cancelled':
        return { status: 'cancelled', choiceIds: [], text: null };
      case 'uncertain':
        return { status: 'uncertain', choiceIds: [], text: null };
      case 'expired':
      default:
        return { status: 'expired', choiceIds: [], text: null };
    }
  }

  /**
   * ask_user DTO: {prompt,choices,multiple?,allowText?,timeoutMs?} -> {status,choiceIds,text}.
   * Opens one durable `question` interaction and waits for a single winner.
   */
  async function askUser(input, ctx = {}) {
    requireRunning('ask_user');
    const scope = trustedScope(ctx);
    const prompt = input?.prompt;
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      throw new DomainError('VALIDATION', 'ask_user requires a non-empty prompt');
    }
    const choices = Array.isArray(input?.choices) ? input.choices : [];
    const multiple = input?.multiple === true;
    const allowText = input?.allowText !== false;
    if (choices.length === 0 && allowText !== true) {
      throw new DomainError('VALIDATION', 'ask_user requires at least one choice or allowText');
    }
    const timeoutMs = Number.isInteger(input?.timeoutMs) && input.timeoutMs > 0
      ? Math.min(input.timeoutMs, LIMITS.INTERACTION_TTL_MS)
      : LIMITS.INTERACTION_TTL_MS;
    const at = now();
    const deadline = at + timeoutMs;
    const interactionId = newId();
    await commit(store, null, (draft) => {
      openInteraction(draft, {
        id: interactionId,
        type: 'question',
        sessionId: scope.sessionId,
        turnId: idOf(ctx.turnId),
        hostRef: `${bootId}:${newId()}`,
        prompt,
        choices,
        multiple,
        allowText,
        expiresAt: deadline,
      }, { now: at, newId });
      return null;
    });
    const row = await waitForTerminal(interactionId, { deadline, signal: ctx.signal ?? null });
    if (row !== null && !TERMINAL_INTERACTION_STATES.has(row.state)) {
      await commit(store, null, (draft) => {
        expireInteractions(draft, { now: now() });
        return null;
      }).catch((error) => warn(`ask_user expiry failed: ${error?.code ?? error?.message ?? 'error'}`));
    }
    return askOutcome(store.snapshot().interactions[interactionId] ?? row);
  }

  // -------------------------------------------------------------------------
  // public facade (ctx.provide('notifierV1', facade))
  // -------------------------------------------------------------------------

  const facade = Object.freeze({
    version: 1,
    isReady: () => state === 'running' && health().status === 'ready',
    health: () => health(),
    getCapabilities: () => ({ apiVersion: 1, notify: state === 'running', host: hostSeams }),
    notify: (input) => {
      requireRunning('notifierV1.notify');
      return manager.sendNotification({
        requestId: resolveRequestId(input?.requestId, null),
        title: input?.title ?? '',
        text: input?.text,
        level: input?.level,
        destinationIds: input?.destinationIds,
      }, { actor: { kind: 'local-owner', id: 'notifierV1' } });
    },
  });

  return {
    facade,
    host,
    projection,
    network,
    get state() { return state; },
    get store() { return store; },
    get manager() { return manager; },
    get bootId() { return bootId; },
    health,
    diagnostics: () => ({
      status: state,
      code: state === 'degraded' ? (degraded?.code ?? 'DEGRADED') : null,
      detail: degraded?.detail ?? null,
      storeReady: store !== null,
      seams: hostSeams,
    }),
    getCapabilities: () => ({ apiVersion: 1, seams: hostSeams, health: health() }),
    registerDisposer,
    notify,
    notifyTest,
    askUser,
    start,
    stop,
    dispose,
  };
}
