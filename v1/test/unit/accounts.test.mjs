// T05 accounts: A01 credential rotation keeps the id, A02 flag patches keep other
// fields, A04 delete cleans strong references, A05 views never carry secrets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/storage/store.mjs';
import { DomainError } from '../../src/domain/errors.mjs';
import {
  createAccount, updateAccount, removeAccount, getAccount, listAccounts, directionComplete,
} from '../../src/services/accounts.mjs';
import { createDestination } from '../../src/services/destinations.mjs';

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-accounts-'));
  const { store } = await openStore(dir);
  return store;
}

function telegramAccount(overrides = {}) {
  return {
    channelId: 'telegram',
    label: 'TG',
    config: { outbound: {} },
    secretChanges: [{ path: 'outbound.botToken', op: 'set', value: { kind: 'literal', value: '"tok-1"' } }],
    notificationEnabled: true,
    ...overrides,
  };
}

test('A05: account views expose configured secret paths but never secret values', async () => {
  const store = await freshStore();
  const view = await createAccount(store, telegramAccount(), { now: 100 });
  assert.equal(view.id.length > 0, true);
  assert.deepEqual(view.secretFields, [{ path: 'outbound.botToken', configured: true }]);
  assert.equal(view.revision, 0);
  assert.equal(view.destinationCount, 0);
  assert.equal(JSON.stringify(view).includes('tok-1'), false, 'literal secret leaked into the view');

  const fetched = getAccount(store, { id: view.id });
  assert.equal(JSON.stringify(fetched).includes('tok-1'), false);
  const page = listAccounts(store, {});
  assert.equal(page.total, 1);
  assert.equal(JSON.stringify(page).includes('tok-1'), false);
});

test('unknown channels and incomplete enabled credentials are rejected', async () => {
  const store = await freshStore();
  await assert.rejects(
    createAccount(store, telegramAccount({ channelId: 'nope' })),
    (e) => e instanceof DomainError && e.code === 'VALIDATION',
  );
  await assert.rejects(
    createAccount(store, telegramAccount({ secretChanges: [] })),
    (e) => e instanceof DomainError && e.code === 'VALIDATION',
  );
});

test('A01: rotating a credential keeps the account id and only bumps revisions', async () => {
  const store = await freshStore();
  const created = await createAccount(store, telegramAccount(), { now: 100 });
  const rotated = await updateAccount(store, {
    id: created.id,
    expectedRevision: created.revision,
    patch: {},
    secretChanges: [{ path: 'outbound.botToken', op: 'set', value: { kind: 'literal', value: '"tok-2"' } }],
  }, { now: 200 });
  assert.equal(rotated.id, created.id);
  assert.equal(rotated.revision, 1);
  assert.equal(rotated.policyRevision, 1, 'credential change advances policyRevision');
  assert.equal(JSON.stringify(rotated).includes('tok-2'), false);
});

test('A02: a flag patch preserves label, config, secrets and createdAt', async () => {
  const store = await freshStore();
  const created = await createAccount(store, telegramAccount(), { now: 100 });
  const patched = await updateAccount(store, {
    id: created.id,
    expectedRevision: created.revision,
    patch: { notificationEnabled: false },
  }, { now: 300 });
  assert.equal(patched.notificationEnabled, false);
  assert.equal(patched.label, 'TG');
  assert.deepEqual(patched.config, { outbound: {}, inbound: {} });
  assert.deepEqual(patched.secretFields, [{ path: 'outbound.botToken', configured: true }]);
  assert.equal(patched.createdAt, 100);
  assert.equal(patched.revision, 1);
  assert.equal(patched.policyRevision, 1);
});

test('a label-only patch does not advance policyRevision', async () => {
  const store = await freshStore();
  const created = await createAccount(store, telegramAccount(), { now: 100 });
  const renamed = await updateAccount(store, {
    id: created.id, expectedRevision: 0, patch: { label: 'Renamed' },
  });
  assert.equal(renamed.label, 'Renamed');
  assert.equal(renamed.policyRevision, 0);
});

