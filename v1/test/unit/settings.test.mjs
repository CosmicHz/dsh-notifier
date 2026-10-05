// T07 settings: separate settings.revision optimistic counter, default
// destination integrity, retention bounds and quiet flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/storage/store.mjs';
import { DomainError } from '../../src/domain/errors.mjs';
import { createAccount } from '../../src/services/accounts.mjs';
import { createDestination } from '../../src/services/destinations.mjs';
import { getSettings, updateSettings } from '../../src/services/settings.mjs';

async function freshStore() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-settings-'));
  const { store } = await openStore(dir);
  return store;
}

test('a fresh store exposes the documented default settings', async () => {
  const store = await freshStore();
  assert.deepEqual(getSettings(store), {
    revision: 0, defaultDestinationIds: [], quiet: false, activityRetentionDays: 7,
  });
});

test('updateSettings advances settings.revision once and enforces concurrency', async () => {
  const store = await freshStore();
  const updated = await updateSettings(store, { expectedRevision: 0, patch: { quiet: true } }, { now: 200 });
  assert.equal(updated.quiet, true);
  assert.equal(updated.revision, 1);

  await assert.rejects(
    updateSettings(store, { expectedRevision: 0, patch: { quiet: false } }),
    (e) => e instanceof DomainError && e.code === 'CONFLICT' && e.details.currentRevision === 1,
  );
  assert.equal(getSettings(store).quiet, true, 'a rejected patch must not publish');
});

test('defaultDestinationIds must reference existing destinations', async () => {
  const store = await freshStore();
  await assert.rejects(
    updateSettings(store, { expectedRevision: 0, patch: { defaultDestinationIds: ['missing'] } }),
    (e) => e instanceof DomainError && e.code === 'VALIDATION',
  );

  const account = await createAccount(store, {
    channelId: 'telegram',
    label: 'TG',
    config: { outbound: {} },
    secretChanges: [{ path: 'outbound.botToken', op: 'set', value: { kind: 'literal', value: 'tok-1' } }],
    notificationEnabled: true,
  }, { now: 100 });
  const destination = await createDestination(store, {
    accountId: account.id, label: 'chat', target: { chatId: '42' },
  }, { now: 100 });

  const updated = await updateSettings(store, { expectedRevision: 0, patch: { defaultDestinationIds: [destination.id] } });
  assert.deepEqual(updated.defaultDestinationIds, [destination.id]);
});

test('activityRetentionDays is bounded and other fields are rejected', async () => {
  const store = await freshStore();
  for (const bad of [0, 31, 3.5]) {
    await assert.rejects(
      updateSettings(store, { expectedRevision: 0, patch: { activityRetentionDays: bad } }),
      (e) => e instanceof DomainError && e.code === 'VALIDATION',
      `retention ${bad} must be rejected`,
    );
  }
  const ok = await updateSettings(store, { expectedRevision: 0, patch: { activityRetentionDays: 30 } });
  assert.equal(ok.activityRetentionDays, 30);

  await assert.rejects(
    updateSettings(store, { expectedRevision: 1, patch: { revision: 5 } }),
    (e) => e instanceof DomainError && e.code === 'VALIDATION',
  );
});