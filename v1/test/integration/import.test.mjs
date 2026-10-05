// T29 import acceptance (I01-I05; 09-IMPORT.md). Real Store on a temp dir, real
// files on disk. Only the canonical `channel:<type>:outbound` prefix is imported;
// everything else is skipped and reported, never fabricated into an account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/storage/store.mjs';
import { previewImport, applyImport } from '../../src/services/import.mjs';
import { listAccounts, getAccount } from '../../src/services/accounts.mjs';
import { listDestinations } from '../../src/services/destinations.mjs';

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-import-'));
  const { store } = await openStore(dir);
  const filePath = join(dir, 'old-store.json');
  const write = (value) => writeFile(filePath, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  const sha = async () => createHash('sha256').update(await readFile(filePath)).digest('hex');
  return { store, filePath, write, sha };
}

const validTelegram = { botToken: '123:ABC', chatId: '-100123' };

test('I01: only channel:<type>:outbound records import; other keys are ignored', async () => {
  const { store, filePath, write } = await scratch();
  await write({
    'channel:telegram:outbound': validTelegram,
    'admin:channel:telegram': { enabled: true },
    'telegram:account': { token: 'nope' },
    'channel:nope:outbound': { key: 'x' },
    routes: [{ match: '*' }],
  });
  const preview = previewImport(store, { file: filePath });
  assert.equal(preview.supported, true);
  assert.equal(preview.counts.total, 2, 'only the two canonical keys are considered');
  const byKey = Object.fromEntries(preview.items.map((i) => [i.sourceKey, i]));
  assert.equal(byKey['channel:telegram:outbound'].status, 'ready');
  assert.equal(byKey['channel:nope:outbound'].reason, 'UNKNOWN_CHANNEL');
  assert.equal(JSON.stringify(preview).includes('123:ABC'), false, 'preview never leaks a secret literal');

  const result = await applyImport(store, { file: filePath, sourceHash: preview.sourceHash });
  assert.equal(result.imported, 1);
  assert.equal(listAccounts(store, {}).total, 1);
  assert.equal(listDestinations(store, {}).total, 1);
});

test('I01: imported accounts are notification-only, control disabled, no secret in views', async () => {
  const { store, filePath, write } = await scratch();
  await write({ 'channel:telegram:outbound': validTelegram });
  const preview = previewImport(store, { file: filePath });
  await applyImport(store, { file: filePath, sourceHash: preview.sourceHash });
  const [account] = listAccounts(store, {}).items;
  assert.equal(account.notificationEnabled, true);
  assert.equal(account.controlEnabled, false);
  assert.equal(JSON.stringify(account).includes('123:ABC'), false, 'secret leaked into the account view');
  const fetched = getAccount(store, { id: account.id });
  assert.deepEqual(fetched.secretFields, [{ path: 'outbound.botToken', configured: true }]);
});

test('I02: unreadable/bad/unsafe input is skipped with a reason and writes nothing', async () => {
  const { store, filePath, write } = await scratch();
  assert.equal(previewImport(store, { file: join(filePath, '..', 'missing.json') }).reason, 'INPUT_UNREADABLE');

  await write('{ not json');
  assert.equal(previewImport(store, { file: filePath }).reason, 'BAD_JSON');

  await write('{"channel:telegram:outbound":{"__proto__":{"polluted":true}}}');
  assert.equal(previewImport(store, { file: filePath }).reason, 'UNSAFE_JSON');

  await write({ hello: 'world' });
  const none = previewImport(store, { file: filePath });
  assert.equal(none.supported, false);
  assert.equal(none.reason, 'NO_SUPPORTED_RECORDS');
  assert.equal(listAccounts(store, {}).total, 0, 'a no-op import never creates an account');
});

test('I02: incomplete records are skipped whole, never a half-configured account', async () => {
  const { store, filePath, write } = await scratch();
  await write({
    'channel:telegram:outbound': { botToken: '123:ABC' }, // missing required destination chatId
    'channel:bark:outbound': { bogus: 1, key: 'k1' }, // unknown field dropped, still ready
  });
  const preview = previewImport(store, { file: filePath });
  const byKey = Object.fromEntries(preview.items.map((i) => [i.sourceKey, i]));
  assert.equal(byKey['channel:telegram:outbound'].reason, 'MISSING_REQUIRED:target.chatId');
  assert.equal(byKey['channel:bark:outbound'].status, 'ready');
  assert.deepEqual(byKey['channel:bark:outbound'].dropped, ['bogus']);

  const result = await applyImport(store, { file: filePath, sourceHash: preview.sourceHash });
  assert.equal(result.imported, 1, 'only the complete record lands');
  assert.equal(listAccounts(store, {}).total, 1);
});

test('I03: the source file bytes are unchanged by preview and apply', async () => {
  const { store, filePath, write, sha } = await scratch();
  await write({ 'channel:telegram:outbound': validTelegram });
  const before = await sha();
  const preview = previewImport(store, { file: filePath });
  await applyImport(store, { file: filePath, sourceHash: preview.sourceHash });
  assert.equal(await sha(), before);
});

test('I04: re-importing the identical file is idempotent and adds nothing', async () => {
  const { store, filePath, write } = await scratch();
  await write({ 'channel:telegram:outbound': validTelegram });
  const first = previewImport(store, { file: filePath });
  await applyImport(store, { file: filePath, sourceHash: first.sourceHash });
  assert.equal(listAccounts(store, {}).total, 1);

  const second = previewImport(store, { file: filePath });
  assert.equal(second.items[0].status, 'skipped');
  assert.equal(second.items[0].reason, 'already-imported');
  assert.equal(second.counts.alreadyImported, 1);

  const again = await applyImport(store, { file: filePath, sourceHash: second.sourceHash });
  assert.equal(again.imported, 0);
  assert.equal(listAccounts(store, {}).total, 1, 'no duplicate account is created');
});

test('I04: a changed file is a new fingerprint (possible duplicate), never an overwrite', async () => {
  const { store, filePath, write } = await scratch();
  await write({ 'channel:telegram:outbound': validTelegram });
  const first = previewImport(store, { file: filePath });
  await applyImport(store, { file: filePath, sourceHash: first.sourceHash });

  await write({ 'channel:telegram:outbound': { ...validTelegram, botToken: '999:XYZ' } });
  const changed = previewImport(store, { file: filePath });
  assert.equal(changed.items[0].status, 'ready');
  assert.equal(changed.items[0].reason, 'possible-duplicate');

  await assert.rejects(applyImport(store, { file: filePath, sourceHash: first.sourceHash }),
    (e) => e.code === 'CONFLICT');
  const applied = await applyImport(store, { file: filePath, sourceHash: changed.sourceHash });
  assert.equal(applied.imported, 1);
  assert.equal(listAccounts(store, {}).total, 2, 'the earlier account is not overwritten');
});

test('I05: a hash mismatch or missing hash aborts with no write to the new store', async () => {
  const { store, filePath, write } = await scratch();
  await write({ 'channel:telegram:outbound': validTelegram });
  const preview = previewImport(store, { file: filePath });

  await assert.rejects(applyImport(store, { file: filePath, sourceHash: 'deadbeef' }), (e) => e.code === 'CONFLICT');
  await assert.rejects(applyImport(store, { file: filePath }), (e) => e.code === 'VALIDATION');
  assert.equal(listAccounts(store, {}).total, 0, 'no partial account is left behind');
  assert.equal(store.revision, 0, 'the store was never mutated');
  assert.ok(preview.sourceHash.length === 64);
});