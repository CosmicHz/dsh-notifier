// T06 pairing: P01 concurrency, P02 cross-account/expiry/lockout, P03 atomic
// redemption, plus one-time code / role / revocation semantics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/storage/store.mjs';
import { DomainError } from '../../src/domain/errors.mjs';
import { LIMITS } from '../../src/domain/limits.mjs';
import { createAccount } from '../../src/services/accounts.mjs';
import { issuePairing, redeemPairing, revokePairing, listPairings } from '../../src/services/pairing.mjs';

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pairing-'));
  const { store } = await openStore(dir);
  return store;
}

async function telegramAccount(store, label = 'TG') {
  return createAccount(store, {
    channelId: 'telegram',
    label,
    config: { outbound: {} },
    secretChanges: [{ path: 'outbound.botToken', op: 'set', value: { kind: 'literal', value: '"tok-1"' } }],
    notificationEnabled: true,
  }, { now: 100 });
}

async function seedReplyContext(store, accountId, id, userId = 'u1') {
  await store.transact(null, (draft) => {
    draft.replyContexts[id] = {
      id, accountId, userId, chatId: 'chat', chatType: 'private',
      transportData: {}, expiresAt: null, createdAt: 1, updatedAt: 1,
    };
  });
}

test('a pairing code is one-time: concurrent redemption yields exactly one principal (P01)', async () => {
  const store = await freshStore();
  const account = await telegramAccount(store);
  await seedReplyContext(store, account.id, 'rc1');
  const issued = await issuePairing(store, { accountId: account.id }, { now: 1000 });
  assert.equal(typeof issued.code, 'string');
  assert.equal(issued.expiresAt, 1000 + LIMITS.PAIRING_TTL_MS);

  const input = { accountId: account.id, userId: 'u1', code: issued.code, replyContextId: 'rc1' };
  const outcomes = await Promise.allSettled([
    redeemPairing(store, input, { now: 1001 }),
    redeemPairing(store, input, { now: 1002 }),
  ]);
  assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1, 'only one redemption may win');
  assert.equal(outcomes.filter((o) => o.status === 'rejected').length, 1);
  assert.equal(Object.keys(store.snapshot().principals).length, 1);
});

test('issuePairing defaults the first user to owner and the next to member', async () => {
  const store = await freshStore();
  const account = await telegramAccount(store);
  const first = await issuePairing(store, { accountId: account.id }, { now: 1000 });
  assert.equal(store.snapshot().pairing[first.id].role, 'owner');
  const second = await issuePairing(store, { accountId: account.id }, { now: 1001 });
  assert.equal(store.snapshot().pairing[second.id].role, 'member');
  await assert.rejects(
    issuePairing(store, { accountId: account.id, role: 'owner' }, { now: 1002 }),
    (e) => e instanceof DomainError && e.code === 'FORBIDDEN',
  );
});

test('P02: a code is rejected across accounts, after expiry and under lockout', async () => {
  const store = await freshStore();
  const a = await telegramAccount(store, 'A');
  const b = await telegramAccount(store, 'B');
  await seedReplyContext(store, a.id, 'rcA');

  // cross-account: a code minted for A must never redeem against B
  const forA = await issuePairing(store, { accountId: a.id }, { now: 1000 });
  await assert.rejects(
    redeemPairing(store, { accountId: b.id, userId: 'u1', code: forA.code, replyContextId: 'rcA' }, { now: 1001 }),
    (e) => e instanceof DomainError && e.code === 'FORBIDDEN',
  );
  assert.deepEqual(store.snapshot().principals, {});

  // expiry
  const expiring = await issuePairing(store, { accountId: a.id }, { now: 2000 });
  await assert.rejects(
    redeemPairing(store, { accountId: a.id, userId: 'u1', code: expiring.code, replyContextId: 'rcA' },
      { now: 2000 + LIMITS.PAIRING_TTL_MS + 1 }),
    (e) => e instanceof DomainError && e.code === 'EXPIRED',
  );

  // lockout: five failures lock the [account,user] pair even for a correct code
  const valid = await issuePairing(store, { accountId: a.id }, { now: 3000 });
  for (let i = 0; i < LIMITS.PAIRING_FAILURE_LIMIT; i++) {
    await assert.rejects(
      redeemPairing(store, { accountId: a.id, userId: 'u-locked', code: 'WRONGCOD', replyContextId: 'rcA' }, { now: 3001 + i }),
      (e) => e instanceof DomainError && e.code === 'FORBIDDEN',
    );
  }
  await assert.rejects(
    redeemPairing(store, { accountId: a.id, userId: 'u-locked', code: valid.code, replyContextId: 'rcA' }, { now: 3100 }),
    (e) => e instanceof DomainError && e.code === 'FORBIDDEN' && /too many/.test(e.message),
  );
  assert.equal(store.snapshot().pairing[valid.id].state, 'active', 'a locked-out attempt must not consume the code');
  assert.deepEqual(store.snapshot().principals, {});
});

test('P03: a redemption failure leaves no authorization behind (atomic)', async () => {
  const store = await freshStore();
  const account = await telegramAccount(store);
  const issued = await issuePairing(store, { accountId: account.id }, { now: 1000 });
  await assert.rejects(
    redeemPairing(store, { accountId: account.id, userId: 'u1', code: issued.code, replyContextId: 'nope' }, { now: 1001 }),
    (e) => e instanceof DomainError && e.code === 'VALIDATION',
  );
  const after = store.snapshot();
  assert.deepEqual(after.principals, {}, 'no principal may exist after a failed redemption');
  assert.equal(after.pairing[issued.id].state, 'active', 'the pairing code must remain usable');
});

test('redeem returns the principal and stores only the code hash', async () => {
  const store = await freshStore();
  const account = await telegramAccount(store);
  await seedReplyContext(store, account.id, 'rc1', 'u9');
  const issued = await issuePairing(store, { accountId: account.id, canConverse: true }, { now: 1000 });
  const principal = await redeemPairing(
    store, { accountId: account.id, userId: 'u9', code: issued.code, replyContextId: 'rc1' }, { now: 1001 },
  );
  assert.equal(principal.accountId, account.id);
  assert.equal(principal.userId, 'u9');
  assert.equal(principal.role, 'owner');
  assert.equal(principal.canConverse, true);
  assert.equal(principal.enabled, true);
  assert.equal(JSON.stringify(store.snapshot().pairing).includes(issued.code), false, 'plaintext code must never be stored');

  const page = listPairings(store, { accountId: account.id });
  assert.equal(page.total, 1);
  assert.equal('codeHash' in page.items[0], false, 'pairing views must not expose the hash');
});

test('revoking a pairing is one-way and idempotent-safe', async () => {
  const store = await freshStore();
  const account = await telegramAccount(store);
  const issued = await issuePairing(store, { accountId: account.id }, { now: 1000 });
  assert.deepEqual(await revokePairing(store, { id: issued.id }, { now: 1001 }), { revoked: true });
  await assert.rejects(
    revokePairing(store, { id: issued.id }, { now: 1002 }),
    (e) => e instanceof DomainError && e.code === 'ALREADY_HANDLED',
  );
});