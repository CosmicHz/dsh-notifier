// T05 connections: account + first destination commit in ONE transaction, so a
// failure can never leave an orphan account or destination.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/storage/store.mjs';
import { DomainError } from '../../src/domain/errors.mjs';
import { createConnection } from '../../src/services/connections.mjs';

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-connections-'));
  const { store } = await openStore(dir);
  return store;
}

function telegramConnection(overrides = {}) {
  return {
    channelId: 'telegram',
    label: 'TG',
    config: { outbound: {} },
    secretChanges: [{ path: 'outbound.botToken', op: 'set', value: { kind: 'literal', value: '"tok-1"' } }],
    notificationEnabled: true,
    destination: { label: 'chat', target: { chatId: '42' } },
    ...overrides,
  };
}

test('createConnection commits the account and its first destination together', async () => {
  const store = await freshStore();
  const result = await createConnection(store, telegramConnection(), { now: 100 });
  assert.equal(result.account.channelId, 'telegram');
  assert.equal(result.destination.accountId, result.account.id);
  assert.equal(result.destination.kind, 'private');
  assert.equal(store.revision, 1, 'one connection is one global revision');
  assert.equal(Object.keys(store.snapshot().accounts).length, 1);
  assert.equal(Object.keys(store.snapshot().destinations).length, 1);
});

test('makeDefault appends the first destination and advances settings.revision once', async () => {
  const store = await freshStore();
  const before = store.snapshot().settings.revision;
  const result = await createConnection(store, telegramConnection({ makeDefault: true }));
  const settings = store.snapshot().settings;
  assert.deepEqual(settings.defaultDestinationIds, [result.destination.id]);
  assert.equal(settings.revision, before + 1);
});

test('a bad destination target leaves no orphan account behind', async () => {
  const store = await freshStore();
  await assert.rejects(
    createConnection(store, telegramConnection({ destination: { label: 'chat', target: {} } })),
    (e) => e instanceof DomainError && e.code === 'VALIDATION',
  );
  const after = store.snapshot();
  assert.deepEqual(after.accounts, {}, 'account must roll back with the destination');
  assert.deepEqual(after.destinations, {});
  assert.equal(after.revision, 0, 'failed connection must not advance the revision');
});

test('a bad account credential leaves no orphan destination behind', async () => {
  const store = await freshStore();
  await assert.rejects(
    createConnection(store, telegramConnection({ secretChanges: [] })),
    (e) => e instanceof DomainError && e.code === 'VALIDATION',
  );
  const after = store.snapshot();
  assert.deepEqual(after.accounts, {});
  assert.deepEqual(after.destinations, {});
});

test('createConnection requires a destination and a valid label', async () => {
  const store = await freshStore();
  await assert.rejects(
    async () => createConnection(store, telegramConnection({ destination: undefined })),
    (e) => e instanceof DomainError && e.code === 'VALIDATION',
  );
  await assert.rejects(
    async () => createConnection(store, telegramConnection({ destination: { label: '' } })),
    (e) => e instanceof DomainError && e.code === 'VALIDATION',
  );
});