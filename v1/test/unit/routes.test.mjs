// T07 routes: resolution priority (session > agent > workspace > global >
// settings), independent quiet inheritance, explicit stop, validation and
// session binding disambiguation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/storage/store.mjs';
import { DomainError } from '../../src/domain/errors.mjs';
import { createAccount } from '../../src/services/accounts.mjs';
import { createDestination } from '../../src/services/destinations.mjs';
import { saveRoute, removeRoute, listRoutes, resolveRouteTargets, resolveSessionForPrincipal } from '../../src/services/routes.mjs';

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-routes-'));
  const { store } = await openStore(dir);
  return store;
}

async function accountWithDestinations(store, count = 2) {
  const account = await createAccount(store, {
    channelId: 'telegram',
    label: 'TG',
    config: { outbound: {} },
    secretChanges: [{ path: 'outbound.botToken', op: 'set', value: { kind: 'literal', value: 'tok-1' } }],
    notificationEnabled: true,
  }, { now: 100 });
  const ids = [];
  for (let i = 0; i < count; i++) {
    const dest = await createDestination(store, {
      accountId: account.id, label: `d${i}`, target: { chatId: String(40 + i) },
    }, { now: 100 + i });
    ids.push(dest.id);
  }
  return { account, ids };
}

test('resolution picks the most specific route for destinations and quiet independently', () => {
  const state = {
    routes: {
      g: { id: 'g', scope: 'global', scopeId: '*', destinationIds: ['d1'], quiet: true },
      w: { id: 'w', scope: 'workspace', scopeId: 'w1', destinationIds: null, quiet: false },
      a: { id: 'a', scope: 'agent', scopeId: 'a1', destinationIds: ['d2'], quiet: null },
      s: { id: 's', scope: 'session', scopeId: 's1', destinationIds: ['d3'], quiet: null },
    },
    settings: { defaultDestinationIds: ['d9'], quiet: false },
  };
  const resolved = resolveRouteTargets(state, { sessionId: 's1', agentId: 'a1', workspaceId: 'w1' });
  assert.deepEqual(resolved.destinationIds, ['d3']);
  assert.equal(resolved.destinationSource, 'session');
  assert.equal(resolved.quiet, false, 'quiet falls through to the workspace route');
  assert.equal(resolved.quietSource, 'workspace');
});

test('an empty destination array is an explicit stop, not a fallback to settings', () => {
  const state = {
    routes: { g: { id: 'g', scope: 'global', scopeId: '*', destinationIds: [], quiet: null } },
    settings: { defaultDestinationIds: ['d9'], quiet: true },
  };
  const resolved = resolveRouteTargets(state, {});
  assert.deepEqual(resolved.destinationIds, [], '[] must stop the chain');
  assert.equal(resolved.destinationSource, 'global');
  assert.equal(resolved.quiet, true, 'quiet has no route value, so settings applies');
});

test('with no routes, resolution falls back to settings', () => {
  const state = { routes: {}, settings: { defaultDestinationIds: ['d9'], quiet: true } };
  const resolved = resolveRouteTargets(state, { sessionId: 's1' });
  assert.deepEqual(resolved.destinationIds, ['d9']);
  assert.equal(resolved.destinationSource, 'settings');
  assert.equal(resolved.quietSource, 'settings');
});

test('saveRoute enforces scope, target and uniqueness rules', async () => {
  const store = await freshStore();
  const { ids } = await accountWithDestinations(store);

  await assert.rejects(
    saveRoute(store, { scope: 'global', scopeId: '*', destinationIds: null, quiet: null }),
    (e) => e instanceof DomainError && e.code === 'VALIDATION',
    'a route needs at least one of destinationIds/quiet',
  );
  await assert.rejects(
    saveRoute(store, { scope: 'global', scopeId: '*', destinationIds: ['missing'], quiet: null }),
    (e) => e instanceof DomainError && e.code === 'VALIDATION',
  );
  await assert.rejects(
    saveRoute(store, { scope: 'global', scopeId: 'nope', destinationIds: [ids[0]], quiet: null }),
    (e) => e instanceof DomainError && e.code === 'VALIDATION',
  );

  const created = await saveRoute(store, { scope: 'global', scopeId: '*', destinationIds: [ids[0]], quiet: null }, { now: 200 });
  assert.equal(created.revision, 0);
  assert.deepEqual(created.destinationIds, [ids[0]]);

  await assert.rejects(
    saveRoute(store, { scope: 'global', scopeId: '*', destinationIds: [ids[1]], quiet: null }),
    (e) => e instanceof DomainError && e.code === 'CONFLICT',
  );

  const updated = await saveRoute(store, {
    id: created.id, scope: 'global', scopeId: '*', destinationIds: [ids[1]], quiet: true, expectedRevision: 0,
  });
  assert.equal(updated.revision, 1);
  assert.deepEqual(updated.destinationIds, [ids[1]]);
  assert.equal(updated.quiet, true);
  await assert.rejects(
    saveRoute(store, { id: created.id, scope: 'global', scopeId: '*', destinationIds: null, quiet: false, expectedRevision: 0 }),
    (e) => e instanceof DomainError && e.code === 'CONFLICT',
  );

  assert.equal(listRoutes(store).total, 1);
  assert.deepEqual(await removeRoute(store, { id: created.id, expectedRevision: 1 }), { removed: true });
  await assert.rejects(
    removeRoute(store, { id: created.id, expectedRevision: 1 }),
    (e) => e instanceof DomainError && e.code === 'NOT_FOUND',
  );
});

test('session binding: explicit wins, one authorized is used, ambiguity refuses', () => {
  const state = {
    principals: {
      p1: { id: 'p1', accountId: 'a1', sessionIds: ['s1', 's2'], enabled: true },
    },
    bindings: {},
  };
  assert.deepEqual(
    resolveSessionForPrincipal(state, 'p1', { activeSessionIds: ['s1'] }),
    { sessionId: 's1', source: 'only-session' },
  );
  assert.throws(
    () => resolveSessionForPrincipal(state, 'p1', { activeSessionIds: ['s1', 's2'] }),
    (e) => e instanceof DomainError && e.code === 'CONFLICT' && /multiple/.test(e.message),
  );
  assert.throws(
    () => resolveSessionForPrincipal(state, 'p1', { activeSessionIds: ['s9'] }),
    (e) => e instanceof DomainError && e.code === 'CONFLICT' && /no authorized/.test(e.message),
  );

  const bound = structuredClone(state);
  bound.bindings.p1 = { principalId: 'p1', sessionId: 's2', updatedAt: 1 };
  assert.deepEqual(
    resolveSessionForPrincipal(bound, 'p1', { activeSessionIds: ['s1', 's2'] }),
    { sessionId: 's2', source: 'binding' },
  );

  const stale = structuredClone(state);
  stale.bindings.p1 = { principalId: 'p1', sessionId: 's9', updatedAt: 1 };
  assert.deepEqual(
    resolveSessionForPrincipal(stale, 'p1', { activeSessionIds: ['s1'] }),
    { sessionId: 's1', source: 'only-session' },
    'a binding to an inactive session is ignored',
  );
  assert.throws(
    () => resolveSessionForPrincipal(state, 'ghost'),
    (e) => e instanceof DomainError && e.code === 'NOT_FOUND',
  );
});