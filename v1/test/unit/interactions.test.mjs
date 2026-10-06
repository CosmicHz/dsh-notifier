// T10: interactions claim/settle/uncertain/restart (C01-C04).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createEmptyState, validateState } from '../../src/domain/schema.mjs';
import { LIMITS } from '../../src/domain/limits.mjs';
import { upsertReplyContext } from '../../src/services/reply-contexts.mjs';
import { issueReplyRef } from '../../src/services/reply-refs.mjs';
import { createFixtureHost } from '../fixtures/host.mjs';
import {
  openInteraction, claimInteraction, settleInteraction, listInteractions, getInteraction,
  interactionView, refreshInteractionTargets, cancelInteractionsForTurn, expireInteractions,
  reconcileInteractions, observeAllowed, INTERACTION_TYPES,
} from '../../src/services/interactions.mjs';

const UUID = '11111111-1111-4111-8111-111111111111';

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

function openedApproval(draft, overrides = {}) {
  return openInteraction(draft, {
    type: 'approval',
    sessionId: 's-1',
    hostRef: 'h-1',
    turnId: 't-1',
    prompt: 'Allow this action?',
    choices: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }],
    expiresAt: 1000,
    ...overrides,
  }, { now: 10 });
}

test('C01 a claimed interaction rejects a second claim (one Host execution)', () => {
  const draft = baseState();
  const interaction = openedApproval(draft);
  const first = claimInteraction(draft, {
    id: interaction.id, expectedRevision: 0, decision: 'approve', actor: { kind: 'local-owner' }, requestId: UUID,
  }, { now: 11 });
  assert.equal(first.interaction.state, 'claimed');
  assert.equal(draft.effects[first.effectId].kind, 'hostSettle');
  assert.equal(draft.effects[first.effectId].status, 'started');
  assert.throws(
    () => claimInteraction(draft, {
      id: interaction.id, expectedRevision: interaction.revision, decision: 'approve', actor: { kind: 'local-owner' }, requestId: UUID,
    }, { now: 12 }),
    (e) => e.code === 'CONFLICT',
  );
});

test('C01 Native and IM can both answer, but only one claim wins', () => {
  const draft = baseState();
  const interaction = openedApproval(draft);
  claimInteraction(draft, {
    id: interaction.id, expectedRevision: 0, decision: 'approve',
    actor: { kind: 'im', accountId: 'acc-1', principalId: 'p-member' }, requestId: UUID,
  }, { now: 11 });
  assert.throws(
    () => claimInteraction(draft, {
      id: interaction.id, expectedRevision: interaction.revision, decision: 'reject', actor: { kind: 'local-owner' }, requestId: UUID,
    }, { now: 12 }),
    (e) => e.code === 'CONFLICT',
  );
});

test('C02 an expired interaction can never be claimed', () => {
  const draft = baseState();
  const interaction = openedApproval(draft, { expiresAt: 20 });
  assert.throws(
    () => claimInteraction(draft, {
      id: interaction.id, expectedRevision: 0, decision: 'approve', actor: { kind: 'local-owner' }, requestId: UUID,
    }, { now: 25 }),
    (e) => e.code === 'EXPIRED',
  );
  const view = interactionView(draft, interaction, { now: 25 });
  assert.equal(view.canSettle, false);
  assert.equal(view.disabledReason, 'expired');
  const swept = expireInteractions(draft, { now: 25 });
  assert.equal(swept.expired, 1);
  assert.equal(interaction.state, 'expired');
});

