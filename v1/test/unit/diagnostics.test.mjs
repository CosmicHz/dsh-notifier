import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDiagnostics, collectRecentErrors, redactLogRecord, JsonlLog, MAX_RECENT_ERRORS,
} from '../../src/services/diagnostics.mjs';
import { REDACTED } from '../../src/security/redact.mjs';

function row(overrides = {}) {
  return {
    id: 'a', time: 1, kind: 'notify', accountId: null, sessionId: null,
    status: 'failed', code: 'NETWORK', ...overrides,
  };
}

test('collectRecentErrors returns metadata only, newest first, capped at 100', () => {
  const activity = [];
  for (let i = 0; i < MAX_RECENT_ERRORS + 20; i++) activity.push(row({ id: `a${i}`, time: i }));
  activity.push(row({ id: 'okrow', status: 'ok' }));
  const errors = collectRecentErrors(activity, {});
  assert.equal(errors.length, MAX_RECENT_ERRORS);
  assert.equal(errors[0].id, `a${MAX_RECENT_ERRORS + 19}`);
  assert.equal(errors[0].code, 'NETWORK');
  assert.equal(errors.some((e) => e.id === 'okrow'), false);
  assert.deepEqual(Object.keys(errors[0]).sort(), ['accountId', 'code', 'id', 'kind', 'sessionId', 'status', 'time']);
});

test('collectRecentErrors skips success-like statuses and masks secret text', () => {
  const activity = [
    row({ id: 'x', status: 'ok' }),
    row({ id: 'y', status: 'skipped' }),
    row({ id: 'z', status: 'uncertain', code: 'Bearer abcdef123456' }),
  ];
  const errors = collectRecentErrors(activity, { secretValues: [] });
  assert.deepEqual(errors.map((e) => e.id), ['z']);
  assert.ok(errors[0].code.includes(REDACTED), errors[0].code);
  assert.equal(errors[0].code.includes('abcdef123456'), false);
});

test('redactLogRecord masks secret-named keys and secret literals deeply', () => {
  const safe = redactLogRecord(
    { token: 'abc', nested: { apiKey: 'k', note: 'used sk-abcdef123456 here', list: ['Bearer zzzzzzzz1234'] } },
    ['sk-abcdef123456'],
  );
  assert.equal(safe.token, REDACTED);
  assert.equal(safe.nested.apiKey, REDACTED);
  assert.equal(safe.nested.note.includes('sk-abcdef123456'), false);
  assert.ok(safe.nested.note.includes(REDACTED));
  assert.ok(safe.nested.list[0].includes(REDACTED));
});

test('buildDiagnostics produces a redacted, metadata-only export', () => {
  const activity = [
    row({ id: 'e1', status: 'failed', code: 'NETWORK' }),
    row({ id: 'e2', status: 'ok' }),
  ];
  const report = buildDiagnostics({
    version: { name: 'dsh-notifier', version: '1.0.0-dev.0' },
    capabilities: { converse: false, questions: true, token: 'should-hide' },
    health: 'degraded',
    counts: { accounts: 2, destinations: 1.9, bogus: 'nope' },
    activity,
    secretValues: [],
    now: 12345,
  });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.generatedAt, 12345);
  assert.equal(report.version.version, '1.0.0-dev.0');
  assert.equal(report.capabilities.token, REDACTED);
  assert.equal(report.health, 'degraded');
  assert.deepEqual(report.counts, { accounts: 2, destinations: 1 });
  assert.deepEqual(report.recentErrors.map((e) => e.id), ['e1']);
  // diagnostics must never expose filesystem paths
  assert.equal('path' in report, false);
});

test('JsonlLog writes redacted JSONL lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-log-'));
  const log = new JsonlLog({ dir, maxBytes: 1024, maxFiles: 3 });
  log.append({ level: 'info', message: 'sent', token: 'supersecret' });
  log.append({ level: 'error', message: 'failed with sk-abcdef123456' }, { secretValues: ['sk-abcdef123456'] });
  const lines = (await readFile(log.path, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].token, REDACTED);
  assert.equal(JSON.stringify(lines[1]).includes('sk-abcdef123456'), false);
  assert.ok(lines[1].message.includes(REDACTED));
});

test('JsonlLog rotates and keeps at most maxFiles files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-log-rot-'));
  const log = new JsonlLog({ dir, maxBytes: 200, maxFiles: 3 });
  for (let i = 0; i < 30; i++) log.append({ i, message: 'x'.repeat(40) });
  const names = (await readdir(dir)).sort();
  assert.ok(names.includes('notifier.log'), names.join(','));
  assert.ok(names.includes('notifier.log.1'), names.join(','));
  assert.ok(names.includes('notifier.log.2'), names.join(','));
  assert.equal(names.includes('notifier.log.3'), false, 'must not exceed maxFiles archives');
  // newest record is always in the live file
  const live = (await readFile(log.path, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(live.at(-1).i, 29);
});