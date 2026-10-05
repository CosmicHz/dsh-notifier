// Routes service (02-DATA.md; 03-SERVICES-RPC.md routes.*).
// Route resolution order is session -> agent -> workspace -> global -> settings,
// for destinationIds and quiet independently. [] means an explicit stop.
import { DomainError, notFound, conflict, validationError } from '../domain/errors.mjs';
import { commit } from '../storage/store.mjs';
import { paginate, filterHash, requireId } from './accounts.mjs';
import { appendActivity } from './activity.mjs';

const SCOPES = ['session', 'agent', 'workspace', 'global'];

function nowOf(ctx) {
  return Number.isInteger(ctx?.now) ? ctx.now : Date.now();
}

function newIdOf(ctx) {
  return typeof ctx?.newId === 'function' ? ctx.newId() : globalThis.crypto.randomUUID();
}

function validateRouteFields(draft, input) {
  const errors = [];
  if (!SCOPES.includes(input?.scope)) errors.push(`scope must be one of ${SCOPES.join('|')}`);
  const scopeId = input?.scopeId;
  if (typeof scopeId !== 'string' || scopeId.length < 1 || scopeId.length > 128) errors.push('scopeId must be a non-empty id');
  if (input?.scope === 'global' && scopeId !== '*') errors.push("global scope requires scopeId '*'");
  let destinationIds = null;
  if (input?.destinationIds !== null && input?.destinationIds !== undefined) {
    if (!Array.isArray(input.destinationIds)) errors.push('destinationIds must be null or an id array');
    else {
      destinationIds = [...input.destinationIds];
      for (const id of destinationIds) {
        if (typeof id !== 'string' || !draft.destinations[id]) errors.push(`destinationIds: unknown destination ${id}`);
      }
    }
  }
  const quiet = input?.quiet === undefined ? null : input.quiet;
  if (quiet !== null && typeof quiet !== 'boolean') errors.push('quiet must be null or boolean');
  if (destinationIds === null && quiet === null) errors.push('at least one of destinationIds/quiet must be non-null');
  if (errors.length) throw validationError('invalid route', errors);
  return { destinationIds, quiet };
}

export function saveRoute(store, input, ctx = {}) {
  return commit(store, ctx.expectedGlobalRevision ?? null, (draft) => {
    const { destinationIds, quiet } = validateRouteFields(draft, input);
    const clash = Object.values(draft.routes).find(
      (route) => route.scope === input.scope && route.scopeId === input.scopeId && route.id !== input.id,
    );
    if (clash) throw conflict('a route already exists for this scope', { currentRevision: clash.revision });

    const now = nowOf(ctx);
    if (input.id) {
      const existing = draft.routes[input.id];
      if (!existing) throw notFound('route not found');
      if (input.expectedRevision !== existing.revision) {
        throw conflict('route revision changed', { currentRevision: existing.revision });
      }
      existing.scope = input.scope;
      existing.scopeId = input.scopeId;
      existing.destinationIds = destinationIds;
      existing.quiet = quiet;
      existing.revision += 1;
      existing.updatedAt = now;
      appendActivity(draft, { kind: 'route', status: 'updated' }, { now });
      return structuredClone(existing);
    }
    if (input.expectedRevision !== undefined && input.expectedRevision !== null) {
      throw validationError('expectedRevision is only valid when updating an existing route');
    }
    const route = {
      id: newIdOf(ctx),
      revision: 0,
      scope: input.scope,
      scopeId: input.scopeId,
      destinationIds,
      quiet,
      createdAt: now,
      updatedAt: now,
    };
    draft.routes[route.id] = route;
    appendActivity(draft, { kind: 'route', status: 'created' }, { now });
    return structuredClone(route);
  });
}

export function removeRoute(store, input, ctx = {}) {
  return commit(store, ctx.expectedGlobalRevision ?? null, (draft) => {
    const route = draft.routes[input?.id];
    if (!route) throw notFound('route not found');
    if (input.expectedRevision !== route.revision) {
      throw conflict('route revision changed', { currentRevision: route.revision });
    }
    delete draft.routes[route.id];
    appendActivity(draft, { kind: 'route', status: 'removed' }, { now: nowOf(ctx) });
    return { removed: true };
  });
}

export function listRoutes(store, { limit = 50, cursor = null } = {}) {
  const draft = store.snapshot();
  const rows = Object.values(draft.routes)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  const page = paginate(rows, filterHash({}), { limit, cursor });
  return { ...page, items: page.items.map((route) => structuredClone(route)) };
}

/**
 * Resolve the effective destination set and quiet flag for one turn scope.
 * destinationIds: first non-null route value, else settings.defaultDestinationIds;
 * quiet: first non-null route value, else settings.quiet.
 */
export function resolveRouteTargets(state, { sessionId = null, agentId = null, workspaceId = null } = {}) {
  const order = [
    ['session', sessionId],
    ['agent', agentId],
    ['workspace', workspaceId],
    ['global', '*'],
  ];
  const routes = state.routes ?? {};
  let destinationIds = null;
  let destinationSource = 'settings';
  let quiet = null;
  let quietSource = 'settings';
  for (const [scope, scopeId] of order) {
    if (scopeId === null && scope !== 'global') continue;
    for (const route of Object.values(routes)) {
      if (route.scope !== scope || route.scopeId !== scopeId) continue;
      if (destinationIds === null && route.destinationIds !== null) {
        destinationIds = [...route.destinationIds];
        destinationSource = scope;
      }
      if (quiet === null && route.quiet !== null) {
        quiet = route.quiet;
        quietSource = scope;
      }
    }
  }
  if (destinationIds === null) destinationIds = [...(state.settings?.defaultDestinationIds ?? [])];
  if (quiet === null) quiet = state.settings?.quiet === true;
  return { destinationIds, quiet, destinationSource, quietSource };
}

/**
 * Bind an inbound principal to exactly one session. Explicit binding wins; then a
 * single authorized active session; otherwise it refuses instead of guessing.
 */
export function resolveSessionForPrincipal(state, principalId, { activeSessionIds = null } = {}) {
  requireId(principalId, 'principalId');
  const principal = state.principals?.[principalId];
  if (!principal) throw notFound('principal not found');
  const active = activeSessionIds === null ? null : new Set(activeSessionIds);
  const authorized = (principal.sessionIds ?? []).filter((id) => active === null || active.has(id));
  const binding = state.bindings?.[principalId];
  if (binding && authorized.includes(binding.sessionId)) {
    return { sessionId: binding.sessionId, source: 'binding' };
  }
  if (authorized.length === 1) return { sessionId: authorized[0], source: 'only-session' };
  if (authorized.length === 0) {
    throw new DomainError('CONFLICT', 'no authorized session available');
  }
  throw new DomainError('CONFLICT', 'multiple sessions are authorized; use /sessions then /use');
}