test('C03 an uncertain Host result is unconfirmed and never replayed', async () => {
  const host = createFixtureHost();
  host.settleInteraction = async () => {
    const err = new Error('connection lost');
    err.code = 'NETWORK';
    throw err;
  };
  const store = memoryStore(baseState());
  const draft = store.snapshot();
  const interaction = openedApproval(draft);
  // Persist the opened interaction through the same store the service uses.
  await store.transact(null, (d) => { d.interactions[interaction.id] = interaction; });
  await assert.rejects(
    () => settleInteraction(store, {
      id: interaction.id, expectedRevision: 0, decision: 'approve', actor: { kind: 'local-owner' }, requestId: UUID,
    }, { host, now: 11 }),
    (e) => e.code === 'UNCERTAIN',
  );
  const after = store.snapshot().interactions[interaction.id];
  assert.equal(after.state, 'claimed');
  assert.equal(after.recovery, 'unconfirmed');

  const result = await reconcileInteractions(store.snapshot(), { host });
  assert.equal(result.uncertain, 1);
  // A second settle attempt is refused, not silently repeated.
  await assert.rejects(
    () => settleInteraction(store, {
      id: interaction.id, expectedRevision: after.revision, decision: 'approve', actor: { kind: 'local-owner' }, requestId: UUID,
    }, { host, now: 12 }),
    (e) => e.code === 'UNCERTAIN',
  );
});

test('C03 a Host already_handled is never upgraded into a success', async () => {
  const host = createFixtureHost();
  host.settleInteraction = async () => ({ status: 'already_handled' });
  const store = memoryStore(baseState());
  const draft = store.snapshot();
  const interaction = openedApproval(draft);
  await store.transact(null, (d) => { d.interactions[interaction.id] = interaction; });
  await assert.rejects(
    () => settleInteraction(store, {
      id: interaction.id, expectedRevision: 0, decision: 'approve', actor: { kind: 'local-owner' }, requestId: UUID,
    }, { host, now: 11 }),
    (e) => e.code === 'ALREADY_HANDLED',
  );
  const after = store.snapshot().interactions[interaction.id];
  assert.equal(after.state, 'uncertain');
  assert.equal(after.result.code, 'ALREADY_HANDLED');
});

test('C03 a successful settle records the terminal state and revokes other refs', async () => {
  const host = createFixtureHost();
  const store = memoryStore(baseState());
  const draft = store.snapshot();
  const interaction = openedApproval(draft);
  const { ref } = issueReplyRef(draft, {
    accountId: 'acc-1', principalId: 'p-owner', replyContextId: 'rc-owner',
    interactionId: interaction.id, action: 'approve', expiresAt: 900,
  }, { now: 10 });
  await store.transact(null, (d) => {
    d.interactions[interaction.id] = interaction;
    d.replyRefs[ref.id] = ref;
  });
  const out = await settleInteraction(store, {
    id: interaction.id, expectedRevision: 0, decision: 'approve', actor: { kind: 'local-owner' }, requestId: UUID,
  }, { host, now: 11 });
  assert.equal(out.state, 'resolved');
  const after = store.snapshot();
  assert.equal(after.replyRefs[ref.id].state, 'revoked');
  const settleEffects = Object.values(after.effects).filter((e) => e.kind === 'hostSettle');
  assert.equal(settleEffects[0].status, 'confirmed');
});

test('C03 restart: pending is queried, a claimed settle becomes uncertain', async () => {
  const draft = baseState();
  const kept = openedApproval(draft);
  const unconfirmed = openedApproval(draft, { hostRef: 'h-2' });
  claimInteraction(draft, {
    id: unconfirmed.id, expectedRevision: 0, decision: 'approve', actor: { kind: 'local-owner' }, requestId: UUID,
  }, { now: 11 });

  const host = {
    async queryInteraction(hostRef) {
      return hostRef === 'h-1' ? { status: 'pending' } : { status: 'unknown' };
    },
  };
  const result = await reconcileInteractions(draft, { host, now: 12 });
  assert.equal(result.pending, 1);
  assert.equal(result.uncertain, 1);
  assert.equal(draft.interactions[kept.id].state, 'pending');
  assert.equal(draft.interactions[kept.id].recovery, 'live');
  assert.equal(draft.interactions[unconfirmed.id].state, 'uncertain');
});

