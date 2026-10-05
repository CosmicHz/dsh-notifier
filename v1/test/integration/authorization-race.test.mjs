// N01 authorization race: an identity revoked while its Host effect is queued, or
// disabled before the effect runs, must never reach the Host. Real handleInbound
// over an in-memory store; the arbiter is a controllable queue.
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
  upsertReplyContext(draft, { accountId: 'acc-1', userId: 'u-1', chatId: 'c-1', id: 'rc-1' }, { now: 1 });
  draft.principals['p-1'] = {
    id: 'p-1', revision: 0, accountId: 'acc-1', userId: 'u-1', role: 'member', canConverse: true,
    sessionIds: ['s-1'], enabled: true, replyContextId: 'rc-1', createdAt: 1, updatedAt: 1,
  };
  return draft;
}

const envelope = (o = {}) => ({
  kind: 'message', accountId: 'acc-1', userId: 'u-1', chatId: 'c-1',
  eventId: randomUUID(), epoch: 1, chatType: 'private', text: 'hello', ...o,
});

const collector = () => ({ controlReply: async () => ({ status: 'accepted' }) });

test('N01 race: revoking while /stop is queued never reaches the Host', async () => {
  const store = memoryStore(baseState());
  await store.transact(null, (d) => setBinding(d, { principalId: 'p-1', sessionId: 's-1', now: 5 }));
  let stopped = 0;
  const host = { async stop() { stopped += 1; return { stopped: true }; } };
  const arbiterFor = () => ({
    async stop(run) {
      // Revoked while the work sits in the queue, before it runs.
      await store.transact(null, (d) => { d.principals['p-1'].enabled = false; });
      return run();
    },
  });
  await assert.rejects(
    () => handleInbound(store, envelope({ text: '/stop' }), { host, ...collector(), now: 10, arbiterFor }),
    (e) => e.code === 'FORBIDDEN',
  );
  assert.equal(stopped, 0, 'the Host must not be called after revocation');
});

test('N01 race: a disabled identity cannot start a conversation', async () => {
  const state = baseState();
  state.principals['p-1'].enabled = false;
  const store = memoryStore(state);
  let submitted = 0;
  const host = {
    async getSession(id) { return { id, status: 'idle' }; },
    async submit() { submitted += 1; return { hostRef: 'h', turnId: 't' }; },
  };
  await assert.rejects(
    () => handleInbound(store, envelope({ text: 'hello' }), { host, ...collector(), now: 10, activeSessionIds: ['s-1'] }),
    (e) => e.code === 'FORBIDDEN' && /disabled/.test(e.message),
  );
  assert.equal(submitted, 0, 'a disabled identity never submits a turn');
});
