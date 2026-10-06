// RPC router (T27; 03-SERVICES-RPC.md, 02-DATA.md, 05-HOST-CLI.md,
// 14-UX-API-ADDENDUM.md, spec/RPC-METHODS.json).
//
// One dispatch table implements EVERY method in the frozen spec: the 36
// native-and-local methods plus the 3 loopback-only methods (backup.create,
// import.preview, import.apply). The router owns four cross-cutting concerns and
// delegates all business rules to an injectable service bag (which defaults to
// the existing service modules):
//
//  1. Authentication — the actor may only come from the adapter (the loopback
//     Bearer => local-owner). A payload can never declare its own identity; an
//     unknown `actor`-like field is rejected by the strict schema.
//  2. Schema validation — every method validates its payload explicitly
//     (unknown fields, types, lengths, enums) BEFORE a service is called.
//  3. Idempotency — write methods require a UUID requestId; the key is
//     [actorKind,actorId,method,requestId] and the hash covers the method plus
//     the normalized business payload (02-DATA.md). Same key + same hash returns
//     the stored, already-redacted result; a different hash is a CONFLICT whose
//     details carry only currentRevision. Sensitive-once methods (pairing.issue,
//     login.start) answer a replay with ALREADY_HANDLED and persist no plaintext.
//  4. Cancellation — ctx.signal is threaded to every service and host call.
//
// Errors become the frozen envelope { code, message, details }; success becomes
// { data, storeRevision, surfaceVersion }.
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DomainError, validationError, notFound, conflict, unsupported } from '../domain/errors.mjs';
import { LIMITS, codepointLength } from '../domain/limits.mjs';
import { commit } from '../storage/store.mjs';
import { redactText } from '../security/redact.mjs';
import { descriptors } from '../domain/descriptors.mjs';
import {
  beginRequest, completeRequest, markRequestUncertain, requestKeyOf, requestHashOf,
} from '../services/effects.mjs';
import {
  paginate, filterHash, listAccounts, getAccount, createAccount, updateAccount, removeAccount,
  directionComplete,
} from '../services/accounts.mjs';
import {
  listDestinations, createDestination, updateDestination, removeDestination,
} from '../services/destinations.mjs';
import { listPrincipals, updatePrincipal, removePrincipal } from '../services/principals.mjs';
import { issuePairing, revokePairing } from '../services/pairing.mjs';
import { listInteractions, settleInteraction, INTERACTION_STATES, INTERACTION_TYPES } from '../services/interactions.mjs';
import { listActivity } from '../services/activity.mjs';
import { listRoutes, saveRoute, removeRoute } from '../services/routes.mjs';
import { getSettings, updateSettings } from '../services/settings.mjs';
import { buildDiagnostics } from '../services/diagnostics.mjs';
import { testNotification } from '../services/notifications.mjs';
import { createConnection } from '../services/connections.mjs';
import { setBinding } from '../services/conversation.mjs';
import { previewImport, applyImport } from '../services/import.mjs';
import { createBackup } from '../storage/backup.mjs';
import { createLoginManager } from '../runtime/login-manager.mjs';
import { getChannelProvider } from '../providers/registry.mjs';

export const RPC_VERSION = 3;
export const DEFAULT_PAGE_LIMIT = 50;

const KINDS = Object.freeze(['private', 'group', 'local', 'endpoint']);
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOST_PAGE_FILTER = 'host-list';

/** Error codes that prove the effect never reached an external system. */
const DEFINITIVE_CODES = new Set([
  'VALIDATION', 'NOT_FOUND', 'CONFLICT', 'FORBIDDEN', 'EXPIRED', 'ALREADY_HANDLED',
  'CAPACITY', 'UNSUPPORTED', 'NOT_READY',
]);

// ---------------------------------------------------------------------------
// schema DSL
// ---------------------------------------------------------------------------

const S = {
  str: (opts = {}) => ({ type: 'string', ...opts }),
  id: (opts = {}) => ({ type: 'string', id: true, ...opts }),
  int: (opts = {}) => ({ type: 'integer', ...opts }),
  bool: (opts = {}) => ({ type: 'boolean', ...opts }),
  enum: (values, opts = {}) => ({ type: 'string', enum: values, ...opts }),
  obj: (fields, opts = {}) => ({ type: 'object', fields, ...opts }),
  loose: (opts = {}) => ({ type: 'object', loose: true, ...opts }),
  arr: (item, opts = {}) => ({ type: 'array', item, ...opts }),
};

const PAGING = Object.freeze({
  limit: S.int({ min: 1, max: 100 }),
  cursor: S.str({ minLen: 1, maxLen: 4096 }),
});

const SECRET_CHANGES = S.arr(
  S.obj({
    path: S.str({ minLen: 1, maxLen: 200, required: true }),
    op: S.enum(['set', 'clear'], { required: true }),
    value: S.loose(),
  }),
  { maxItems: 200 },
);