test('C04 a stop cancels unclaimed interactions of the stopped turn', () => {
  const draft = baseState();
  const target = openedApproval(draft);
  const other = openedApproval(draft, { turnId: 't-2' });
  const { ref } = issueReplyRef(draft, {
    accountId: 'acc-1', principalId: 'p-owner', replyContextId: 'rc-owner',
    interactionId: target.id, action: 'approve', expiresAt: 900,
  }, { now: 10 });
  const cancelled = cancelInteractionsForTurn(draft, { sessionId: 's-1', turnId: 't-1', now: 20 });
  assert.equal(cancelled, 1);
  assert.equal(target.state, 'cancelled');
  assert.equal(other.state, 'pending');
  assert.equal(draft.replyRefs[ref.id].state, 'revoked');
});

test('result validation follows the interaction type', () => {
  const draft = baseState();
  const approval = openedApproval(draft);
  assert.throws(
    () => claimInteraction(draft, { id: approval.id, expectedRevision: 0, decision: 'answer', text: 'sure', actor: { kind: 'local-owner' }, requestId: UUID }, { now: 11 }),
    (e) => e.code === 'VALIDATION',
  );
  assert.throws(
    () => claimInteraction(draft, { id: approval.id, expectedRevision: 0, decision: 'approve', choiceIds: ['maybe'], actor: { kind: 'local-owner' }, requestId: UUID }, { now: 11 }),
    (e) => e.code === 'VALIDATION',
  );
  assert.throws(
    () => claimInteraction(draft, { id: approval.id, expectedRevision: 0, decision: 'approve', choiceIds: ['yes', 'no'], actor: { kind: 'local-owner' }, requestId: UUID }, { now: 11 }),
    (e) => e.code === 'VALIDATION',
  );

  const question = openInteraction(draft, {
    type: 'question', sessionId: 's-1', hostRef: 'h-q', prompt: 'Pick one',
    choices: [{ id: 'a', label: 'A' }], multiple: false, allowText: false, expiresAt: 1000,
  }, { now: 10 });
  assert.throws(
    () => claimInteraction(draft, { id: question.id, expectedRevision: 0, decision: 'answer', actor: { kind: 'local-owner' }, requestId: UUID }, { now: 11 }),
    (e) => e.code === 'VALIDATION',
  );
  assert.throws(
    () => claimInteraction(draft, { id: question.id, expectedRevision: 0, decision: 'answer', text: 'hello', actor: { kind: 'local-owner' }, requestId: UUID }, { now: 11 }),
    (e) => e.code === 'VALIDATION',
  );
  const ok = claimInteraction(draft, { id: question.id, expectedRevision: 0, decision: 'answer', choiceIds: ['a'], actor: { kind: 'local-owner' }, requestId: UUID }, { now: 11 });
  assert.equal(ok.interaction.result.decision, 'answer');
});

test('a revoked principal loses its target and its token', () => {
  const draft = baseState();
  const interaction = openedApproval(draft);
  assert.equal(interaction.targets.length, 2);
  const { ref } = issueReplyRef(draft, {
    accountId: 'acc-1', principalId: 'p-member', replyContextId: 'rc-member',
    interactionId: interaction.id, action: 'approve', expiresAt: 900,
  }, { now: 10 });

  draft.principals['p-member'].enabled = false;
  const { removed } = refreshInteractionTargets(draft, interaction.id, { now: 20 });
  assert.equal(removed.length, 1);
  assert.equal(interaction.targets.length, 1);
  assert.equal(draft.replyRefs[ref.id].state, 'revoked');
  assert.equal(observeAllowed(draft, draft.principals['p-member'], 's-1', 20), false);
  assert.throws(
    () => claimInteraction(draft, {
      id: interaction.id, expectedRevision: interaction.revision, decision: 'approve',
      actor: { kind: 'im', accountId: 'acc-1', principalId: 'p-member' }, requestId: UUID,
    }, { now: 21 }),
    (e) => e.code === 'FORBIDDEN',
  );
});