test('optimistic concurrency: a stale expectedRevision is CONFLICT with currentRevision', async () => {
  const store = await freshStore();
  const created = await createAccount(store, telegramAccount(), { now: 100 });
  await updateAccount(store, { id: created.id, expectedRevision: 0, patch: { label: 'B' } });
  await assert.rejects(
    updateAccount(store, { id: created.id, expectedRevision: 0, patch: { label: 'C' } }),
    (e) => e instanceof DomainError && e.code === 'CONFLICT' && e.details.currentRevision === 1,
  );
});

test('non-writable patch fields are rejected', async () => {
  const store = await freshStore();
  const created = await createAccount(store, telegramAccount(), { now: 100 });
  for (const key of ['id', 'revision', 'policyRevision', 'createdAt', 'updatedAt']) {
    await assert.rejects(
      updateAccount(store, { id: created.id, expectedRevision: 0, patch: { [key]: 1 } }),
      (e) => e instanceof DomainError && e.code === 'VALIDATION',
      `patch.${key} must be rejected`,
    );
  }
});

test('A04: deleting an account atomically removes its strong references', async () => {
  const store = await freshStore();
  const account = await createAccount(store, telegramAccount(), { now: 100 });
  const destination = await createDestination(store, {
    accountId: account.id, label: 'chat', kind: 'private', target: { chatId: '42' },
  }, { now: 100 });

  // Seed dependent records directly to keep the test focused on the cleanup rule.
  await store.transact(null, (draft) => {
    draft.settings.defaultDestinationIds.push(destination.id);
    draft.cursors[account.id] = { transportData: {} };
    draft.principals.p1 = {
      id: 'p1', revision: 0, accountId: account.id, userId: 'u1', role: 'owner', canConverse: false,
      sessionIds: ['s1'], enabled: true, replyContextId: 'rc1', createdAt: 100, updatedAt: 100,
    };
    draft.replyContexts.rc1 = {
      id: 'rc1', accountId: account.id, userId: 'u1', chatId: '42', chatType: 'private',
      transportData: {}, expiresAt: null, createdAt: 100, updatedAt: 100,
    };
    draft.bindings.p1 = { principalId: 'p1', sessionId: 's1', updatedAt: 100 };
    draft.replyRefs.r1 = {
      id: 'r1', tokenHash: 'h', accountId: account.id, principalId: 'p1', replyContextId: 'rc1',
      interactionId: 'i1', interactionRevision: 0, policyRevision: 0, action: 'approve',
      messageId: null, expiresAt: 999, state: 'active', createdAt: 100,
    };
    draft.correlations.c1 = {
      id: 'c1', requestKey: 'k', accountId: account.id, principalId: 'p1', replyContextId: 'rc1',
      sessionId: 's1', hostRef: null, turnId: null, state: 'active', createdAt: 100, updatedAt: 100,
    };
    draft.pairing.pa1 = {
      id: 'pa1', accountId: account.id, codeHash: 'h', role: 'owner', canConverse: false,
      expiresAt: 999, state: 'active', createdAt: 100,
    };
    draft.routes.rt1 = {
      id: 'rt1', revision: 0, scope: 'global', scopeId: '*', destinationIds: [destination.id],
      quiet: null, createdAt: 100, updatedAt: 100,
    };
  });

  await removeAccount(store, { id: account.id, expectedRevision: 0 }, { now: 500 });
  const after = store.snapshot();
  assert.deepEqual(after.accounts, {});
  assert.deepEqual(after.destinations, {});
  assert.deepEqual(after.principals, {});
  assert.deepEqual(after.pairing, {});
  assert.deepEqual(after.bindings, {});
  assert.deepEqual(after.replyContexts, {});
  assert.deepEqual(after.replyRefs, {});
  assert.deepEqual(after.correlations, {});
  assert.equal(account.id in after.cursors, false);
  assert.deepEqual(after.settings.defaultDestinationIds, []);
  assert.deepEqual(after.routes.rt1.destinationIds, [], 'route reference cleared, route kept');
  assert.ok(after.activity.some((row) => row.status === 'removed'));
});

test('directionComplete tracks required account fields', () => {
  assert.equal(directionComplete('telegram', 'outbound', {}, {}), false);
  assert.equal(directionComplete('telegram', 'outbound', {}, { 'outbound.botToken': { kind: 'literal', value: '\"x\"' } }), true);
  assert.equal(directionComplete('bark', 'outbound', {}, {}), true, 'bark has no required outbound credential');
});