function validateValue(path, spec, value, errors) {
  if (value === undefined) {
    if (spec.required === true) errors.push(`${path}: required`);
    return;
  }
  if (value === null) {
    if (spec.nullable !== true) errors.push(`${path}: must not be null`);
    return;
  }
  switch (spec.type) {
    case 'string': {
      if (typeof value !== 'string') { errors.push(`${path}: expected string`); return; }
      if (spec.enum !== undefined && !spec.enum.includes(value)) errors.push(`${path}: must be one of ${spec.enum.join('|')}`);
      const len = codepointLength(value);
      if (spec.minLen !== undefined && len < spec.minLen) errors.push(`${path}: must be at least ${spec.minLen} characters`);
      if (spec.maxLen !== undefined && len > spec.maxLen) errors.push(`${path}: must be at most ${spec.maxLen} characters`);
      if (spec.len !== undefined && len !== spec.len) errors.push(`${path}: must be exactly ${spec.len} characters`);
      if (spec.id === true && !ID_RE.test(value)) errors.push(`${path}: must be a non-empty opaque id`);
      return;
    }
    case 'integer': {
      if (!Number.isInteger(value)) { errors.push(`${path}: expected integer`); return; }
      if (spec.min !== undefined && value < spec.min) errors.push(`${path}: must be >= ${spec.min}`);
      if (spec.max !== undefined && value > spec.max) errors.push(`${path}: must be <= ${spec.max}`);
      return;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') errors.push(`${path}: expected boolean`);
      return;
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) { errors.push(`${path}: expected object`); return; }
      if (spec.loose === true) return;
      const fields = spec.fields ?? {};
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(fields, key)) errors.push(`${path}.${key}: unknown field`);
      }
      for (const [key, child] of Object.entries(fields)) validateValue(`${path}.${key}`, child, value[key], errors);
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) { errors.push(`${path}: expected array`); return; }
      if (spec.maxItems !== undefined && value.length > spec.maxItems) errors.push(`${path}: at most ${spec.maxItems} items`);
      if (spec.minItems !== undefined && value.length < spec.minItems) errors.push(`${path}: at least ${spec.minItems} items`);
      if (spec.item) value.forEach((entry, index) => validateValue(`${path}[${index}]`, spec.item, entry, errors));
      return;
    }
    default:
      errors.push(`${path}: unknown schema`);
  }
}

function validatePayload(method, fields, payload) {
  const errors = [];
  for (const key of Object.keys(payload)) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) errors.push(`${key}: unknown field`);
  }
  for (const [key, spec] of Object.entries(fields)) validateValue(key, spec, payload[key], errors);
  if (errors.length > 0) throw validationError(`invalid payload for ${method}`, errors);
}

// ---------------------------------------------------------------------------
// helpers shared by the default services
// ---------------------------------------------------------------------------

function nowOf(ctx) {
  return Number.isInteger(ctx?.now) ? ctx.now : Date.now();
}

function svcCtx(c) {
  return {
    now: nowOf(c),
    newId: c.newId,
    signal: c.signal ?? null,
    actor: c.actor,
    network: c.network ?? null,
    expectedGlobalRevision: null,
  };
}

function paging(payload) {
  return { limit: payload.limit ?? DEFAULT_PAGE_LIMIT, cursor: payload.cursor ?? null };
}

function outboundComplete(account) {
  return directionComplete(account.channelId, 'outbound', account.config?.outbound, account.secrets);
}

function inboundComplete(account) {
  return directionComplete(account.channelId, 'inbound', account.config?.inbound, account.secrets);
}

/** Map a runtime connection state to the frozen transport enum. */
function transportOf(manager, account) {
  if (!manager || typeof manager.connectionView !== 'function') return 'disabled';
  const view = manager.connectionView(account.id);
  switch (view?.state) {
    case 'connecting': return 'connecting';
    case 'ready': return 'ready';
    case 'degraded': return 'degraded';
    case 'outbound': return account.notificationEnabled === true ? 'ready' : 'disabled';
    default: return 'disabled';
  }
}

function latestReceiptFor(state, accountId) {
  let latest = null;
  for (const receipt of Object.values(state.receipts ?? {})) {
    if (receipt.accountId !== accountId) continue;
    if (latest === null || receipt.createdAt > latest.createdAt) latest = receipt;
  }
  return latest === null ? null : structuredClone(latest);
}

function hostSnapshotVersion(ids) {
  return createHash('sha256').update(ids.join('\u0000')).digest('hex').slice(0, 16);
}

function encodeHostCursor(after, snapshotVersion) {
  return Buffer.from(JSON.stringify({ sortValues: [after], filterHash: HOST_PAGE_FILTER, snapshotVersion }), 'utf8')
    .toString('base64url');
}

/**
 * Paginate a Host list by id with a snapshot version so a changed Host snapshot is
 * a CONFLICT (03: "Host列表按id并带snapshotVersion").
 */
