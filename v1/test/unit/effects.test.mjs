// B01: request idempotency isolation (W10), leaf effect evidence (W11), bounded
// inbox/cursor semantics (W20) and reply identity scoping (W04).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState } from '../../src/domain/schema.mjs';
import { DomainError } from '../../src/domain/errors.mjs';
import {
  beginRequest, completeRequest, markRequestUncertain, requestKeyOf,
  createEffect, applyEffectResult, aggregateEffectStatus, reconcileStartedEffects, effectsForRequest,
} from '../../src/services/effects.mjs';
import {
  receiveInbound, claimInbound, completeInbound, markInboundUncertain,
  canAdvanceCursor, advanceCursor, pruneInbox, inboxKeyOf,
} from '../../src/services/inbox.mjs';
import {
  upsertReplyContext, assertReplyContextUsable, isReplyContextUsable, replyContextView, pruneReplyContexts,
} from '../../src/services/reply-contexts.mjs';
import {
  issueReplyRef, lookupReplyRefByToken, lookupReplyRefById, markReplyRefUsed,
  revokeReplyRefsForInteraction, setReplyRefMessageId,
} from '../../src/services/reply-refs.mjs';

const UUID = '11111111-1111-4111-8111-111111111111';

function stateWithAccount() {
  const draft = createEmptyState();
  draft.accounts['acc-1'] = {
    id: 'acc-1', revision: 0, channelId: 'telegram', label: 'TG', enabled: true,
    notificationEnabled: true, controlEnabled: true, config: { outbound: {}, inbound: {} },
    secrets: {}, policyRevision: 3, createdAt: 1, updatedAt: 1,
  };
  return draft;
}

// --- W10 -------------------------------------------------------------------

