// T27 RPC acceptance (03-SERVICES-RPC.md, 02-DATA.md, 05-HOST-CLI.md,
// 14-UX-API-ADDENDUM.md, spec/RPC-METHODS.json).
//
// A real Store on a temp dir + the in-memory Host fixture + a real loopback HTTP
// server. Covers the envelope shape, per-method schema rejection, authentication,
// idempotency, cancellation, the 1 MiB cap, pagination cursors (including the Host
// snapshot version), redaction, sensitive-once replay, and the connections/health/
// home/待办 contracts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/storage/store.mjs';
import { DomainError } from '../../src/domain/errors.mjs';
import { createProjection } from '../../src/runtime/projection.mjs';
import { filterHash } from '../../src/services/accounts.mjs';
import { createRpcRouter, METHOD_SPECS, methodNames } from '../../src/rpc/router.mjs';
import { createRpcServer, RPC_PATH, CONTROL_FILE } from '../../src/rpc/server.mjs';
import { createFixtureHost } from '../fixtures/host.mjs';

const ACTOR = Object.freeze({ kind: 'local-owner', id: 'local-owner' });

function uuid(n) {
  return `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

const NEXT_ACTIONS = new Set(['edit-connection', 'retry-connection', 'open-inbox', 'pair-identity']);
const SETUP_STATES = new Set(['not-started', 'incomplete', 'ready']);

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rpc-'));
  const { store } = await openStore(dir);
  return { dir, store };
}

function makeRouter(store, options = {}) {
  const projection = options.projection ?? createProjection({ bootId: 'boot-rpc', now: () => 1000 });
  const router = createRpcRouter({ store, projection, ...options });
  return { router, projection };
}

function call(router, method, payload, { actor = ACTOR, signal } = {}) {
  return router.handle(method, payload, { actor, signal });
}

/** A telegram account that is notification-ready, created through the real service. */
async function seedAccount(router, requestId, label = 'tg') {
  return call(router, 'accounts.create', {
    requestId,
    channelId: 'telegram',
    label,
    notificationEnabled: true,
    config: { outbound: {} },
    secretChanges: [{ path: 'outbound.botToken', op: 'set', value: { kind: 'literal', value: '"bot-token-value"' } }],
  });
}

// ---------------------------------------------------------------------------
// envelope
// ---------------------------------------------------------------------------

test('envelope: a read success carries data/storeRevision/surfaceVersion; unknown methods are NOT_FOUND', async () => {
  const { store } = await scratch();
  const { router } = makeRouter(store);

  const ok = await call(router, 'settings.get', {});
  assert.deepEqual(Object.keys(ok).sort(), ['data', 'storeRevision', 'surfaceVersion']);
  assert.equal(typeof ok.storeRevision, 'number');
  assert.deepEqual(Object.keys(ok.surfaceVersion).sort(), ['bootId', 'sequence']);
  assert.equal(ok.surfaceVersion.bootId, 'boot-rpc');
  assert.equal(ok.data.quiet, false);

  const missing = await call(router, 'no.such.method', {});
  assert.deepEqual(Object.keys(missing).sort(), ['code', 'details', 'message']);
  assert.equal(missing.code, 'NOT_FOUND');
  assert.equal(typeof missing.message, 'string');
  assert.equal(missing.details, null);
});

test('spec: the router implements exactly the 39 frozen methods', () => {
  assert.equal(methodNames().length, 39);
  assert.equal(Object.keys(METHOD_SPECS).length, 39);
  assert.equal(new Set(methodNames()).size, 39);
});

// ---------------------------------------------------------------------------
// per-method schema validation
// ---------------------------------------------------------------------------

function firstField(spec, predicate = () => true) {
  for (const [name, field] of Object.entries(spec.fields)) if (predicate(field)) return { name, field };
  return null;
}

function wrongValueFor(type) {
  switch (type) {
    case 'string': return 12345;
    case 'integer': return 'not-an-integer';
    case 'boolean': return 'yes';
    case 'object': return 'not-an-object';
    case 'array': return 'not-an-array';
    default: return 12345;
  }
}

test('schema: every method rejects an unknown field with VALIDATION', async () => {
  const { store } = await scratch();
  const { router } = makeRouter(store);
  for (const name of methodNames()) {
    const spec = METHOD_SPECS[name];
    const payload = spec.write ? { requestId: uuid(1), unexpectedField: 1 } : { unexpectedField: 1 };
    const res = await call(router, name, payload);
    assert.equal(res.code, 'VALIDATION', `${name} should reject an unknown field (got ${JSON.stringify(res)})`);
  }
});

test('schema: every method with fields rejects a wrong type with VALIDATION', async () => {
  const { store } = await scratch();
  const { router } = makeRouter(store);
  for (const name of methodNames()) {
    const spec = METHOD_SPECS[name];
    const chosen = firstField(spec);
    if (chosen === null) continue; // e.g. channels.list has an empty schema
    const payload = spec.write
      ? { requestId: uuid(1), [chosen.name]: wrongValueFor(chosen.field.type) }
      : { [chosen.name]: wrongValueFor(chosen.field.type) };
    const res = await call(router, name, payload);
    assert.equal(res.code, 'VALIDATION', `${name}.${chosen.name} should reject a wrong type`);
  }
});

test('schema: every method rejects a missing required field with VALIDATION', async () => {
  const { store } = await scratch();
  const { router } = makeRouter(store);
  let covered = 0;
  for (const name of methodNames()) {
    const spec = METHOD_SPECS[name];
    if (firstField(spec, (f) => f.required === true) === null) continue;
    covered += 1;
    const payload = spec.write ? { requestId: uuid(1) } : {};
    const res = await call(router, name, payload);
    assert.equal(res.code, 'VALIDATION', `${name} should reject a missing required field`);
  }
  assert.ok(covered >= 20, 'most methods declare required fields');
});

test('schema: read methods never accept a requestId', async () => {
  const { store } = await scratch();
  const { router } = makeRouter(store);
  for (const name of methodNames()) {
    if (METHOD_SPECS[name].write) continue;
    const res = await call(router, name, { requestId: uuid(1) });
    assert.equal(res.code, 'VALIDATION', `${name} must reject a requestId`);
  }
});

test('schema: every write method requires a UUID requestId', async () => {
  const { store } = await scratch();
  const { router } = makeRouter(store);
  for (const name of methodNames()) {
    if (!METHOD_SPECS[name].write) continue;
    const empty = await call(router, name, {});
    assert.equal(empty.code, 'VALIDATION', `${name} without a requestId should be VALIDATION`);
    const bad = await call(router, name, { requestId: 'not-a-uuid' });
    assert.equal(bad.code, 'VALIDATION', `${name} with a malformed requestId should be VALIDATION`);
  }
});

// ---------------------------------------------------------------------------
// authentication
// ---------------------------------------------------------------------------

test('auth: an absent or malformed actor is FORBIDDEN', async () => {
  const { store } = await scratch();
  const { router } = makeRouter(store);
  assert.equal((await router.handle('settings.get', {}, {})).code, 'FORBIDDEN');
  assert.equal((await router.handle('settings.get', {}, { actor: { kind: 'local-owner' } })).code, 'FORBIDDEN');
  assert.equal((await router.handle('settings.get', {}, { actor: { kind: '', id: 'x' } })).code, 'FORBIDDEN');
});

test('auth: a payload cannot declare its own identity', async () => {
  const { store } = await scratch();
  const { router } = makeRouter(store);
  const res = await call(router, 'accounts.create', {
    requestId: uuid(1),
    channelId: 'telegram',
    label: 'evil',
    actor: { kind: 'im', id: 'attacker' },
  });
  assert.equal(res.code, 'VALIDATION');
  const list = await call(router, 'accounts.list', {});
  assert.equal(list.data.total, 0, 'the rejected write had no side effect');
});

// ---------------------------------------------------------------------------
// idempotency
// ---------------------------------------------------------------------------

test('idempotency: same requestId + same hash returns the stored result and runs once; a different hash is CONFLICT', async () => {
  const { store } = await scratch();
  let calls = 0;
  const services = {
    accounts: {
      create: async (payload) => {
        calls += 1;
        return { id: 'acc-spy', label: payload.label, revision: 0, secretFields: [], destinationCount: 0 };
      },
    },
  };
  const { router } = makeRouter(store, { services });

  const first = await call(router, 'accounts.create', { requestId: uuid(1), channelId: 'telegram', label: 'one' });
  assert.equal(first.data.id, 'acc-spy');
  assert.equal(calls, 1);

  const replay = await call(router, 'accounts.create', { requestId: uuid(1), channelId: 'telegram', label: 'one' });
  assert.deepEqual(replay.data, first.data);
  assert.equal(calls, 1, 'a replay does not re-execute the service');

  const changed = await call(router, 'accounts.create', { requestId: uuid(1), channelId: 'telegram', label: 'two' });
  assert.equal(changed.code, 'CONFLICT');
  assert.deepEqual(Object.keys(changed.details), ['currentRevision']);
  assert.equal(calls, 1, 'a conflicting replay never re-executes');

  const fresh = await call(router, 'accounts.create', { requestId: uuid(2), channelId: 'telegram', label: 'one' });
  assert.equal(fresh.data.id, 'acc-spy');
  assert.equal(calls, 2, 'a new requestId executes again');
});

// ---------------------------------------------------------------------------
// cancellation
// ---------------------------------------------------------------------------

test('cancel: an aborted surface.wait resolves changed=false', async () => {
  const { store } = await scratch();
  const { router } = makeRouter(store);
  const controller = new AbortController();
  const pending = call(router, 'surface.wait', {
    afterVersion: { bootId: 'boot-rpc', sequence: 0 },
    timeoutMs: 5000,
  }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  const res = await pending;
  assert.equal(res.data.changed, false);
});

test('cancel: the signal reaches the service and a cancelled effect becomes uncertain', async () => {
  const { store } = await scratch();
  let sawSignal = false;
  const services = {
    interactions: {
      settle: (payload, ctx) => {
        sawSignal = ctx.signal !== null && ctx.signal !== undefined;
        return new Promise((resolve, reject) => {
          const fail = () => reject(new DomainError('CANCELLED', 'aborted'));
          // The reserve commit runs first, so the abort may already have fired.
          if (ctx.signal.aborted) { fail(); return; }
          ctx.signal.addEventListener('abort', fail, { once: true });
        });
      },
    },
  };
  const { router } = makeRouter(store, { services });
  const controller = new AbortController();
  const pending = router.handle('interactions.settle', {
    id: 'i1', expectedRevision: 0, decision: 'approve', requestId: uuid(1),
  }, { actor: ACTOR, signal: controller.signal });
  setTimeout(() => controller.abort(), 25);
  const res = await pending;
  assert.equal(res.code, 'CANCELLED');
  assert.equal(sawSignal, true, 'ctx.signal is threaded to the service');
  const records = Object.values(store.snapshot().requests);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'uncertain', 'a possibly-partial effect is never silently replayed');
});

// ---------------------------------------------------------------------------
// pagination cursors
// ---------------------------------------------------------------------------

test('paging: a cursor built for a different filter is VALIDATION; garbage is VALIDATION; a real cursor pages forward', async () => {
  const { store } = await scratch();
  const { router } = makeRouter(store);
  await seedAccount(router, uuid(1), 'a');
  await seedAccount(router, uuid(2), 'b');

  const page1 = await call(router, 'accounts.list', { limit: 1 });
  assert.equal(page1.data.items.length, 1);
  assert.equal(page1.data.total, 2);
  assert.equal(typeof page1.data.nextCursor, 'string');
  const page2 = await call(router, 'accounts.list', { limit: 1, cursor: page1.data.nextCursor });
  assert.equal(page2.data.items.length, 1);
  assert.notEqual(page2.data.items[0].id, page1.data.items[0].id);

  const foreign = Buffer.from(JSON.stringify({ after: 'x', f: filterHash({ accountId: 'B' }) }), 'utf8').toString('base64url');
  const wrongFilter = await call(router, 'destinations.list', { accountId: 'A', cursor: foreign });
  assert.equal(wrongFilter.code, 'VALIDATION');

  const garbage = await call(router, 'destinations.list', { cursor: '!!!not-a-cursor' });
  assert.equal(garbage.code, 'VALIDATION');
});

// ---------------------------------------------------------------------------
// redaction + sensitive-once
// ---------------------------------------------------------------------------

test('redaction: no response ever contains a secret plaintext', async () => {
  const { store } = await scratch();
  const { router } = makeRouter(store);
  const secret = 'sup3r-secret-bot-token-value';
  const created = await call(router, 'accounts.create', {
    requestId: uuid(1),
    channelId: 'telegram',
    label: 'red',
    notificationEnabled: true,
    config: { outbound: {} },
    secretChanges: [{ path: 'outbound.botToken', op: 'set', value: { kind: 'literal', value: JSON.stringify(secret) } }],
  });
  assert.equal(created.code, undefined);
  assert.ok(created.data.secretFields.some((f) => f.path === 'outbound.botToken' && f.configured === true));
  assert.ok(!JSON.stringify(created).includes(secret));
  assert.ok(!('secrets' in created.data));

  const got = await call(router, 'accounts.get', { id: created.data.id });
  const listed = await call(router, 'accounts.list', {});
  assert.ok(!JSON.stringify(got).includes(secret));
  assert.ok(!JSON.stringify(listed).includes(secret));
});

test('sensitive-once: pairing.issue replays with ALREADY_HANDLED and never persists the plaintext', async () => {
  const { dir, store } = await scratch();
  const { router } = makeRouter(store);
  const account = await seedAccount(router, uuid(1));
  const first = await call(router, 'pairing.issue', { requestId: uuid(2), accountId: account.data.id });
  assert.equal(typeof first.data.code, 'string');
  assert.ok(first.data.code.length >= 6);
  assert.equal(typeof first.data.expiresAt, 'number');

  const replay = await call(router, 'pairing.issue', { requestId: uuid(2), accountId: account.data.id });
  assert.equal(replay.code, 'ALREADY_HANDLED');

  const raw = await readFile(join(dir, 'state.json'), 'utf8');
  assert.ok(!raw.includes(first.data.code), 'the pairing code is never stored in plaintext');
});

// ---------------------------------------------------------------------------
// connections / health / home / 待办 contracts
// ---------------------------------------------------------------------------

test('connections.create creates an account + destination, and surface.home reports the frozen shape', async () => {
  const { store } = await scratch();
  const { router } = makeRouter(store);
  const connection = await call(router, 'connections.create', {
    requestId: uuid(1),
    channelId: 'telegram',
    label: 'conn',
    notificationEnabled: true,
    secretChanges: [{ path: 'outbound.botToken', op: 'set', value: { kind: 'literal', value: '"tok"' } }],
    destination: { label: 'dm', kind: 'private', target: { chatId: '123' } },
    makeDefault: true,
  });
  assert.equal(connection.code, undefined);
  assert.equal(connection.data.account.label, 'conn');
  assert.equal(connection.data.destination.accountId, connection.data.account.id);

  const settings = await call(router, 'settings.get', {});
  assert.deepEqual(settings.data.defaultDestinationIds, [connection.data.destination.id]);

  const home = await call(router, 'surface.home', {});
  assert.equal(home.data.counts.accounts, 1);
  assert.equal(home.data.counts.destinations, 1);
  assert.equal(home.data.counts.principals, 0);
  assert.equal(home.data.pendingCount, 0);
  assert.equal(home.data.setup.notificationSetup, 'ready');
  assert.equal(home.data.setup.controlSetup, 'not-started');
  assert.ok(SETUP_STATES.has(home.data.setup.notificationSetup));
  assert.ok(SETUP_STATES.has(home.data.setup.controlSetup));
  assert.ok(Array.isArray(home.data.recentActivity));
  assert.ok(home.data.recentActivity.length <= 20);
  assert.ok(home.data.health && typeof home.data.health.status === 'string');
  for (const item of home.data.attention) {
    assert.equal(typeof item.kind, 'string');
    assert.equal(typeof item.title, 'string');
    assert.ok(NEXT_ACTIONS.has(item.nextAction), `unknown nextAction ${item.nextAction}`);
  }
});

test('surface.wait returns the current version, wakes on a change and honors a boot-id change', async () => {
  const { store } = await scratch();
  const { router, projection } = makeRouter(store);
  const pending = call(router, 'surface.wait', { afterVersion: { bootId: 'boot-rpc', sequence: 0 }, timeoutMs: 1000 });
  setTimeout(() => projection.invalidate('test'), 5);
  const woke = await pending;
  assert.equal(woke.data.changed, true);
  assert.ok(woke.data.surfaceVersion.sequence >= 1);

  const otherBoot = await call(router, 'surface.wait', { afterVersion: { bootId: 'other', sequence: 5 }, timeoutMs: 1000 });
  assert.equal(otherBoot.data.changed, true);
  assert.equal(otherBoot.data.surfaceVersion.bootId, 'boot-rpc');
});

test('accounts.health reports the frozen item shape and accounts.restart reports connecting', async () => {
  const { store } = await scratch();
  const manager = {
    connectionView: (id) => ({ accountId: id, state: 'ready', epoch: 'epoch-1', errorCode: null }),
    restartAccount: async (id) => ({ accountId: id, state: 'connecting', epoch: 'epoch-2', errorCode: null }),
  };
  const { router } = makeRouter(store, { services: { manager } });
  const account = await seedAccount(router, uuid(1));

  const health = await call(router, 'accounts.health', { accountId: account.data.id });
  assert.equal(health.data.items.length, 1);
  const item = health.data.items[0];
  assert.deepEqual(Object.keys(item).sort(), [
    'accountId', 'appliedRevision', 'configuration', 'controlEnabled', 'desiredRevision',
    'lastError', 'lastReceipt', 'notificationEnabled', 'pairedPrincipalCount', 'transport',
  ]);
  assert.equal(item.transport, 'ready');
  assert.equal(item.configuration, 'complete');
  assert.equal(item.notificationEnabled, true);
  assert.equal(item.controlEnabled, false);
  assert.equal(item.desiredRevision, item.appliedRevision);
  assert.equal(item.lastError, null);
  assert.equal(item.pairedPrincipalCount, 0);
  assert.equal(typeof health.data.updatedAt, 'number');

  const restart = await call(router, 'accounts.restart', {
    requestId: uuid(2), id: account.data.id, expectedRevision: 0,
  });
  assert.equal(restart.data.status, 'connecting');
  assert.equal(restart.data.epoch, 'epoch-2');

  const stale = await call(router, 'accounts.restart', {
    requestId: uuid(3), id: account.data.id, expectedRevision: 99,
  });
  assert.equal(stale.code, 'CONFLICT');
  assert.deepEqual(Object.keys(stale.details), ['currentRevision']);
});

test('tasks.list / sessions.list paginate by id with a snapshotVersion that turns a changed Host snapshot into CONFLICT', async () => {
  const { store } = await scratch();
  const host = createFixtureHost();
  host.addTask({ id: 't2', label: 'b', sessionId: 's1', status: 'idle' });
  host.addTask({ id: 't1', label: 'a', sessionId: 's1', status: 'idle' });
  host.addSession({ id: 's1', agentId: 'a', workspaceId: 'w', label: 'one', status: 'idle' });
  const { router } = makeRouter(store, { host });

  const page = await call(router, 'tasks.list', { limit: 1 });
  assert.deepEqual(page.data.items.map((t) => t.id), ['t1']);
  assert.equal(page.data.total, 2);
  assert.equal(typeof page.data.snapshotVersion, 'string');
  assert.equal(typeof page.data.nextCursor, 'string');

  const next = await call(router, 'tasks.list', { limit: 1, cursor: page.data.nextCursor });
  assert.deepEqual(next.data.items.map((t) => t.id), ['t2']);

  const foreign = Buffer.from(JSON.stringify({
    sortValues: ['t1'], filterHash: 'not-host-list', snapshotVersion: page.data.snapshotVersion,
  }), 'utf8').toString('base64url');
  assert.equal((await call(router, 'tasks.list', { cursor: foreign })).code, 'VALIDATION');

  host.addTask({ id: 't0', label: 'c', sessionId: 's1', status: 'idle' });
  const stale = await call(router, 'tasks.list', { limit: 1, cursor: page.data.nextCursor });
  assert.equal(stale.code, 'CONFLICT');

  const sessions = await call(router, 'sessions.list', {});
  assert.equal(sessions.data.total, 1);
  assert.equal(sessions.data.items[0].id, 's1');
});

test('host-backed methods degrade honestly without a Host', async () => {
  const { store } = await scratch();
  const { router } = makeRouter(store);
  assert.equal((await call(router, 'tasks.list', {})).code, 'UNSUPPORTED');
  assert.equal((await call(router, 'sessions.list', {})).code, 'UNSUPPORTED');
});

// ---------------------------------------------------------------------------
// loopback HTTP server
// ---------------------------------------------------------------------------

async function startServer(store, options = {}) {
  const { router } = makeRouter(store, options);
  const server = createRpcServer({ router, stateDir: options.stateDir ?? store.dir });
  await server.start();
  const address = server.address();
  return { server, router, url: `http://127.0.0.1:${address.port}${RPC_PATH}` };
}