function paginateHost(items, { limit, cursor }) {
  const rows = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const snapshotVersion = hostSnapshotVersion(rows.map((row) => row.id));
  let start = 0;
  if (cursor !== null && cursor !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    } catch {
      throw validationError('invalid cursor');
    }
    if (parsed?.filterHash !== HOST_PAGE_FILTER) throw validationError('cursor does not match this list');
    if (parsed.snapshotVersion !== snapshotVersion) {
      throw conflict('the Host list changed', { currentRevision: parsed.snapshotVersion ?? null });
    }
    const after = Array.isArray(parsed.sortValues) ? parsed.sortValues[0] : null;
    const index = rows.findIndex((row) => row.id === after);
    start = index === -1 ? rows.length : index + 1;
  }
  const slice = rows.slice(start, start + limit);
  const nextCursor = start + limit < rows.length && slice.length > 0
    ? encodeHostCursor(slice[slice.length - 1].id, snapshotVersion)
    : null;
  return { items: slice, nextCursor, total: rows.length, snapshotVersion };
}

/** Build the accounts.health item for one account (03 "已合并的连接与运行时接口"). */
function accountHealthItem(state, account, manager, at) {
  const transport = transportOf(manager, account);
  const configuration = (account.notificationEnabled !== true || outboundComplete(account))
    && (account.controlEnabled !== true || inboundComplete(account))
    ? 'complete'
    : 'incomplete';
  const view = manager && typeof manager.connectionView === 'function' ? manager.connectionView(account.id) : null;
  const lastError = transport === 'degraded'
    ? { code: view?.errorCode ?? 'DEGRADED', message: 'channel connection is degraded', time: at }
    : null;
  const pairedPrincipalCount = Object.values(state.principals ?? {})
    .filter((principal) => principal.accountId === account.id)
    .length;
  return {
    accountId: account.id,
    configuration,
    notificationEnabled: account.notificationEnabled === true,
    controlEnabled: account.controlEnabled === true,
    transport,
    desiredRevision: account.revision,
    // The runtime reconnects asynchronously; the applied revision tracks the
    // desired one because a configuration change is only ever committed through
    // the account service (which the runtime reconcile then applies).
    appliedRevision: account.revision,
    lastError,
    lastReceipt: latestReceiptFor(state, account.id),
    pairedPrincipalCount,
  };
}

/** surface.home (14-UX-API-ADDENDUM.md, merged into 03). */
function surfaceHome(c) {
  const state = c.store.snapshot();
  const accounts = Object.values(state.accounts);
  const destinations = Object.values(state.destinations);
  const principals = Object.values(state.principals);
  const pending = Object.values(state.interactions).filter((i) => i.state === 'pending');

  const enabledDestinationReady = destinations.some((destination) => {
    const account = state.accounts[destination.accountId];
    return destination.enabled === true && account?.enabled === true
      && account.notificationEnabled === true && outboundComplete(account);
  });
  const notificationSetup = enabledDestinationReady
    ? 'ready'
    : destinations.length > 0 || accounts.some((a) => a.notificationEnabled === true)
      ? 'incomplete'
      : 'not-started';

  const pairedReady = principals.some((principal) => {
    const account = state.accounts[principal.accountId];
    return principal.enabled === true && account?.enabled === true
      && account.controlEnabled === true && inboundComplete(account);
  });
  const controlSetup = pairedReady
    ? 'ready'
    : accounts.some((a) => a.controlEnabled === true) || principals.length > 0
      ? 'incomplete'
      : 'not-started';

  const attention = [];
  for (const account of accounts) {
    const transport = transportOf(c.manager, account);
    if (transport === 'degraded') {
      attention.push({ kind: 'connection', accountId: account.id, title: account.label, nextAction: 'retry-connection' });
    } else if (account.notificationEnabled === true && !outboundComplete(account)) {
      attention.push({ kind: 'connection', accountId: account.id, title: account.label, nextAction: 'edit-connection' });
    } else if (account.controlEnabled === true && !inboundComplete(account)) {
      attention.push({ kind: 'connection', accountId: account.id, title: account.label, nextAction: 'edit-connection' });
    }
  }
  if (controlSetup === 'incomplete' && accounts.some((a) => a.controlEnabled === true)) {
    attention.push({ kind: 'identity', title: 'Pair a control identity', nextAction: 'pair-identity' });
  }
  for (const interaction of pending.slice(0, 20)) {
    attention.push({
      kind: 'interaction',
      interactionId: interaction.id,
      title: codepointLength(interaction.prompt) > 120 ? `${[...interaction.prompt].slice(0, 120).join('')}…` : interaction.prompt,
      nextAction: 'open-inbox',
    });
  }

  return {
    counts: {
      accounts: accounts.length,
      destinations: destinations.length,
      principals: principals.length,
    },
    health: c.projection ? c.projection.getHealth() : { status: 'unknown', code: null, detail: null },
    pendingCount: pending.length,
    recentActivity: listActivity(state, { limit: 20 }).items,
    setup: { notificationSetup, controlSetup },
    attention,
  };
}

/**
 * The default service bag. Every entry has the uniform (payload, ctx) -> data
 * signature so a test (or the UI controller) can override one method by name.
 */
