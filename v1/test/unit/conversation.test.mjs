// T11: conversation routing + command authorization (W02/W15/W16, U05).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createEmptyState, validateState } from '../../src/domain/schema.mjs';
import { upsertReplyContext } from '../../src/services/reply-contexts.mjs';
import { issueReplyRef } from '../../src/services/reply-refs.mjs';
import { openInteraction } from '../../src/services/interactions.mjs';
import { reserveCorrelation } from '../../src/services/correlations.mjs';
import { createSessionArbiter } from '../../src/runtime/arbiter.mjs';
import { createFixtureHost } from '../fixtures/host.mjs';
import {
  parseCommand, authorizeCommand, classifyInbound, handleInbound, setBinding, COMMAND_LIST,
} from '../../src/services/conversation.mjs';

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
  upsertReplyContext(draft, { accountId: 'acc-1', userId: 'u-owner', chatId: 'c-owner', id: 'rc-owner' }, { now: 1 });
  draft.principals['p-owner'] = {
    id: 'p-owner', revision: 0, accountId: 'acc-1', userId: 'u-owner', role: 'owner', canConverse: true,
    sessionIds: ['s-1'], enabled: true, replyContextId: 'rc-owner', createdAt: 1, updatedAt: 1,
  };
  upsertReplyContext(draft, { accountId: 'acc-1', userId: 'u-member', chatId: 'c-member', id: 'rc-member' }, { now: 1 });
  draft.principals['p-member'] = {
    id: 'p-member', revision: 0, accountId: 'acc-1', userId: 'u-member', role: 'member', canConverse: true,
    sessionIds: ['s-1'], enabled: true, replyContextId: 'rc-member', createdAt: 1, updatedAt: 1,
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

function collector() {
  const replies = [];
  return { replies, controlReply: async (x) => { replies.push(x.content.text); return { status: 'accepted' }; } };
}

// --- parsing / authorization ------------------------------------------------

test('parseCommand extracts a lowercased command and its args', () => {
  assert.deepEqual(parseCommand('/USE  s-1'), { name: 'use', args: 's-1', raw: '/USE  s-1' });
  assert.equal(parseCommand('hello'), null);
  assert.equal(parseCommand('!steer now'), null);
  assert.deepEqual(parseCommand('/help'), { name: 'help', args: '', raw: '/help' });
});

test('W15 the command permission table fails closed by role', () => {
  const draft = baseState();
  const owner = draft.principals['p-owner'];
  const member = draft.principals['p-member'];
  // unpaired
  assert.equal(authorizeCommand(null, 'help'), 'unpaired');
  assert.equal(authorizeCommand(null, 'pair'), 'unpaired');
  assert.throws(() => authorizeCommand(null, 'status'), (e) => e.code === 'FORBIDDEN');
  // member
  assert.equal(authorizeCommand(member, 'route'), 'member');
  assert.throws(() => authorizeCommand(member, 'quiet'), (e) => e.code === 'FORBIDDEN');
  assert.throws(() => authorizeCommand(member, 'pair'), (e) => e.code === 'FORBIDDEN');
  assert.equal(authorizeCommand(member, 'unpair'), 'member');
  assert.throws(() => authorizeCommand(null, 'unpair'), (e) => e.code === 'FORBIDDEN');
  // owner
  assert.equal(authorizeCommand(owner, 'quiet'), 'owner');
  // unknown
  assert.throws(() => authorizeCommand(owner, 'nope'), (e) => e.code === 'NOT_FOUND');
  assert.ok(COMMAND_LIST.includes('stop'));
});

test('classifyInbound ignores a stale epoch and a group chat', () => {
  const draft = baseState();
  assert.equal(classifyInbound(draft, envelope({ epoch: 9 }), { epoch: 1 }).stale, true);
  assert.equal(classifyInbound(draft, envelope({ chatType: 'group' }), {}).group, true);
});

test('a group chat refuses every control path and sends no reply', async () => {
  const store = memoryStore(baseState());
  const { replies, controlReply } = collector();
  const out = await handleInbound(store, envelope({ chatType: 'group' }), { controlReply, now: 10 });
  assert.deepEqual(out, { handled: false, ignored: 'GROUP_CONTROL_DENIED' });
  assert.equal(replies.length, 0);
});

// --- followup / inject / steer ----------------------------------------------

test('U05 an idle private message is a followup with a persisted correlation', async () => {
  const store = memoryStore(baseState());
  const host = createFixtureHost();
  const { replies, controlReply } = collector();
  const out = await handleInbound(store, envelope({ text: 'do the thing' }), {
    host, controlReply, now: 10, arbiterFor: (sid) => createSessionArbiter({ sessionId: sid }),
  });
  assert.equal(out.kind, 'converse');
  assert.equal(out.mode, 'followup');
  const submitted = host.submitted.at(-1);
  assert.equal(submitted.mode, 'followup');
  assert.equal(submitted.sessionId, 's-1');
  assert.equal(submitted.text, 'do the thing');
  const correlations = Object.values(store.snapshot().correlations);
  assert.equal(correlations.length, 1);
  assert.equal(correlations[0].state, 'active');
  assert.equal(correlations[0].principalId, 'p-member');
  assert.equal(replies.length, 0); // no control reply for a plain turn
});

test('U05 a steer uses the ! prefix and reuses the in-flight turn', async () => {
  const store = memoryStore(baseState());
  const host = createFixtureHost();
  host.addSession({ id: 's-1', agentId: 'a', workspaceId: 'w', label: 'S', status: 'running' });
  // Seed the live correlation the busy session is attached to.
  await store.transact(null, (draft) => {
    const { correlation } = reserveCorrelation(draft, {
      accountId: 'acc-1', principalId: 'p-member', replyContextId: 'rc-member', sessionId: 's-1', requestId: randomUUID(),
    }, { now: 5 });
    correlation.state = 'active';
    correlation.hostRef = 'h-live';
    correlation.turnId = 't-live';
  });
  const { controlReply } = collector();
  const out = await handleInbound(store, envelope({ text: '!stop going that way' }), {
    host, controlReply, now: 10, arbiterFor: (sid) => createSessionArbiter({ sessionId: sid }),
  });
  assert.equal(out.mode, 'steer');
  assert.equal(host.submitted.at(-1).mode, 'steer');
  assert.equal(host.submitted.at(-1).text, 'stop going that way');
  assert.equal(Object.keys(store.snapshot().correlations).length, 1); // no new correlation
});

test('W02 a busy session without a unique live turn is a CONFLICT, never a guess', async () => {
  const store = memoryStore(baseState());
  const host = createFixtureHost();
  host.addSession({ id: 's-1', agentId: 'a', workspaceId: 'w', label: 'S', status: 'running' });
  const { controlReply } = collector();
  await assert.rejects(
    () => handleInbound(store, envelope({ text: 'queue this' }), {
      host, controlReply, now: 10, arbiterFor: (sid) => createSessionArbiter({ sessionId: sid }),
    }),
    (e) => e.code === 'CONFLICT',
  );
});

test('W02 another principal cannot attach to a session owned by someone else', async () => {
  const store = memoryStore(baseState());
  const host = createFixtureHost();
  host.addSession({ id: 's-1', agentId: 'a', workspaceId: 'w', label: 'S', status: 'running' });
  await store.transact(null, (draft) => {
    const { correlation } = reserveCorrelation(draft, {
      accountId: 'acc-1', principalId: 'p-owner', replyContextId: 'rc-owner', sessionId: 's-1', requestId: randomUUID(),
    }, { now: 5 });
    correlation.state = 'active';
  });
  const { controlReply } = collector();
  await assert.rejects(
    () => handleInbound(store, envelope({ userId: 'u-member', text: 'me too' }), {
      host, controlReply, now: 10, arbiterFor: (sid) => createSessionArbiter({ sessionId: sid }),
    }),
    (e) => e.code === 'CONFLICT',
  );
});

test('C04 /stop wins and cancels later work on the same session', async () => {
  const store = memoryStore(baseState());
  const host = createFixtureHost();
  const arbiter = createSessionArbiter({ sessionId: 's-1' });
  const { controlReply } = collector();
  await store.transact(null, (draft) => setBinding(draft, { principalId: 'p-member', sessionId: 's-1', now: 5 }));

  const stopped = await handleInbound(store, envelope({ text: '/stop' }), {
    host, controlReply, now: 10, arbiterFor: () => arbiter,
  });
  assert.equal(stopped.name, 'stop');
  await assert.rejects(
    () => handleInbound(store, envelope({ text: 'more work' }), {
      host, controlReply, now: 11, arbiterFor: () => arbiter,
    }),
    (e) => e.code === 'CANCELLED',
  );
});

// --- constrained session control --------------------------------------------

test('W15 /quiet is owner-only and only sets quiet on the bound session', async () => {
  const store = memoryStore(baseState());
  const host = createFixtureHost();
  const arbiterFor = (sid) => createSessionArbiter({ sessionId: sid });
  await store.transact(null, (draft) => setBinding(draft, { principalId: 'p-owner', sessionId: 's-1', now: 5 }));

  const { controlReply } = collector();
  await assert.rejects(
    () => handleInbound(store, envelope({ userId: 'u-member', chatId: 'c-member', text: '/quiet on' }), {
      host, controlReply, now: 10, arbiterFor,
    }),
    (e) => e.code === 'FORBIDDEN',
  );

  const out = await handleInbound(store, envelope({ userId: 'u-owner', chatId: 'c-owner', text: '/quiet on' }), {
    host, controlReply, now: 11, arbiterFor,
  });
  assert.equal(out.name, 'quiet');
  const route = Object.values(store.snapshot().routes)[0];
  assert.equal(route.scope, 'session');
  assert.equal(route.scopeId, 's-1');
  assert.equal(route.quiet, true);
  assert.equal(route.destinationIds, null);
});

test('W15 /route is read-only and reports the bound session path', async () => {
  const store = memoryStore(baseState());
  await store.transact(null, (draft) => setBinding(draft, { principalId: 'p-member', sessionId: 's-1', now: 5 }));
  const { replies, controlReply } = collector();
  const before = Object.keys(store.snapshot().routes).length;
  const out = await handleInbound(store, envelope({ text: '/route' }), { controlReply, now: 10 });
  assert.equal(out.name, 'route');
  assert.equal(Object.keys(store.snapshot().routes).length, before);
  assert.match(replies[0], /destinationIds=.*quiet=/);
});

test('U05 /use binds only an authorized session id', async () => {
  const store = memoryStore(baseState());
  const host = createFixtureHost();
  host.addSession({ id: 's-1', agentId: 'a', workspaceId: 'w', label: 'S1', status: 'idle' });
  host.addSession({ id: 's-2', agentId: 'a', workspaceId: 'w', label: 'S2', status: 'idle' });
  const arbiterFor = (sid) => createSessionArbiter({ sessionId: sid });
  const { controlReply } = collector();
  await assert.rejects(
    () => handleInbound(store, envelope({ text: '/use s-2' }), { host, controlReply, now: 10, arbiterFor }),
    (e) => e.code === 'FORBIDDEN',
  );
  const ok = await handleInbound(store, envelope({ text: '/use s-1' }), { host, controlReply, now: 11, arbiterFor });
  assert.equal(ok.name, 'use');
  assert.equal(store.snapshot().bindings['p-member'].sessionId, 's-1');
});

// --- unpaired gating --------------------------------------------------------

test('unpaired chat may only /help /whoami /pair; plain text is refused', async () => {
  const store = memoryStore(baseState());
  const { replies, controlReply } = collector();
  const help = await handleInbound(store, envelope({ userId: 'u-stranger', chatId: 'c-stranger', text: '/help' }), { controlReply, now: 10 });
  assert.equal(help.name, 'help');
  assert.match(replies[0], /\/pair/);
  assert.throws(() => authorizeCommand(null, 'tasks'), (e) => e.code === 'FORBIDDEN');
  await handleInbound(store, envelope({ userId: 'u-stranger', chatId: 'c-stranger', text: 'run rm -rf' }), { controlReply, now: 11 });
  assert.match(replies.at(-1), /pair this chat first/);
});

test('an unpaired /pair redeems through the injected pairing port', async () => {
  const store = memoryStore(baseState());
  const { replies, controlReply } = collector();
  const redeemed = [];
  const out = await handleInbound(store, envelope({ userId: 'u-new', chatId: 'c-new', text: '/pair ABC12345' }), {
    controlReply,
    now: 10,
    redeemPairing: async (input) => {
      redeemed.push(input);
      return { role: 'member' };
    },
  });
  assert.equal(out.paired, true);
  assert.equal(redeemed[0].code, 'ABC12345');
  assert.match(replies[0], /paired as member/);
});

// --- IM settle via explicit reference ---------------------------------------

test('an explicit /approve REF settles exactly one interaction (no free-text guessing)', async () => {
  const store = memoryStore(baseState());
  const host = createFixtureHost();
  let refId;
  await store.transact(null, (draft) => {
    const interaction = openInteraction(draft, {
      type: 'approval', sessionId: 's-1', hostRef: 'h-1', turnId: 't-1',
      prompt: 'Allow?', choices: [{ id: 'yes', label: 'Yes' }], expiresAt: 100000,
    }, { now: 10 });
    const { ref } = issueReplyRef(draft, {
      accountId: 'acc-1', principalId: 'p-member', replyContextId: 'rc-member',
      interactionId: interaction.id, action: 'approve', expiresAt: 100000,
    }, { now: 10 });
    refId = ref.id;
  });
  const { replies, controlReply } = collector();
  // A plain approval word is treated as conversation, never as an approval.
  const chatted = await handleInbound(store, envelope({ text: 'approve' }), { host, controlReply, now: 11 });
  assert.equal(chatted.kind, 'converse');
  assert.equal(Object.values(store.snapshot().interactions)[0].state, 'pending');
  const settled = await handleInbound(store, envelope({ text: `/approve ${refId}` }), { host, controlReply, now: 12 });
  assert.equal(settled.name, 'approve');
  assert.match(replies.at(-1), /resolved/);
  const interaction = Object.values(store.snapshot().interactions)[0];
  assert.equal(interaction.state, 'resolved');
  assert.equal(store.snapshot().replyRefs[refId].state, 'used');
});