// T06 principals: A03 cross-account isolation, role/permission policy revisions,
// the single-enabled-owner rule, and reference revocation (P04).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/storage/store.mjs';
import { DomainError } from '../../src/domain/errors.mjs';
import { createAccount } from '../../src/services/accounts.mjs';
import { issuePairing, redeemPairing } from '../../src/services/pairing.mjs';
import { updatePrincipal, removePrincipal, listPrincipals } from '../../src/services/principals.mjs';

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-principals-'));
  const { store } = await openStore(dir);
  return store;
}

async function telegramAccount(store, label) {
  return createAccount(store, {
    channelId: 'telegram',
    label,
    config: { outbound: {} },
    secretChanges: [{ path: 'outbound.botToken', op: 'set', value: { kind: 'literal', value: '"tok-1"' } }],
    notificationEnabled: true,
  }, { now: 100 });
}

async function pair(store, accountId, userId, { role, canConverse = false, replyContextId } = {}) {
  const issued = await issuePairing(store, { accountId, role, canConverse }, { now: 1000 });
  return redeemPairing(store, { accountId, userId, code: issued.code, replyContextId }, { now: 1001 });
}

async function seedReplyContext(store, accountId, id, userId = 'u1') {
  await store.transact(null, (draft) => {
    draft.replyContexts[id] = {
      id, accountId, userId, chatId: 'chat', chatType: 'private',
      transportData: {}, expiresAt: null, createdAt: 1, updatedAt: 1,
    };
  });
}

test('A03: the same userId on two accounts resolves to isolated principals', async () => {
  const store = await freshStore();
  const a = await telegramAccount(store, 'A');
  const b = await telegramAccount(store, 'B');
  await seedReplyContext(store, a.id, 'rcA', 'shared');
  await seedReplyContext(store, b.id, 'rcB', 'shared');

  const pa = await pair(store, a.id, 'shared', { replyContextId: 'rcA' });
  const pb = await pair(store, b.id, 'shared', { replyContextId: 'rcB' });
  assert.notEqual(pa.id, pb.id, 'principals are per account, not per userId');
  assert.equal(pa.accountId, a.id);
  assert.equal(pb.accountId, b.id);

  const beforeB = store.snapshot().accounts[b.id].policyRevision;
  await updatePrincipal(store, { id: pa.id, expectedRevision: 0, patch: { enabled: false } });
  assert.equal(store.snapshot().principals[pb.id].enabled, true, 'disabling one account must not touch another');
  assert.equal(store.snapshot().accounts[b.id].policyRevision, beforeB);
  assert.equal(listPrincipals(store, { accountId: b.id }).total, 1);
});

test('a permission patch advances the owning account policyRevision', async () => {
  const store = await freshStore();
  const account = await telegramAccount(store, 'A');
  await seedReplyContext(store, account.id, 'rc1');
  const principal = await pair(store, account.id, 'u1', { replyContextId: 'rc1' });
  assert.equal(store.snapshot().accounts[account.id].policyRevision, 0);

  const updated = await updatePrincipal(store, {
    id: principal.id, expectedRevision: 0, patch: { canConverse: true, sessionIds: ['s1'] },
  });
  assert.equal(updated.canConverse, true);
  assert.deepEqual(updated.sessionIds, ['s1']);
  assert.equal(updated.revision, 1);
  assert.equal(store.snapshot().accounts[account.id].policyRevision, 1);

  await assert.rejects(
    updatePrincipal(store, { id: principal.id, expectedRevision: 0, patch: { canConverse: false } }),
    (e) => e instanceof DomainError && e.code === 'CONFLICT' && e.details.currentRevision === 1,
  );
  await assert.rejects(
    updatePrincipal(store, { id: principal.id, expectedRevision: 1, patch: { accountId: 'z' } }),
    (e) => e instanceof DomainError && e.code === 'VALIDATION',
  );
});

test('there can be only one enabled owner per account', async () => {
  const store = await freshStore();
  const account = await telegramAccount(store, 'A');
  await seedReplyContext(store, account.id, 'rc1');
  await seedReplyContext(store, account.id, 'rc2', 'u2');
  await pair(store, account.id, 'u1', { replyContextId: 'rc1' });
  const member = await pair(store, account.id, 'u2', { role: 'member', replyContextId: 'rc2' });

  await assert.rejects(
    updatePrincipal(store, { id: member.id, expectedRevision: 0, patch: { role: 'owner' } }),
    (e) => e instanceof DomainError && e.code === 'FORBIDDEN',
  );
});

test('P04: disabling a principal revokes its bindings and outstanding reply refs', async () => {
  const store = await freshStore();
  const account = await telegramAccount(store, 'A');
  await seedReplyContext(store, account.id, 'rc1');
  const principal = await pair(store, account.id, 'u1', { replyContextId: 'rc1' });

  await store.transact(null, (draft) => {
    draft.bindings[principal.id] = { principalId: principal.id, sessionId: 's1', updatedAt: 1 };
    draft.replyRefs.r1 = {
      id: 'r1', tokenHash: 'h', accountId: account.id, principalId: principal.id, replyContextId: 'rc1',
      interactionId: 'i1', interactionRevision: 0, policyRevision: 0, action: 'approve',
      messageId: null, expiresAt: 999, state: 'active', createdAt: 1,
    };
  });

  await updatePrincipal(store, { id: principal.id, expectedRevision: 0, patch: { enabled: false } });
  const after = store.snapshot();
  assert.equal(after.replyRefs.r1.state, 'revoked', 'outstanding approval must stop working');
  assert.equal(principal.id in after.bindings, false);
});

test('removing a principal deletes its refs/correlations and bumps policy', async () => {
  const store = await freshStore();
  const account = await telegramAccount(store, 'A');
  await seedReplyContext(store, account.id, 'rc1');
  const principal = await pair(store, account.id, 'u1', { replyContextId: 'rc1' });

  await store.transact(null, (draft) => {
    draft.bindings[principal.id] = { principalId: principal.id, sessionId: 's1', updatedAt: 1 };
    draft.correlations.c1 = {
      id: 'c1', requestKey: 'k', accountId: account.id, principalId: principal.id, replyContextId: 'rc1',
      sessionId: 's1', hostRef: null, turnId: null, state: 'active', createdAt: 1, updatedAt: 1,
    };
  });

  assert.deepEqual(await removePrincipal(store, { id: principal.id, expectedRevision: 0 }), { removed: true });
  const after = store.snapshot();
  assert.deepEqual(after.principals, {});
  assert.deepEqual(after.correlations, {});
  assert.equal(principal.id in after.bindings, false);
  assert.equal(after.accounts[account.id].policyRevision, 1);
  assert.ok(after.activity.some((row) => row.status === 'principal-removed'));
});