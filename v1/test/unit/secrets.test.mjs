import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySecretChanges, normalizeSecretValue, resolveSecret, resolveSecrets,
  isMaskedValue, secretFieldStatus,
} from '../../src/security/secrets.mjs';
import { redactObject, redactText, toRedactedView } from '../../src/security/redact.mjs';
import { DomainError } from '../../src/domain/errors.mjs';
import { inboundSecrets } from '../../src/providers/platform.mjs';

test('A05: keep / set / clear semantics', () => {
  const base = {
    'outbound.token': { kind: 'literal', value: '"old"' },
    'outbound.secret': { kind: 'env', name: 'KEEP_ME' },
  };
  const next = applySecretChanges(base, [
    { path: 'outbound.token', op: 'set', value: { kind: 'literal', value: '"new"' } },
    { path: 'outbound.secret', op: 'clear' },
    { path: 'inbound.webhook', op: 'set', value: { kind: 'env', name: 'HOOK' } },
  ]);
  assert.deepEqual(next, {
    'outbound.token': { kind: 'literal', value: '"new"' },
    'inbound.webhook': { kind: 'env', name: 'HOOK' },
  });
  // Absent paths are kept untouched.
  assert.equal(base['outbound.token'].value, '"old"', 'base is not mutated');
});

test('create forbids clear', () => {
  assert.throws(
    () => applySecretChanges({}, [{ path: 'outbound.token', op: 'clear' }], { creating: true }),
    (e) => e instanceof DomainError && e.code === 'VALIDATION',
  );
});

test('masked values are rejected', () => {
  assert.equal(isMaskedValue('****'), true);
  assert.equal(isMaskedValue('••••'), true);
  assert.equal(isMaskedValue('real-token'), false);
  assert.throws(() => normalizeSecretValue({ kind: 'literal', value: '****' }), /masked/);
});

test('invalid secret paths and env names are rejected', () => {
  assert.throws(
    () => applySecretChanges({}, [{ path: 'evil.path', op: 'set', value: { kind: 'env', name: 'X' } }]),
    (e) => e instanceof DomainError && e.code === 'VALIDATION',
  );
  assert.throws(() => normalizeSecretValue({ kind: 'env', name: 'lowercase' }), /NAME/);
  assert.throws(() => normalizeSecretValue({ kind: 'weird', value: 'x' }), /literal or env/);
});

test('env resolution reads the environment and never persists the value', () => {
  const secret = { kind: 'env', name: 'DSH_TEST_TOKEN' };
  const env = { DSH_TEST_TOKEN: 's3cr3t' };
  const resolved = resolveSecret(secret, env);
  assert.deepEqual(resolved, { ok: true, value: 's3cr3t' });
  // The stored envelope is unchanged: only the env name lives in state.
  assert.deepEqual(secret, { kind: 'env', name: 'DSH_TEST_TOKEN' });

  assert.deepEqual(resolveSecret(secret, {}), { ok: false, reason: 'MISSING' });
  assert.deepEqual(resolveSecret({ kind: 'env', name: 'BAD NAME' }, {}), { ok: false, reason: 'INVALID' });
});

test('literal resolution returns the stored value', () => {
  // Literal secrets are JSON-encoded (02-DATA.md, 15-FIELD-COPY.md, R08 fix)
  assert.deepEqual(resolveSecret({ kind: 'literal', value: '"abc"' }), { ok: true, value: 'abc' });
  assert.deepEqual(resolveSecret({ kind: 'literal', value: '123' }), { ok: true, value: 123 });
  assert.deepEqual(resolveSecret({ kind: 'literal', value: '{"key":"val"}' }), { ok: true, value: { key: 'val' } });
});

test('resolveSecrets partitions values / missing / invalid', () => {
  const out = resolveSecrets(
    {
      'outbound.a': { kind: 'literal', value: '"v"' },
      'outbound.b': { kind: 'env', name: 'PRESENT' },
      'outbound.c': { kind: 'env', name: 'ABSENT' },
      'outbound.d': { kind: 'nope' },
    },
    { PRESENT: 'yes' },
  );
  assert.deepEqual(out.values, { 'outbound.a': 'v', 'outbound.b': 'yes' });
  assert.deepEqual(out.missing, ['outbound.c']);
  assert.deepEqual(out.invalid, ['outbound.d']);
});

