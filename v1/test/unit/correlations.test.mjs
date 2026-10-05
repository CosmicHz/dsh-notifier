// B02: conversation correlation / reply return path (W02).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyState } from '../../src/domain/schema.mjs';
import { upsertReplyContext } from '../../src/services/reply-contexts.mjs';
import {
  reserveCorrelation, bindCorrelationTurn, completeCorrelation, cancelCorrelation,
  correlationForTurn, liveCorrelationsForSession, reconcileCorrelations,
  cancelCorrelationsForPrincipal, correlationKeyOf,
} from '../../src/services/correlations.mjs';

function state() {
  const draft = createEmptyState();
  draft.accounts['acc-1'] = {
    id: 'acc-1', revision: 0, channelId: 'telegram', label: 'TG', enabled: true,
    notificationEnabled: true, controlEnabled: true, config: { outbound: {}, inbound: {} },
    secrets: {}, policyRevision: 1, createdAt: 1, updatedAt: 1,
  };
  const rc = upsertReplyContext(draft, { accountId: 'acc-1', userId: 'u-1', chatId: 'c-1', id: 'rc-1' });
  draft.principals['p-1'] = {
    id: 'p-1', revision: 0, accountId: 'acc-1', userId: 'u-1', role: 'owner', canConverse: true,
    sessionIds: ['s-1'], enabled: true, replyContextId: rc.id, createdAt: 1, updatedAt: 1,
  };
  const rc2 = upsertReplyContext(draft, { accountId: 'acc-1', userId: 'u-2', chatId: 'c-2', id: 'rc-2' });
  draft.principals['p-2'] = {
    id: 'p-2', revision: 0, accountId: 'acc-1', userId: 'u-2', role: 'member', canConverse: true,
    sessionIds: ['s-1'], enabled: true, replyContextId: rc2.id, createdAt: 1, updatedAt: 1,
  };
  return draft;
}

test('W02 a correlation is reserved before submit and binds to the started turn', () => {
  const draft = state();
  const { correlation, replayed } = reserveCorrelation(draft, {
    accountId: 'acc-1', principalId: 'p-1', replyContextId: 'rc-1', sessionId: 's-1', requestId: 'r-1',
  }, { now: 10 });
  assert.equal(replayed, false);
  assert.equal(correlation.state, 'reserved');
  assert.equal(correlation.hostRef, null);

  bindCorrelationTurn(draft, correlation.id, { hostRef: 'boot:waiter', turnId: 't-1', now: 20 });
  assert.equal(correlation.state, 'active');
  assert.equal(correlationForTurn(draft, { sessionId: 's-1', turnId: 't-1' }).id, correlation.id);
});

test('W02 the same request is idempotent and never double-reserves', () => {
  const draft = state();
  const first = reserveCorrelation(draft, {
    accountId: 'acc-1', principalId: 'p-1', replyContextId: 'rc-1', sessionId: 's-1', requestId: 'r-1',
  }, { now: 10 });
  const again = reserveCorrelation(draft, {
    accountId: 'acc-1', principalId: 'p-1', replyContextId: 'rc-1', sessionId: 's-1', requestId: 'r-1',
  }, { now: 11 });
  assert.equal(again.replayed, true);
  assert.equal(again.correlation.id, first.correlation.id);
  assert.equal(Object.keys(draft.correlations).length, 1);
});

test('W02 two principals cannot share one session reply path', () => {
  const draft = state();
  reserveCorrelation(draft, {
    accountId: 'acc-1', principalId: 'p-1', replyContextId: 'rc-1', sessionId: 's-1', requestId: 'r-1',
  }, { now: 10 });
  assert.throws(
    () => reserveCorrelation(draft, {
      accountId: 'acc-1', principalId: 'p-2', replyContextId: 'rc-2', sessionId: 's-1', requestId: 'r-2',
    }, { now: 11 }),
    (e) => e.code === 'CONFLICT',
  );
});

test('W02 a reserved correlation cannot be retargeted to another turn', () => {
  const draft = state();
  const { correlation } = reserveCorrelation(draft, {
    accountId: 'acc-1', principalId: 'p-1', replyContextId: 'rc-1', sessionId: 's-1', requestId: 'r-1',
  }, { now: 10 });
  bindCorrelationTurn(draft, correlation.id, { hostRef: 'h-1', turnId: 't-1', now: 20 });
  assert.throws(() => bindCorrelationTurn(draft, correlation.id, { hostRef: 'h-2', turnId: 't-2', now: 21 }), (e) => e.code === 'CONFLICT');
  assert.equal(correlation.hostRef, 'h-1');
});

test('W02 restart cancels a reserved correlation and marks an active one uncertain', () => {
  const draft = state();
  const a = reserveCorrelation(draft, {
    accountId: 'acc-1', principalId: 'p-1', replyContextId: 'rc-1', sessionId: 's-1', requestId: 'r-1',
  }, { now: 10 });
  const b = reserveCorrelation(draft, {
    accountId: 'acc-1', principalId: 'p-1', replyContextId: 'rc-1', sessionId: 's-1', requestId: 'r-2',
  }, { now: 10 });
  bindCorrelationTurn(draft, b.correlation.id, { hostRef: 'h', turnId: 't', now: 20 });
  const out = reconcileCorrelations(draft, { now: 30 });
  assert.deepEqual(out, { cancelled: 1, uncertain: 1 });
  assert.equal(draft.correlations[a.correlation.id].state, 'cancelled');
  assert.equal(draft.correlations[b.correlation.id].state, 'uncertain');
});

test('W16 revoking a principal cancels only that principal live correlations', () => {
  const draft = state();
  const p1 = reserveCorrelation(draft, {
    accountId: 'acc-1', principalId: 'p-1', replyContextId: 'rc-1', sessionId: 's-1', requestId: 'r-1',
  }, { now: 10 });
  const p1b = reserveCorrelation(draft, {
    accountId: 'acc-1', principalId: 'p-1', replyContextId: 'rc-1', sessionId: 's-2', requestId: 'r-2',
  }, { now: 10 });
  completeCorrelation(draft, p1b.correlation.id, { now: 15 });
  const cancelled = cancelCorrelationsForPrincipal(draft, 'p-1', { now: 20 });
  assert.equal(cancelled, 1);
  assert.equal(draft.correlations[p1.correlation.id].state, 'cancelled');
  assert.equal(draft.correlations[p1b.correlation.id].state, 'completed');
});

test('correlation keys are canonical tuples, not delimiter joins', () => {
  assert.equal(correlationKeyOf('a', 'b', 'c', 'd'), JSON.stringify(['a', 'b', 'c', 'd']));
});

test('live correlations for a session ignore finished ones', () => {
  const draft = state();
  const one = reserveCorrelation(draft, {
    accountId: 'acc-1', principalId: 'p-1', replyContextId: 'rc-1', sessionId: 's-1', requestId: 'r-1',
  }, { now: 10 });
  cancelCorrelation(draft, one.correlation.id, { now: 20 });
  assert.deepEqual(liveCorrelationsForSession(draft, 's-1'), []);
});