function rpcFetch(url, token, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('server: a real loopback port, a 0600 token file, Bearer auth, GET denial and the 1 MiB cap', async () => {
  const { dir, store } = await scratch();
  const { server, url } = await startServer(store, { stateDir: dir });
  try {
    const control = JSON.parse(await readFile(join(dir, CONTROL_FILE), 'utf8'));
    assert.equal(control.port, server.address().port);
    assert.equal(control.token, server.token);
    assert.equal(control.pid, process.pid);
    assert.equal(server.token.length, 64, '32 random bytes as hex');

    const mode = (await stat(join(dir, CONTROL_FILE))).mode & 0o777;
    assert.equal(mode, 0o600);

    const noAuth = await rpcFetch(url, null, { method: 'settings.get', payload: {} });
    assert.equal(noAuth.status, 401);
    assert.equal((await noAuth.json()).code, 'FORBIDDEN');

    const wrong = await rpcFetch(url, 'deadbeef', { method: 'settings.get', payload: {} });
    assert.equal(wrong.status, 401);

    const getRes = await fetch(url, { method: 'GET' });
    assert.equal(getRes.status, 405);

    const ok = await rpcFetch(url, server.token, { method: 'settings.get', payload: {} });
    assert.equal(ok.status, 200);
    const envelope = await ok.json();
    assert.ok('data' in envelope && 'storeRevision' in envelope && 'surfaceVersion' in envelope);
    assert.equal(envelope.data.quiet, false);

    const big = 'x'.repeat(1024 * 1024 + 1024);
    const tooBig = await rpcFetch(url, server.token, { method: 'settings.get', payload: { note: big } });
    assert.equal(tooBig.status, 413);
    assert.equal((await tooBig.json()).code, 'VALIDATION');
  } finally {
    const before = store.revision;
    await server.stop();
    await server.stop(); // idempotent
    await assert.rejects(stat(join(dir, CONTROL_FILE)), 'the token file is removed on stop');
    assert.equal(store.revision, before);
    await assert.rejects(
      fetch(url, { method: 'GET' }),
      'the listener is closed',
    );
  }
});

test('server: a GET cannot mutate, and stop() is idempotent', async () => {
  const { dir, store } = await scratch();
  const { server, url } = await startServer(store, { stateDir: dir });
  const before = store.revision;
  await fetch(url, { method: 'GET', headers: { authorization: `Bearer ${server.token}` } });
  await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${server.token}` } });
  assert.equal(store.revision, before, 'no non-POST request touched the store');
  await server.stop();
  await server.stop();
});