test('W10 the idempotency key isolates actor, method and requestId', () => {
  const a = requestKeyOf('local-owner', 'a', 'accounts.create', UUID);
  const b = requestKeyOf('local-owner', 'b', 'accounts.create', UUID);
  const c = requestKeyOf('local-owner', 'a', 'accounts.update', UUID);
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test('W10 same hash replays the stored result, a different payload is a CONFLICT', () => {
  const draft = createEmptyState();
  const first = beginRequest(draft, {
    actor: { kind: 'local-owner', id: 'a' }, method: 'accounts.create', requestId: UUID,
    payload: { label: 'x' }, kind: 'config', now: 100,
  });
  assert.equal(first.replayed, false);
  completeRequest(draft, first.key, { id: 'acc' });

  const replay = beginRequest(draft, {
    actor: { kind: 'local-owner', id: 'a' }, method: 'accounts.create', requestId: UUID,
    payload: { label: 'x' }, kind: 'config', now: 200,
  });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, { id: 'acc' });

  assert.throws(
    () => beginRequest(draft, {
      actor: { kind: 'local-owner', id: 'a' }, method: 'accounts.create', requestId: UUID,
      payload: { label: 'y' }, kind: 'config', now: 300,
    }),
    (err) => err instanceof DomainError && err.code === 'CONFLICT',
  );
});

test('W10 one actor never reads another actor result for the same requestId', () => {
  const draft = createEmptyState();
  const a = beginRequest(draft, {
    actor: { kind: 'local-owner', id: 'a' }, method: 'settings.update', requestId: UUID, payload: {}, kind: 'config',
  });
  completeRequest(draft, a.key, { secret: 'a-only' });
  const b = beginRequest(draft, {
    actor: { kind: 'local-owner', id: 'b' }, method: 'settings.update', requestId: UUID, payload: {}, kind: 'config',
  });
  assert.equal(b.replayed, false, 'actor b has its own record');
  assert.equal(b.result, null);
});

// --- W11 -------------------------------------------------------------------

test('W11 an effect records segment, attempt and provider id per leaf', () => {
  const draft = createEmptyState();
  const effect = createEffect(draft, { requestKey: 'k', accountId: 'a', destinationId: 'd', segmentIndex: 2, attempt: 1, kind: 'notify' }, { now: 10 });
  applyEffectResult(draft, effect.id, { status: 'accepted', providerMessageId: 'm-2', now: 11 });
  assert.equal(draft.effects[effect.id].status, 'accepted');
  assert.equal(draft.effects[effect.id].segmentIndex, 2);
  assert.equal(draft.effects[effect.id].providerMessageId, 'm-2');
});

test('W11 restart marks started effects uncertain and planned effects cancelled, never replayed', () => {
  const draft = createEmptyState();
  const started = createEffect(draft, { requestKey: 'k', kind: 'hostSubmit' }, { now: 0 });
  draft.effects[started.id].status = 'started';
  draft.effects[started.id].updatedAt = 0;
  const planned = createEffect(draft, { requestKey: 'k', kind: 'hostSettle' }, { now: 0 });
  const out = reconcileStartedEffects(draft, { now: 60_000, graceMs: 10_000 });
  assert.equal(out.uncertain, 1);
  assert.equal(out.cancelled, 1);
  assert.equal(draft.effects[started.id].status, 'uncertain');
  assert.equal(draft.effects[planned.id].status, 'cancelled');
});

test('W11 aggregate layering keeps accepted below confirmed and flags uncertainty', () => {
  const mk = (status) => ({ status });
  assert.deepEqual(aggregateEffectStatus([mk('confirmed'), mk('confirmed')]), { status: 'confirmed', delivery: 'complete' });
  assert.deepEqual(aggregateEffectStatus([mk('confirmed'), mk('accepted')]), { status: 'accepted', delivery: 'complete' });
  assert.deepEqual(aggregateEffectStatus([mk('accepted'), mk('failed')]), { status: 'failed', delivery: 'partial' });
  assert.deepEqual(aggregateEffectStatus([mk('accepted'), mk('uncertain')]), { status: 'uncertain', delivery: 'partial' });
  assert.deepEqual(aggregateEffectStatus([]), { status: 'skipped', delivery: 'none' });
});

test('W11 effectsForRequest orders by segment then attempt', () => {
  const draft = createEmptyState();
  const a = createEffect(draft, { requestKey: 'k', kind: 'notify', segmentIndex: 1, attempt: 1 }, { now: 1 });
  const b = createEffect(draft, { requestKey: 'k', kind: 'notify', segmentIndex: 0, attempt: 1 }, { now: 2 });
  const ids = effectsForRequest(draft, 'k').map((e) => e.id);
  assert.deepEqual(ids, [b.id, a.id]);
});

// --- W20 -------------------------------------------------------------------

test('W20 a duplicate inbound event is not processed twice', () => {
  const draft = stateWithAccount();
  const first = receiveInbound(draft, { accountId: 'acc-1', eventId: 'e-1', now: 100 });
  assert.equal(first.replayed, false);
  const second = receiveInbound(draft, { accountId: 'acc-1', eventId: 'e-1', now: 101 });
  assert.equal(second.replayed, true);
  assert.equal(Object.keys(draft.inbox).length, 1);
});

test('W20 only an unstarted, recoverable uncertain event may be re-received', () => {
  const draft = stateWithAccount();
  const key = inboxKeyOf('acc-1', 'e-1');
  receiveInbound(draft, { accountId: 'acc-1', eventId: 'e-1', now: 100 });
  markInboundUncertain(draft, key);
  const recovered = receiveInbound(draft, { accountId: 'acc-1', eventId: 'e-1', now: 200, canRecover: true });
  assert.equal(recovered.recovered, true);

  markInboundUncertain(draft, key);
  draft.inbox[key].effectIds = ['eff-1']; // work already started
  const blocked = receiveInbound(draft, { accountId: 'acc-1', eventId: 'e-1', now: 300, canRecover: true });
  assert.equal(blocked.replayed, true);
});

test('W20 the cursor never advances past an in-flight event', () => {
  const draft = stateWithAccount();
  receiveInbound(draft, { accountId: 'acc-1', eventId: 'e-1', now: 100 });
  assert.equal(canAdvanceCursor(draft, 'acc-1'), false);
  assert.deepEqual(advanceCursor(draft, 'acc-1', { offset: 5 }), { advanced: false, reason: 'IN_FLIGHT_EVENTS' });

  const key = inboxKeyOf('acc-1', 'e-1');
  claimInbound(draft, key);
  completeInbound(draft, key);
  assert.equal(canAdvanceCursor(draft, 'acc-1'), true);
  assert.deepEqual(advanceCursor(draft, 'acc-1', { offset: 5 }), { advanced: true });
  assert.deepEqual(draft.cursors['acc-1'].transportData, { offset: 5 });
});

test('W20 claimed events refuse duplicate execution and uncertain events fail closed', () => {
  const draft = stateWithAccount();
  const key = inboxKeyOf('acc-1', 'e-1');
  receiveInbound(draft, { accountId: 'acc-1', eventId: 'e-1' });
  assert.equal(claimInbound(draft, key).claimed, true);
  assert.equal(claimInbound(draft, key).claimed, false);
  markInboundUncertain(draft, key);
  assert.throws(() => claimInbound(draft, key), (e) => e.code === 'UNCERTAIN');
});

test('W20 the inbox enforces a hard per-account cap', () => {
  const draft = stateWithAccount();
  draft.inbox = {};
  for (let i = 0; i < 2048; i++) {
    receiveInbound(draft, { accountId: 'acc-1', eventId: `e-${i}`, now: 1 });
  }
  assert.throws(() => receiveInbound(draft, { accountId: 'acc-1', eventId: 'overflow', now: 1 }), (e) => e.code === 'CAPACITY');
  pruneInbox(draft, { now: 2 * 24 * 60 * 60 * 1000 });
  assert.equal(Object.keys(draft.inbox).length, 0);
});

// --- reply contexts --------------------------------------------------------

test('a reply context is pinned to the principal and hides transport secrets from views', () => {
  const draft = stateWithAccount();
  draft.principals['p-1'] = {
    id: 'p-1', revision: 0, accountId: 'acc-1', userId: 'u-1', role: 'owner', canConverse: false,
    sessionIds: [], enabled: true, replyContextId: '', createdAt: 1, updatedAt: 1,
  };
  const record = upsertReplyContext(draft, {
    accountId: 'acc-1', userId: 'u-1', chatId: 'c-1', transportData: { token: 'secret' }, principalId: 'p-1',
  });
  draft.principals['p-1'].replyContextId = record.id;
  const again = upsertReplyContext(draft, { accountId: 'acc-1', userId: 'u-1', chatId: 'c-1', principalId: 'p-1' });
  assert.equal(again.id, record.id, 'one context per principal');
  assert.equal('transportData' in replyContextView(record), false);
  assert.equal(replyContextView(record).chatId, 'c-1');
});

test('an expired reply context fails with CONTEXT_EXPIRED', () => {
  const record = { id: 'rc', expiresAt: 50 };
  assert.equal(isReplyContextUsable(record, 100), false);
  assert.throws(() => assertReplyContextUsable(record, 100), (e) => e.code === 'EXPIRED' && e.details.code === 'CONTEXT_EXPIRED');
  assert.equal(isReplyContextUsable(record, 10), true);
});

test('oversized transport data is rejected', () => {
  const draft = stateWithAccount();
  assert.throws(
    () => upsertReplyContext(draft, { accountId: 'acc-1', userId: 'u', chatId: 'c', transportData: { blob: 'x'.repeat(17000) } }),
    (e) => e.code === 'VALIDATION',
  );
});

test('unpair reply contexts older than the cache window are pruned', () => {
  const draft = stateWithAccount();
  const c1 = upsertReplyContext(draft, { accountId: 'acc-1', userId: 'u', chatId: 'c' }, { now: 0 });
  const c2 = upsertReplyContext(draft, { accountId: 'acc-1', userId: 'u', chatId: 'c' }, { now: 10 * 60 * 1000 });
  pruneReplyContexts(draft, { now: 10 * 60 * 1000 + 1 });
  assert.equal(draft.replyContexts[c1.id], undefined);
  assert.ok(draft.replyContexts[c2.id]);
});

// --- reply refs ------------------------------------------------------------

function seedInteraction(draft) {
  upsertReplyContext(draft, { accountId: 'acc-1', userId: 'u-1', chatId: 'c-1', id: 'rc-1' });
  draft.principals['p-1'] = {
    id: 'p-1', revision: 0, accountId: 'acc-1', userId: 'u-1', role: 'owner', canConverse: false,
    sessionIds: [], enabled: true, replyContextId: 'rc-1', createdAt: 1, updatedAt: 1,
  };
  draft.interactions['i-1'] = {
    id: 'i-1', revision: 0, type: 'approval', sessionId: 's-1', turnId: null, hostRef: 'h-1',
    prompt: 'ok?', choices: [], multiple: false, allowText: false,
    targets: [{ accountId: 'acc-1', principalId: 'p-1', replyContextId: 'rc-1', policyRevision: 3 }],
    state: 'pending', recovery: 'live', expiresAt: 10_000, claim: null, result: null,
    createdAt: 1, updatedAt: 1,
  };
}

test('W04 a reply ref stores only the token hash and scopes lookup to account/chat', () => {
  const draft = stateWithAccount();
  seedInteraction(draft);
  const { ref, token } = issueReplyRef(draft, {
    accountId: 'acc-1', principalId: 'p-1', replyContextId: 'rc-1', interactionId: 'i-1', action: 'approve', expiresAt: 10_000,
  }, { now: 100 });
  assert.equal(ref.tokenHash.length, 64);
  assert.equal(JSON.stringify(draft.replyRefs).includes(token), false, 'plaintext token never persists');
  setReplyRefMessageId(draft, ref.id, 'msg-1');

  const found = lookupReplyRefByToken(draft, { token, accountId: 'acc-1', chatId: 'c-1', now: 100 });
  assert.equal(found.id, ref.id);
  assert.throws(
    () => lookupReplyRefByToken(draft, { token, accountId: 'acc-1', chatId: 'other-chat', now: 100 }),
    (e) => e.code === 'NOT_FOUND',
  );
});

test('W04 a used or expired reply ref is refused', () => {
  const draft = stateWithAccount();
  seedInteraction(draft);
  const { ref, token } = issueReplyRef(draft, {
    accountId: 'acc-1', principalId: 'p-1', replyContextId: 'rc-1', interactionId: 'i-1', action: 'reject', expiresAt: 10_000,
  }, { now: 100 });
  markReplyRefUsed(draft, ref.id);
  assert.throws(() => lookupReplyRefByToken(draft, { token, accountId: 'acc-1', now: 100 }), (e) => e.code === 'ALREADY_HANDLED');

  const other = issueReplyRef(draft, {
    accountId: 'acc-1', principalId: 'p-1', replyContextId: 'rc-1', interactionId: 'i-1', action: 'approve', expiresAt: 50,
  }, { now: 100 });
  assert.throws(
    () => lookupReplyRefById(draft, { refId: other.ref.id, accountId: 'acc-1', principalId: 'p-1', chatId: 'c-1', now: 100 }),
    (e) => e.code === 'EXPIRED',
  );
});

test('W04 finishing an interaction revokes its outstanding refs', () => {
  const draft = stateWithAccount();
  seedInteraction(draft);
  const { ref, token } = issueReplyRef(draft, {
    accountId: 'acc-1', principalId: 'p-1', replyContextId: 'rc-1', interactionId: 'i-1', action: 'approve', expiresAt: 10_000,
  }, { now: 100 });
  revokeReplyRefsForInteraction(draft, 'i-1');
  assert.throws(() => lookupReplyRefByToken(draft, { token, accountId: 'acc-1', now: 100 }), (e) => e.code === 'EXPIRED');
  assert.equal(draft.replyRefs[ref.id].state, 'revoked');
});