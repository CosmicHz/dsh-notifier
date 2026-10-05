// R03: Test for session listing and stop authorization
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createEmptyState, validateState } from '../../src/domain/schema.mjs';
import { upsertReplyContext } from '../../src/services/reply-contexts.mjs';
import { handleInbound, setBinding } from '../../src/services/conversation.mjs';

function memoryStore(initial) {
  let state = initial;
  return {
    snapshot: () => structuredClone(state),
    async transact(expected, mutator) {
      if (expected !== null && expected !== state.revision) {
        const err = new Error('store revision changed');
        err.code = 'CONFLICT';
        throw err;
      }
      const draft = structuredClone(state);
      const value = mutator(draft);
      validateState(draft);
      draft.revision = state.revision + 1;
      state = draft;
      return { revision: state.revision, value };
    },
  };
}

function baseState() {
  const draft = createEmptyState();
  draft.accounts['acc-1'] = {
    id: 'acc-1', revision: 0, channelId: 'telegram', label: 'TG', enabled: true,
    notificationEnabled: true, controlEnabled: true, config: { outbound: {}, inbound: {} },
    secrets: {}, policyRevision: 1, createdAt: 1, updatedAt: 1,
  };

  // Owner with s-1
  upsertReplyContext(draft, { accountId: 'acc-1', userId: 'u-owner', chatId: 'c-owner', id: 'rc-owner' }, { now: 1 });
  draft.principals['p-owner'] = {
    id: 'p-owner', revision: 0, accountId: 'acc-1', userId: 'u-owner', role: 'owner', canConverse: true,
    sessionIds: ['s-1'], enabled: true, replyContextId: 'rc-owner', createdAt: 1, updatedAt: 1,
  };

  // Member with s-1 only
  upsertReplyContext(draft, { accountId: 'acc-1', userId: 'u-member', chatId: 'c-member', id: 'rc-member' }, { now: 1 });
  draft.principals['p-member'] = {
    id: 'p-member', revision: 0, accountId: 'acc-1', userId: 'u-member', role: 'member', canConverse: true,
    sessionIds: ['s-1'], enabled: true, replyContextId: 'rc-member', createdAt: 1, updatedAt: 1,
  };

  // Member with no canConverse
  upsertReplyContext(draft, { accountId: 'acc-1', userId: 'u-readonly', chatId: 'c-readonly', id: 'rc-readonly' }, { now: 1 });
  draft.principals['p-readonly'] = {
    id: 'p-readonly', revision: 0, accountId: 'acc-1', userId: 'u-readonly', role: 'member', canConverse: false,
    sessionIds: ['s-1'], enabled: true, replyContextId: 'rc-readonly', createdAt: 1, updatedAt: 1,
  };

  return draft;
}

function envelope(overrides = {}) {
  return {
    kind: 'message', accountId: 'acc-1', userId: 'u-member', chatId: 'c-member',
    eventId: randomUUID(), epoch: 1, chatType: 'private', text: 'hello',
    ...overrides,
  };
}

function createFixtureHost() {
  return {
    async listSessions() {
      return [{ id: 's-1' }, { id: 's-2' }, { id: 's-3' }];
    },
    async listTasks() {
      return [{ id: 't-1' }, { id: 't-2' }];
    },
    async stop({ sessionId }) {
      return { stopped: true };
    },
    async getSession(sessionId) {
      return { id: sessionId };
    },
  };
}

function collector() {
  const replies = [];
  return { replies, controlReply: async (x) => { replies.push(x.content.text); return { status: 'accepted' }; } };
}

// --- R03 Tests ---

test('R03: member /sessions only shows authorized sessions', async () => {
  const store = memoryStore(baseState());
  const host = createFixtureHost();
  const { controlReply, replies } = collector();

  await store.transact(null, (draft) => setBinding(draft, { principalId: 'p-member', sessionId: 's-1', now: 5 }));

  const result = await handleInbound(store, envelope({ text: '/sessions' }), {
    host, controlReply, now: 10,
  });

  assert.equal(result.name, 'sessions');
  // Member should only see s-1, not s-2 or s-3
  assert.match(replies[0], /s-1/);
  assert.doesNotMatch(replies[0], /s-2/);
  assert.doesNotMatch(replies[0], /s-3/);
});

test('R03: owner /sessions shows all sessions', async () => {
  const store = memoryStore(baseState());
  const host = createFixtureHost();
  const { controlReply, replies } = collector();

  await store.transact(null, (draft) => setBinding(draft, { principalId: 'p-owner', sessionId: 's-1', now: 5 }));

  const result = await handleInbound(store, envelope({ userId: 'u-owner', chatId: 'c-owner', text: '/sessions' }), {
    host, controlReply, now: 10,
  });

  assert.equal(result.name, 'sessions');
  // Owner should see all sessions
  assert.match(replies[0], /s-1/);
  assert.match(replies[0], /s-2/);
  assert.match(replies[0], /s-3/);
});