test('secretFieldStatus lists configured paths only (no values)', () => {
  const status = secretFieldStatus({ 'outbound.token': { kind: 'literal', value: '"x"' } });
  assert.deepEqual(status, [{ path: 'outbound.token', configured: true }]);
  assert.equal(JSON.stringify(status).includes('x'), false);
});

test('redaction hides secrets in objects, views and text', () => {
  const record = {
    id: 'a1',
    label: 'Bot',
    secrets: { 'outbound.token': { kind: 'literal', value: '"leak-me"' } },
    token: 'leak-me-too',
    nested: { apiKey: 'nope' },
  };
  const view = toRedactedView(record);
  assert.equal('secrets' in view, false);
  assert.equal(view.token, '[redacted]');
  assert.equal(view.nested.apiKey, '[redacted]');
  assert.equal(view.label, 'Bot');

  assert.equal(redactObject({ token: 'x' }).token, '[redacted]');
  assert.equal(redactText('auth Bearer abcdef123456 ok', []), 'auth Bearer [redacted] ok');
  assert.equal(redactText('value leak-me here', ['leak-me']), 'value [redacted] here');
  assert.equal(redactText('short ab masked', ['ab']), 'short ab masked', 'short values are not masked');
});
// --- N02: typed validation after decode ----------------------------------

const stringField = { field: 'token', type: 'string' };
const arrField = { field: 'uids', type: 'string[]' };
const recField = { field: 'headers', type: 'record<string,string>' };

test('N02: a decoded value must satisfy the field descriptor type', () => {
  assert.deepEqual(resolveSecret({ kind: 'literal', value: '"ok"' }, process.env, stringField), { ok: true, value: 'ok' });
  // A JSON object decodes fine but is not a string: rejected, never String()'d.
  assert.deepEqual(resolveSecret({ kind: 'literal', value: '{"a":1}' }, process.env, stringField), { ok: false, reason: 'INVALID' });
  assert.deepEqual(resolveSecret({ kind: 'literal', value: '123' }, process.env, stringField), { ok: false, reason: 'INVALID' });
  assert.deepEqual(resolveSecret({ kind: 'literal', value: '["a","b"]' }, process.env, arrField), { ok: true, value: ['a', 'b'] });
  assert.deepEqual(resolveSecret({ kind: 'literal', value: '["a",1]' }, process.env, arrField), { ok: false, reason: 'INVALID' });
  assert.deepEqual(resolveSecret({ kind: 'literal', value: '{"X":"1"}' }, process.env, recField), { ok: true, value: { X: '1' } });
  assert.deepEqual(resolveSecret({ kind: 'literal', value: '{"X":1}' }, process.env, recField), { ok: false, reason: 'INVALID' });
});

test('N02: env values are validated after decoding too', () => {
  assert.deepEqual(resolveSecret({ kind: 'env', name: 'N02_T' }, { N02_T: 'abc' }, stringField), { ok: true, value: 'abc' });
  assert.deepEqual(resolveSecret({ kind: 'env', name: 'N02_A' }, { N02_A: '["x"]' }, arrField), { ok: true, value: ['x'] });
  assert.deepEqual(resolveSecret({ kind: 'env', name: 'N02_A' }, { N02_A: 'not-json' }, arrField), { ok: false, reason: 'INVALID' });
  assert.deepEqual(resolveSecret({ kind: 'env', name: 'N02_A' }, { N02_A: '{"a":1}' }, arrField), { ok: false, reason: 'INVALID' });
});

test('N02: inboundSecrets rejects a non-string value instead of coercing it', () => {
  const bad = { channelId: 'telegram', secrets: { 'inbound.botToken': { kind: 'literal', value: '{"a":1}' } } };
  assert.throws(() => inboundSecrets(bad, { botToken: true }), (e) => e.code === 'NOT_CONFIGURED');
  const ok = { channelId: 'telegram', secrets: { 'inbound.botToken': { kind: 'literal', value: '"tok"' } } };
  assert.deepEqual(inboundSecrets(ok, { botToken: true }), { botToken: 'tok' });
});