test('a member may only observe its authorized sessions', () => {
  const draft = baseState();
  const interaction = openedApproval(draft, { sessionId: 's-2' });
  const memberTargets = interaction.targets.filter((t) => t.principalId === 'p-member');
  assert.equal(memberTargets.length, 0);
  const ownerTargets = interaction.targets.filter((t) => t.principalId === 'p-owner');
  assert.equal(ownerTargets.length, 1);
});

test('pending interactions are capped and never evict active work', () => {
  const draft = baseState();
  for (let i = 0; i < 100; i++) openedApproval(draft, { hostRef: `h-${i}` });
  assert.throws(
    () => openedApproval(draft, { hostRef: 'overflow' }),
    (e) => e.code === 'CAPACITY',
  );
});

test('views redact hostRef, targets and the claim actor key', () => {
  const draft = baseState();
  const interaction = openedApproval(draft);
  const view = interactionView(draft, interaction, { now: 11 });
  assert.equal('hostRef' in view, false);
  assert.equal('targets' in view, false);
  assert.equal('claim' in view, false);
  assert.deepEqual(view.sources, [{ accountId: 'acc-1', label: 'TG' }]);
  assert.equal(view.canSettle, true);

  const store = memoryStore(draft);
  const page = listInteractions(store, { state: 'pending' });
  assert.equal(page.total, 1);
  assert.equal(page.items[0].id, interaction.id);
  assert.equal(getInteraction(store, { id: interaction.id }).id, interaction.id);
  assert.deepEqual([...INTERACTION_TYPES].sort(), ['action', 'approval', 'question']);
});

test('revision mismatch is a CONFLICT carrying only the current revision', () => {
  const draft = baseState();
  const interaction = openedApproval(draft);
  assert.throws(
    () => claimInteraction(draft, {
      id: interaction.id, expectedRevision: 7, decision: 'approve', actor: { kind: 'local-owner' }, requestId: randomUUID(),
    }, { now: 11 }),
    (e) => e.code === 'CONFLICT' && e.details.currentRevision === 0,
  );
});
// --- R14: interaction TTL vs the Host deadline ------------------------------

test('R14 the effective deadline is min(host, now+15min) and a past one never revives', () => {
  const draft = baseState();
  const base = { type: 'approval', sessionId: 's-1', hostRef: 'h-1', turnId: 't-1', prompt: 'Allow?', choices: [] };
  // Default: now + INTERACTION_TTL_MS.
  assert.equal(openInteraction(draft, base, { now: 1000 }).expiresAt, 1000 + LIMITS.INTERACTION_TTL_MS);
  // A far-future Host deadline is capped to the local TTL.
  assert.equal(openInteraction(draft, { ...base, hostRef: 'h-2', expiresAt: 10_000_000 }, { now: 1000 }).expiresAt, 1000 + LIMITS.INTERACTION_TTL_MS);
  // A shorter Host deadline is honoured.
  assert.equal(openInteraction(draft, { ...base, hostRef: 'h-3', expiresAt: 2000 }, { now: 1000 }).expiresAt, 2000);
  // Boundary: a deadline of exactly now (or earlier) is already expired, never revived.
  assert.throws(() => openInteraction(draft, { ...base, hostRef: 'h-4', expiresAt: 1000 }, { now: 1000 }), (e) => e.code === 'EXPIRED');
  assert.throws(() => openInteraction(draft, { ...base, hostRef: 'h-5', expiresAt: 999 }, { now: 1000 }), (e) => e.code === 'EXPIRED');
});

test('R14 settling exactly at the deadline is EXPIRED, not a silent approval', () => {
  const draft = baseState();
  const interaction = openInteraction(draft, {
    type: 'approval', sessionId: 's-1', hostRef: 'h-1', turnId: 't-1', prompt: 'Allow?', choices: [], expiresAt: 1500,
  }, { now: 1000 });
  assert.throws(
    () => claimInteraction(draft, {
      id: interaction.id, expectedRevision: 0, decision: 'approve', actor: { kind: 'local-owner' }, requestId: randomUUID(),
    }, { now: interaction.expiresAt }),
    (e) => e.code === 'EXPIRED',
  );
});