test('R03: canConverse=false cannot /stop', async () => {
  const store = memoryStore(baseState());
  const host = createFixtureHost();
  const { controlReply } = collector();

  await store.transact(null, (draft) => setBinding(draft, { principalId: 'p-readonly', sessionId: 's-1', now: 5 }));

  await assert.rejects(
    () => handleInbound(store, envelope({ userId: 'u-readonly', chatId: 'c-readonly', text: '/stop' }), {
      host, controlReply, now: 10,
    }),
    (e) => e.code === 'FORBIDDEN' && /canConverse/.test(e.message),
  );
});

test('R03: member cannot /stop unauthorized session', async () => {
  const store = memoryStore(baseState());
  const host = createFixtureHost();
  const { controlReply } = collector();

  // Member bound to s-2, but only authorized for s-1
  await store.transact(null, (draft) => {
    draft.bindings['p-member'] = { principalId: 'p-member', sessionId: 's-2', updatedAt: 5 };
  });

  await assert.rejects(
    () => handleInbound(store, envelope({ text: '/stop' }), {
      host, controlReply, now: 10,
    }),
    (e) => e.code === 'FORBIDDEN' && /not authorized/.test(e.message),
  );
});

test('R03: setBinding refuses unauthorized session for member', async () => {
  const store = memoryStore(baseState());
  const host = createFixtureHost();
  const { controlReply } = collector();

  // Member tries to /use s-2 which is not in their sessionIds
  await assert.rejects(
    () => handleInbound(store, envelope({ text: '/use s-2' }), {
      host, controlReply, now: 10,
    }),
    (e) => e.code === 'FORBIDDEN' && /not authorized/.test(e.message),
  );
});

test('R03: owner can /use any session', async () => {
  const store = memoryStore(baseState());
  const host = createFixtureHost();
  const { controlReply, replies } = collector();

  const result = await handleInbound(store, envelope({ userId: 'u-owner', chatId: 'c-owner', text: '/use s-2' }), {
    host, controlReply, now: 10,
  });

  assert.equal(result.name, 'use');
  assert.match(replies[0], /bound session=s-2/);
});

// --- N01 additions -------------------------------------------------------

test('N01: member /tasks filters by TaskView.sessionId, not the task id', async () => {
  const store = memoryStore(baseState());
  const host = {
    async listSessions() { return [{ id: 's-1' }, { id: 's-2' }]; },
    async listTasks() {
      // t-1 belongs to the authorized s-1; the second task's *id* collides with
      // s-1 but its sessionId (s-9) is not authorized — it must not leak.
      return [{ id: 't-1', sessionId: 's-1' }, { id: 's-1', sessionId: 's-9' }];
    },
    async stop() { return { stopped: true }; },
    async getSession(id) { return { id }; },
  };
  const { controlReply, replies } = collector();
  await handleInbound(store, envelope({ text: '/tasks' }), { host, controlReply, now: 10 });
  assert.match(replies[0], /t-1/);
  assert.doesNotMatch(replies[0], /s-9/);
  assert.doesNotMatch(replies[0], /s-1/, 'the colliding task id must not appear either');
});

test('N01: an owner with no declared scope resolves the single host session', async () => {
  const state = baseState();
  state.principals['p-owner'].sessionIds = [];
  const store = memoryStore(state);
  const submitted = [];
  const host = {
    async listSessions() { return [{ id: 's-only' }]; },
    async getSession(id) { return { id, status: 'idle' }; },
    async submit(x) { submitted.push(x); return { hostRef: 'h-1', turnId: 't-1' }; },
    async stop() { return { stopped: true }; },
  };
  const { controlReply } = collector();
  const result = await handleInbound(store, envelope({ userId: 'u-owner', chatId: 'c-owner', text: 'hello' }), {
    host, controlReply, now: 10, activeSessionIds: ['s-only'],
  });
  assert.equal(result.kind, 'converse');
  assert.equal(submitted[0].sessionId, 's-only');
});

test('N01: a disabled identity cannot /use, and re-enabling allows it', async () => {
  const store = memoryStore(baseState());
  const host = createFixtureHost();
  const { controlReply } = collector();
  await store.transact(null, (draft) => { draft.principals['p-member'].enabled = false; });
  await assert.rejects(
    () => handleInbound(store, envelope({ text: '/use s-1' }), { host, controlReply, now: 10 }),
    (e) => e.code === 'FORBIDDEN' && /disabled/.test(e.message),
  );
  await store.transact(null, (draft) => { draft.principals['p-member'].enabled = true; });
  const ok = await handleInbound(store, envelope({ text: '/use s-1' }), { host, controlReply, now: 10 });
  assert.equal(ok.name, 'use');
});
