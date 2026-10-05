// T05 destinations: target field contract, secret target capture, reference
// integrity on delete, account ownership and optimistic concurrency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/storage/store.mjs';
import { DomainError } from '../../src/domain/errors.mjs';
import { createAccount } from '../../src/services/accounts.mjs';
import {
  createDestination, updateDestination, removeDestination, getDestination, listDestinations,
} from '../../src/services/destinations.mjs';

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-destinations-'));
  const { store } = await openStore(dir);
  return store;
}

async function telegramAccount(store, overrides = {}) {
  return createAccount(store, {
    channelId: 'telegram',
    label: 'TG',
    config: { outbound: {} },
    secretChanges: [{ path: 'outbound.botToken', op: 'set', value: { kind: 'literal', value: 'tok-1' } }],
    notificationEnabled: true,
    ...overrides,
  }, { now: 100 });
}

async function onebotAccount(store) {
  return createAccount(store, {
    channelId: 'onebot',
    label: 'OB',
    config: { outbound: {} },
    secretChanges: [{ path: 'outbound.baseUrl', op: 'set', value: { kind: 'literal', value: 'http://127.0.0.1:3000' } }],
    notificationEnabled: true,
  }, { now: 100 });
}

test('a destination requires an existing account and a complete declared target', async () => {
  const store = await freshStore();
  await assert.rejects(
    createDestination(store, { accountId: 'missing', label: 'x', kind: 'private', target: {} }),
    (e) => e instanceof DomainError && e.code === 'NOT_FOUND',
  );

  const account = await telegramAccount(store);
  await assert.rejects(
    createDestination(store, { accountId: account.id, label: 'chat', kind: 'private', target: { nope: '1' } }),
    (e) => e instanceof DomainError && e.code === 'VALIDATION',
  );
  await assert.rejects(
    createDestination(store, { accountId: account.id, label: 'chat', kind: 'private', target: {} }),
    (e) => e instanceof DomainError && e.code === 'VALIDATION',
    'chatId is a required declared target field',
  );
});

test('createDestination defaults the kind and returns a secret-free view', async () => {
  const store = await freshStore();
  const account = await telegramAccount(store);
  const view = await createDestination(store, {
    accountId: account.id, label: 'chat', target: { chatId: '42' },
  }, { now: 150 });
  assert.equal(view.accountId, account.id);
  assert.equal(view.kind, 'private', 'telegram defaults to a private destination');
  assert.deepEqual(view.target, { chatId: '42' });
  assert.equal(view.revision, 0);
  assert.deepEqual(view.secretFields, []);
  assert.equal(getDestination(store, { id: view.id }).label, 'chat');

  const page = listDestinations(store, { accountId: account.id });
  assert.equal(page.total, 1);
  assert.equal(listDestinations(store, { accountId: 'other' }).total, 0);
});

test('secret destination target fields are captured, not exposed as public target', async () => {
  const store = await freshStore();
  const account = await onebotAccount(store);
  const view = await createDestination(store, {
    accountId: account.id,
    label: 'qq',
    kind: 'private',
    target: { userId: 'u-secret-777' },
  });
  assert.equal('userId' in view.target, false, 'secret target field leaked into public target');
  assert.deepEqual(view.target, {});
  assert.deepEqual(view.secretFields, [{ path: 'target.userId', configured: true }]);
  assert.equal(JSON.stringify(view).includes('u-secret-777'), false, 'secret value leaked into the view');
  const stored = store.snapshot().destinations[view.id];
  assert.equal('userId' in stored.target, false, 'secret target field must not be stored publicly');
  assert.deepEqual(stored.secrets['target.userId'], { kind: 'literal', value: 'u-secret-777' });
});

test('destination patch validates target and uses optimistic concurrency', async () => {
  const store = await freshStore();
  const account = await telegramAccount(store);
  const created = await createDestination(store, {
    accountId: account.id, label: 'chat', target: { chatId: '42' },
  });
  const updated = await updateDestination(store, {
    id: created.id, expectedRevision: 0, patch: { label: 'renamed', target: { chatId: '99' } },
  });
  assert.equal(updated.label, 'renamed');
  assert.deepEqual(updated.target, { chatId: '99' });
  assert.equal(updated.revision, 1);

  await assert.rejects(
    updateDestination(store, { id: created.id, expectedRevision: 0, patch: { label: 'x' } }),
    (e) => e instanceof DomainError && e.code === 'CONFLICT' && e.details.currentRevision === 1,
  );
  await assert.rejects(
    updateDestination(store, { id: created.id, expectedRevision: 1, patch: { accountId: 'z' } }),
    (e) => e instanceof DomainError && e.code === 'VALIDATION',
  );
});

test('removing a destination clears every route and default reference atomically', async () => {
  const store = await freshStore();
  const account = await telegramAccount(store);
  const destination = await createDestination(store, {
    accountId: account.id, label: 'chat', target: { chatId: '42' },
  });
  await store.transact(null, (draft) => {
    draft.settings.defaultDestinationIds.push(destination.id);
    draft.routes.rt1 = {
      id: 'rt1', revision: 0, scope: 'global', scopeId: '*', destinationIds: [destination.id],
      quiet: null, createdAt: 100, updatedAt: 100,
    };
  });

  await removeDestination(store, { id: destination.id, expectedRevision: 0 }, { now: 500 });
  const after = store.snapshot();
  assert.deepEqual(after.destinations, {});
  assert.deepEqual(after.settings.defaultDestinationIds, []);
  assert.deepEqual(after.routes.rt1.destinationIds, [], 'route kept but reference cleared');
});