function buildDefaultServices(deps) {
  const { store, host, projection, manager, login } = deps;
  const guards = {
    manager(what) {
      if (!manager || typeof manager[what] !== 'function') {
        throw unsupported('no runtime manager is available');
      }
      return manager;
    },
    login() {
      if (!login) throw unsupported('no login manager is available');
      return login;
    },
  };
  return {
    surface: {
      home: (payload, c) => surfaceHome(c),
      wait: (payload, c) => {
        if (!projection || typeof projection.wait !== 'function') throw unsupported('no projection is available');
        return projection.wait({
          afterVersion: payload.afterVersion,
          timeoutMs: payload.timeoutMs,
          signal: c.signal ?? null,
        });
      },
    },
    channels: {
      list: () => {
        const items = descriptors();
        return { items, total: items.length };
      },
    },
    accounts: {
      list: (p, c) => listAccounts(c.store, paging(p)),
      get: (p, c) => getAccount(c.store, { id: p.id }),
      create: (p, c) => createAccount(c.store, p, svcCtx(c)),
      update: (p, c) => updateAccount(c.store, p, svcCtx(c)),
      remove: (p, c) => removeAccount(c.store, p, svcCtx(c)),
      restart: async (p, c) => {
        const account = c.store.snapshot().accounts[p.id];
        if (!account) throw notFound('account not found');
        if (p.expectedRevision !== account.revision) {
          throw conflict('account revision changed', { currentRevision: account.revision });
        }
        const mgr = guards.manager('restartAccount');
        const view = await mgr.restartAccount(p.id);
        // The reconnect has been initiated; the settled state is read via
        // accounts.health (03: "仅重新连接，不增加配置revision").
        return { status: 'connecting', epoch: view?.epoch ?? null };
      },
      health: (p, c) => {
        const state = c.store.snapshot();
        const at = nowOf(c);
        const accounts = Object.values(state.accounts)
          .filter((account) => p.accountId === undefined || account.id === p.accountId);
        return { items: accounts.map((account) => accountHealthItem(state, account, manager, at)), updatedAt: at };
      },
    },
    destinations: {
      list: (p, c) => listDestinations(c.store, { accountId: p.accountId ?? null, ...paging(p) }),
      create: (p, c) => createDestination(c.store, p, svcCtx(c)),
      update: (p, c) => updateDestination(c.store, p, svcCtx(c)),
      remove: (p, c) => removeDestination(c.store, p, svcCtx(c)),
    },
    principals: {
      list: (p, c) => listPrincipals(c.store, { accountId: p.accountId ?? null, ...paging(p) }),
      update: (p, c) => updatePrincipal(c.store, p, svcCtx(c)),
      remove: (p, c) => removePrincipal(c.store, p, svcCtx(c)),
    },
    pairing: {
      issue: (p, c) => issuePairing(c.store, p, svcCtx(c)),
      revoke: (p, c) => revokePairing(c.store, p, svcCtx(c)),
    },
    interactions: {
      list: (p, c) => listInteractions(c.store, {
        state: p.state ?? 'pending',
        type: p.type ?? null,
        search: p.search ?? null,
        ...paging(p),
      }),
      settle: (p, c) => settleInteraction(c.store, { ...p, requestId: c.requestId }, {
        ...svcCtx(c),
        host: c.host ?? null,
      }),
    },
    host: {
      tasks: async (p, c) => {
        if (!host || typeof host.listTasks !== 'function') throw unsupported('no Host is available');
        return paginateHost(await host.listTasks(), paging(p));
      },
      sessions: async (p, c) => {
        if (!host || typeof host.listSessions !== 'function') throw unsupported('no Host is available');
        return paginateHost(await host.listSessions(), paging(p));
      },
    },
    bindings: {
      set: (p, c) => commit(c.store, null, (draft) => setBinding(draft, {
        principalId: p.principalId,
        sessionId: p.sessionId,
        now: nowOf(c),
      })),
    },
    routes: {
      list: (p, c) => listRoutes(c.store, paging(p)),
      save: (p, c) => saveRoute(c.store, p, svcCtx(c)),
      remove: (p, c) => removeRoute(c.store, p, svcCtx(c)),
    },
    activity: {
      list: (p, c) => {
        const state = c.store.snapshot();
        const filter = { accountId: p.accountId ?? null, status: p.status ?? null };
        const rows = state.activity
          .filter((item) => filter.accountId === null || item.accountId === filter.accountId)
          .filter((item) => filter.status === null || item.status === filter.status)
          .sort((a, b) => b.time - a.time || (a.id < b.id ? 1 : -1));
        return paginate(rows, filterHash(filter), paging(p));
      },
    },
    settings: {
      get: (p, c) => getSettings(c.store),
      update: (p, c) => updateSettings(c.store, p, svcCtx(c)),
    },
    diagnostics: {
      export: (p, c) => {
        const state = c.store.snapshot();
        return buildDiagnostics({
          version: { name: 'dsh-notifier', rpcVersion: RPC_VERSION },
          capabilities: { host: Boolean(host) },
          health: projection ? projection.getHealth() : 'unknown',
          counts: {
            accounts: Object.keys(state.accounts).length,
            destinations: Object.keys(state.destinations).length,
            principals: Object.keys(state.principals).length,
            interactions: Object.keys(state.interactions).length,
            receipts: Object.keys(state.receipts).length,
            activity: state.activity.length,
          },
          activity: state.activity,
          now: nowOf(c),
        });
      },
    },
    notifications: {
      test: (p, c) => testNotification(c.store, { requestId: c.requestId, destinationId: p.destinationId }, svcCtx(c)),
    },
    connections: {
      create: (p, c) => createConnection(c.store, p, svcCtx(c)),
    },
    login: {
      start: (p, c) => guards.login().start({ accountId: p.accountId }, { now: nowOf(c) }),
      status: (p, c) => guards.login().status({ loginId: p.loginId }),
      cancel: (p, c) => guards.login().cancel({ loginId: p.loginId }),
    },
    backup: {
      create: async (p, c) => {
        const created = await createBackup(c.store.dir, c.store, { now: nowOf(c) });
        const bytes = await readFile(created.path);
        return { path: created.path, sha256: createHash('sha256').update(bytes).digest('hex') };
      },
    },
    import: {
      preview: (p, c) => previewImport(c.store, { file: p.file }),
      apply: async (p, c) => {
        const result = await applyImport(c.store, { file: p.file, sourceHash: p.sourceHash }, svcCtx(c));
        return { imported: result.imported ?? 0, skipped: result.skipped ?? 0, failed: 0, reasons: [] };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// method table
// ---------------------------------------------------------------------------

const METHOD_TABLE = {
  // --- read -------------------------------------------------------------
  'surface.home': { write: false, fields: {}, run: (p, c) => c.services.surface.home(p, c) },
  'surface.wait': {
    write: false,
    fields: {
      afterVersion: S.obj({
        bootId: S.str({ minLen: 1, maxLen: 128, required: true }),
        sequence: S.int({ min: 0, required: true }),
      }, { required: true }),
      timeoutMs: S.int({ min: 0, max: LIMITS.SURFACE_WAIT_TIMEOUT_MS }),
    },
    run: (p, c) => c.services.surface.wait(p, c),
  },
  'channels.list': { write: false, fields: {}, run: (p, c) => c.services.channels.list(p, c) },
  'accounts.list': { write: false, fields: { ...PAGING }, run: (p, c) => c.services.accounts.list(p, c) },
  'accounts.get': {
    write: false,
    fields: { id: S.id({ required: true }) },
    run: (p, c) => c.services.accounts.get(p, c),
  },
  'destinations.list': {
    write: false,
    fields: { accountId: S.id(), ...PAGING },
    run: (p, c) => c.services.destinations.list(p, c),
  },
  'principals.list': {
    write: false,
    fields: { accountId: S.id(), ...PAGING },
    run: (p, c) => c.services.principals.list(p, c),
  },
  'interactions.list': {
    write: false,
    fields: {
      state: S.enum(INTERACTION_STATES),
      type: S.enum(INTERACTION_TYPES),
      search: S.str({ maxLen: 200 }),
      ...PAGING,
    },
    run: (p, c) => c.services.interactions.list(p, c),
  },
  'tasks.list': { write: false, fields: { ...PAGING }, run: (p, c) => c.services.host.tasks(p, c) },
  'sessions.list': { write: false, fields: { ...PAGING }, run: (p, c) => c.services.host.sessions(p, c) },
  'routes.list': { write: false, fields: { ...PAGING }, run: (p, c) => c.services.routes.list(p, c) },
  'activity.list': {
    write: false,
    fields: { accountId: S.id(), status: S.str({ maxLen: 64 }), ...PAGING },
    run: (p, c) => c.services.activity.list(p, c),
  },
  'settings.get': { write: false, fields: {}, run: (p, c) => c.services.settings.get(p, c) },
  'diagnostics.export': { write: false, fields: {}, run: (p, c) => c.services.diagnostics.export(p, c) },
  'login.status': {
    write: false,
    fields: { loginId: S.str({ minLen: 1, maxLen: 128, required: true }) },
    run: (p, c) => c.services.login.status(p, c),
  },
  'accounts.health': {
    write: false,
    fields: { accountId: S.id() },
    run: (p, c) => c.services.accounts.health(p, c),
  },

  // --- write (config / effect) ------------------------------------------
  'accounts.create': {
    write: true,
    kind: 'config',
    fields: {
      channelId: S.id({ required: true }),
      label: S.str({ minLen: 1, maxLen: LIMITS.MAX_NAME_CODEPOINTS, required: true }),
      enabled: S.bool(),
      config: S.loose(),
      secretChanges: SECRET_CHANGES,
      notificationEnabled: S.bool(),
      controlEnabled: S.bool(),
    },
    run: (p, c) => c.services.accounts.create(p, c),
  },
  'accounts.update': {
    write: true,
    kind: 'config',
    fields: {
      id: S.id({ required: true }),
      expectedRevision: S.int({ min: 0, required: true }),
      patch: S.obj({
        label: S.str({ minLen: 1, maxLen: LIMITS.MAX_NAME_CODEPOINTS }),
        enabled: S.bool(),
        notificationEnabled: S.bool(),
        controlEnabled: S.bool(),
        config: S.loose(),
      }),
      secretChanges: SECRET_CHANGES,
    },
    run: (p, c) => c.services.accounts.update(p, c),
  },
  'accounts.remove': {
    write: true,
    kind: 'config',
    fields: { id: S.id({ required: true }), expectedRevision: S.int({ min: 0, required: true }) },
    run: (p, c) => c.services.accounts.remove(p, c),
  },
  'accounts.restart': {
    write: true,
    kind: 'effect',
    fields: { id: S.id({ required: true }), expectedRevision: S.int({ min: 0, required: true }) },
    run: (p, c) => c.services.accounts.restart(p, c),
  },
  'destinations.create': {
    write: true,
    kind: 'config',
    fields: {
      accountId: S.id({ required: true }),
      label: S.str({ minLen: 1, maxLen: LIMITS.MAX_NAME_CODEPOINTS, required: true }),
      kind: S.enum(KINDS),
      target: S.loose(),
      secretChanges: SECRET_CHANGES,
    },
    run: (p, c) => c.services.destinations.create(p, c),
  },
  'destinations.update': {
    write: true,
    kind: 'config',
    fields: {
      id: S.id({ required: true }),
      expectedRevision: S.int({ min: 0, required: true }),
      patch: S.obj({
        label: S.str({ minLen: 1, maxLen: LIMITS.MAX_NAME_CODEPOINTS }),
        target: S.loose(),
        enabled: S.bool(),
      }),
      secretChanges: SECRET_CHANGES,
    },
    run: (p, c) => c.services.destinations.update(p, c),
  },
  'destinations.remove': {
    write: true,
    kind: 'config',
    fields: { id: S.id({ required: true }), expectedRevision: S.int({ min: 0, required: true }) },
    run: (p, c) => c.services.destinations.remove(p, c),
  },
  'notifications.test': {
    write: true,
    kind: 'effect',
    fields: { destinationId: S.id({ required: true }) },
    run: (p, c) => c.services.notifications.test(p, c),
  },
  'principals.update': {
    write: true,
    kind: 'config',
    fields: {
      id: S.id({ required: true }),
      expectedRevision: S.int({ min: 0, required: true }),
      patch: S.obj({
        enabled: S.bool(),
        role: S.enum(['owner', 'member']),
        canConverse: S.bool(),
        sessionIds: S.arr(S.id(), { maxItems: LIMITS.MAX_PRINCIPALS }),
      }),
    },
    run: (p, c) => c.services.principals.update(p, c),
  },
  'principals.remove': {
    write: true,
    kind: 'config',
    fields: { id: S.id({ required: true }), expectedRevision: S.int({ min: 0, required: true }) },
    run: (p, c) => c.services.principals.remove(p, c),
  },
  'pairing.issue': {
    write: true,
    kind: 'config',
    sensitiveOnce: true,
    fields: {
      accountId: S.id({ required: true }),
      role: S.enum(['owner', 'member']),
      canConverse: S.bool(),
    },
    run: (p, c) => c.services.pairing.issue(p, c),
  },
  'pairing.revoke': {
    write: true,
    kind: 'config',
    fields: { id: S.id({ required: true }) },
    run: (p, c) => c.services.pairing.revoke(p, c),
  },
  'interactions.settle': {
    write: true,
    kind: 'effect',
    fields: {
      id: S.id({ required: true }),
      expectedRevision: S.int({ min: 0, required: true }),
      decision: S.enum(['approve', 'reject', 'answer'], { required: true }),
      choiceIds: S.arr(S.str({ minLen: 1, maxLen: 128 }), { maxItems: 100 }),
      text: S.str({ maxLen: LIMITS.MAX_ANSWER_CODEPOINTS }),
    },
    run: (p, c) => c.services.interactions.settle(p, c),
  },
  'bindings.set': {
    write: true,
    kind: 'config',
    fields: { principalId: S.id({ required: true }), sessionId: S.id({ required: true }) },
    run: (p, c) => c.services.bindings.set(p, c),
  },
  'routes.save': {
    write: true,
    kind: 'config',
    fields: {
      id: S.id(),
      expectedRevision: S.int({ min: 0 }),
      scope: S.enum(['session', 'agent', 'workspace', 'global'], { required: true }),
      scopeId: S.id({ required: true }),
      destinationIds: S.arr(S.id(), { nullable: true, maxItems: LIMITS.MAX_DESTINATIONS }),
      quiet: S.bool({ nullable: true }),
    },
    run: (p, c) => c.services.routes.save(p, c),
  },
  'routes.remove': {
    write: true,
    kind: 'config',
    fields: { id: S.id({ required: true }), expectedRevision: S.int({ min: 0, required: true }) },
    run: (p, c) => c.services.routes.remove(p, c),
  },
  'settings.update': {
    write: true,
    kind: 'config',
    fields: {
      expectedRevision: S.int({ min: 0, required: true }),
      patch: S.obj({
        defaultDestinationIds: S.arr(S.id(), { maxItems: LIMITS.MAX_DESTINATIONS }),
        quiet: S.bool(),
        activityRetentionDays: S.int({
          min: LIMITS.ACTIVITY_RETENTION_MIN_DAYS,
          max: LIMITS.ACTIVITY_RETENTION_MAX_DAYS,
        }),
      }, { required: true }),
    },
    run: (p, c) => c.services.settings.update(p, c),
  },
  'login.start': {
    write: true,
    kind: 'effect',
    sensitiveOnce: true,
    fields: { accountId: S.id({ required: true }) },
    run: (p, c) => c.services.login.start(p, c),
  },
  'login.cancel': {
    write: true,
    kind: 'effect',
    fields: { loginId: S.str({ minLen: 1, maxLen: 128, required: true }) },
    run: (p, c) => c.services.login.cancel(p, c),
  },
  'connections.create': {
    write: true,
    kind: 'config',
    fields: {
      channelId: S.id({ required: true }),
      label: S.str({ minLen: 1, maxLen: LIMITS.MAX_NAME_CODEPOINTS, required: true }),
      config: S.loose(),
      secretChanges: SECRET_CHANGES,
      notificationEnabled: S.bool(),
      controlEnabled: S.bool(),
      destination: S.obj({
        label: S.str({ minLen: 1, maxLen: LIMITS.MAX_NAME_CODEPOINTS, required: true }),
        kind: S.enum(KINDS),
        target: S.loose(),
        secretChanges: SECRET_CHANGES,
      }, { required: true }),
      makeDefault: S.bool(),
    },
    run: (p, c) => c.services.connections.create(p, c),
  },

  // --- local-only -------------------------------------------------------
  'backup.create': { write: true, kind: 'effect', fields: {}, run: (p, c) => c.services.backup.create(p, c) },
  'import.preview': {
    write: false,
    fields: { file: S.str({ minLen: 1, maxLen: 4096, required: true }) },
    run: (p, c) => c.services.import.preview(p, c),
  },
  'import.apply': {
    write: true,
    kind: 'effect',
    fields: {
      file: S.str({ minLen: 1, maxLen: 4096, required: true }),
      sourceHash: S.str({ len: 64, required: true }),
    },
    run: (p, c) => c.services.import.apply(p, c),
  },
};

/** Frozen spec descriptions per method (write/read + sensitive-once). */
export const METHOD_SPECS = Object.freeze(Object.fromEntries(
  Object.entries(METHOD_TABLE).map(([name, entry]) => [name, Object.freeze({
    name,
    write: entry.write === true,
    sensitiveOnce: entry.sensitiveOnce === true,
    fields: entry.fields,
  })]),
));

export function methodNames() {
  return Object.keys(METHOD_TABLE);
}

function defaultLoginDriver(account) {
  const provider = getChannelProvider(account.channelId);
  return provider && typeof provider.loginDriver === 'function' ? provider.loginDriver() : null;
}

function mergeServices(defaults, injected) {
  const out = { ...defaults };
  for (const [key, value] of Object.entries(injected ?? {})) {
    if (key === 'manager' || key === 'login' || key === 'network' || key === 'stateDir') {
      out[key] = value;
      continue;
    }
    const base = out[key];
    out[key] = base && typeof base === 'object' && typeof value === 'object'
      ? { ...base, ...value }
      : (value ?? base);
  }
  return out;
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {import('../storage/store.mjs').Store} options.store
 * @param {object} [options.services] injected service bag; each namespace is merged
 *   over the real implementation so a single method can be spied on
 * @param {object|null} [options.host] HostPort
 * @param {object|null} [options.projection] read projection
 * @param {()=>number} [options.now]
 * @param {()=>string} [options.newId]
 * @param {object|null} [options.logger]
 */
export function createRpcRouter({
  store,
  services: injected = {},
  host = null,
  projection = null,
  now = Date.now,
  newId = randomUUID,
  logger = null,
} = {}) {
  if (!store || typeof store.snapshot !== 'function') {
    throw new DomainError('INTERNAL', 'createRpcRouter requires a Store');
  }
  const injectedServices = injected ?? {};
  const login = injectedServices.login
    ?? createLoginManager({ store, now, newId, resolveDriver: defaultLoginDriver });
  const manager = injectedServices.manager ?? null;

  const defaults = buildDefaultServices({
    store, host, projection, manager, login, network: injectedServices.network ?? null,
  });
  const services = mergeServices(defaults, injectedServices);
  services.network = injectedServices.network ?? null;
  services.stateDir = injectedServices.stateDir ?? store.dir ?? null;

  function warn(message) {
    try { logger?.warn?.(`[dsh-notifier/rpc] ${message}`); } catch { /* logging is never fatal */ }
  }

  function failure(error) {
    if (error instanceof DomainError) {
      const details = error.code === 'CONFLICT'
        ? { currentRevision: typeof error.details?.currentRevision === 'number' ? error.details.currentRevision : store.revision }
        : (error.details ?? null);
      return { code: error.code, message: redactText(error.message), details };
    }
    warn(`unexpected router error: ${redactText(String(error?.message ?? 'error'))}`);
    return { code: 'INTERNAL', message: 'internal error', details: null };
  }

  function success(data) {
    return {
      data: data ?? null,
      storeRevision: store.revision,
      surfaceVersion: projection ? projection.surfaceVersion() : { bootId: null, sequence: 0 },
    };
  }

  function requireActor(ctx) {
    const actor = ctx?.actor;
    if (!actor || typeof actor !== 'object' || typeof actor.kind !== 'string' || actor.kind === ''
      || typeof actor.id !== 'string' || actor.id === '') {
      throw new DomainError('FORBIDDEN', 'an authenticated local-owner actor is required');
    }
    return { kind: actor.kind, id: actor.id };
  }

  async function rollback(method, entry, actor, requestId, error) {
    const key = requestKeyOf(actor.kind, actor.id, method, requestId);
    const definitive = DEFINITIVE_CODES.has(error?.code);
    try {
      await commit(store, null, (draft) => {
        if (entry.kind === 'effect' && !definitive) {
          markRequestUncertain(draft, key, typeof error?.code === 'string' ? error.code : 'INTERNAL');
        } else {
          delete draft.requests[key];
        }
        return null;
      });
    } catch (rollbackError) {
      warn(`idempotency rollback failed for ${method}: ${rollbackError?.code ?? rollbackError?.message ?? 'error'}`);
    }
  }

  async function runWrite(method, entry, payload, actor, requestId, rctx) {
    const key = requestKeyOf(actor.kind, actor.id, method, requestId);
    const hash = requestHashOf(method, payload);
    const existing = store.snapshot().requests[key];
    if (existing) {
      // A replay is still re-authenticated and re-authorized above; here we only
      // decide whether it is the same request.
      if (existing.hash !== hash) {
        throw conflict('requestId was already used with a different payload', { currentRevision: store.revision });
      }
      if (entry.sensitiveOnce === true) {
        throw new DomainError('ALREADY_HANDLED', `${method} is single-use and has already been handled`);
      }
      if (existing.status === 'done') return existing.result;
      if (existing.status === 'uncertain') {
        throw new DomainError('UNCERTAIN', `${method} outcome could not be confirmed`);
      }
      throw conflict('the request is still in flight', { currentRevision: store.revision });
    }

    // Reserve the intent first, then execute, then record the result. An effect
    // that may have partially committed is marked uncertain on error and is never
    // replayed automatically.
    await commit(store, null, (draft) => {
      beginRequest(draft, {
        actor,
        method,
        requestId,
        payload,
        kind: entry.kind === 'effect' ? 'effect' : 'config',
        now: nowOf(rctx),
      });
      return null;
    });

    let data;
    try {
      data = await entry.run(payload, { ...rctx, requestId });
    } catch (error) {
      await rollback(method, entry, actor, requestId, error);
      throw error;
    }
    await commit(store, null, (draft) => {
      completeRequest(draft, key, entry.sensitiveOnce === true ? null : data, { now: nowOf(rctx) });
      return null;
    });
    return data;
  }

  async function handle(method, payload, ctx = {}) {
    const entry = METHOD_TABLE[method];
    if (!entry) return failure(notFound(`unknown RPC method: ${String(method)}`));
    try {
      const actor = requireActor(ctx);
      if (payload === null || payload === undefined || typeof payload !== 'object' || Array.isArray(payload)) {
        throw validationError('payload must be an object');
      }
      const rctx = {
        store,
        services,
        manager,
        login,
        network: services.network,
        host,
        projection,
        now,
        newId,
        logger,
        actor,
        signal: ctx.signal ?? null,
        requestId: null,
      };
      let data;
      if (entry.write === true) {
        const requestId = payload.requestId;
        if (typeof requestId !== 'string' || !UUID_RE.test(requestId)) {
          throw validationError(`${method} is a write and requires a UUID requestId`);
        }
        const business = { ...payload };
        delete business.requestId;
        validatePayload(method, entry.fields, business);
        data = await runWrite(method, entry, business, actor, requestId, rctx);
      } else {
        if (Object.prototype.hasOwnProperty.call(payload, 'requestId')) {
          throw validationError(`${method} is read-only and does not accept a requestId`);
        }
        validatePayload(method, entry.fields, payload);
        data = await entry.run(payload, rctx);
      }
      return success(data);
    } catch (error) {
      return failure(error);
    }
  }

  return {
    handle,
    methodNames,
    specs: METHOD_SPECS,
    services,
    get store() { return store; },
  };
}
