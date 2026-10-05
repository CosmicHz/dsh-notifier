import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateState,
  createEmptyState,
  compoundKey,
  assertJsonShape,
} from '../../src/domain/schema.mjs';
import { DomainError } from '../../src/domain/errors.mjs';

const NOW = 1_700_000_000_000;

function account(id = 'acc1', overrides = {}) {
  return {
    id,
    revision: 0,
    channelId: 'telegram',
    label: 'Bot',
    enabled: true,
    notificationEnabled: true,
    controlEnabled: false,
    config: { outbound: {}, inbound: {} },
    secrets: {},
    policyRevision: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function destination(id = 'dst1', accountId = 'acc1', overrides = {}) {
  return {
    id,
    revision: 0,
    accountId,
    label: 'Private chat',
    kind: 'private',
    target: { chatId: '123' },
    secrets: {},
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function principal(id = 'prn1', accountId = 'acc1', replyContextId = 'rc1', overrides = {}) {
  return {
    id,
    revision: 0,
    accountId,
    userId: 'u1',
    role: 'owner',
    canConverse: false,
    sessionIds: [],
    enabled: true,
    replyContextId,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function replyContext(id = 'rc1', accountId = 'acc1', overrides = {}) {
  return {
    id,
    accountId,
    userId: 'u1',
    chatId: '123',
    chatType: 'private',
    transportData: {},
    expiresAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function validState() {
  const s = createEmptyState();
  s.accounts.acc1 = account();
  s.destinations.dst1 = destination();
  s.replyContexts.rc1 = replyContext();
  s.principals.prn1 = principal();
  s.routes.r1 = {
    id: 'r1', revision: 0, scope: 'global', scopeId: '*',
    destinationIds: ['dst1'], quiet: null, createdAt: NOW, updatedAt: NOW,
  };
  s.settings.defaultDestinationIds = ['dst1'];
  s.revision = 3;
  return s;
}

function expectInvalid(state, matcher) {
  try {
    validateState(state);
    assert.fail('expected validation to throw');
  } catch (err) {
    assert.ok(err instanceof DomainError, 'must throw DomainError');
    assert.equal(err.code, 'VALIDATION');
    if (matcher) assert.match(JSON.stringify(err.details.errors), matcher);
  }
}

test('empty state is valid', () => {
  assert.equal(validateState(createEmptyState()).schemaVersion, 1);
});

test('fully populated state is valid', () => {
  const s = validState();
  assert.equal(validateState(s), s);
});

test('non-plain state is rejected', () => {
  assert.throws(() => validateState([]), (e) => e instanceof DomainError && e.code === 'VALIDATION');
  assert.throws(() => validateState(null), (e) => e instanceof DomainError && e.code === 'VALIDATION');
});

test('unknown root field is rejected', () => {
  const s = validState();
  s.extra = 1;
  expectInvalid(s, /unknown field/);
});

test('unknown entity field is rejected', () => {
  const s = validState();
  s.accounts.acc1.bogus = true;
  expectInvalid(s, /unknown field/);
});

test('prototype key is rejected', () => {
  const s = validState();
  s.accounts.acc1.config.outbound = JSON.parse('{"__proto__": {"polluted": 1}}');
  expectInvalid(s);
});

test('depth over 16 is rejected', () => {
  let deep = 1;
  for (let i = 0; i < 18; i++) deep = { n: deep };
  assert.throws(() => assertJsonShape({ deep }), (e) => e instanceof DomainError && e.code === 'VALIDATION');
});

test('foreign key to unknown account is rejected', () => {
  const s = validState();
  s.principals.prn1.accountId = 'ghost';
  expectInvalid(s, /unknown account/);
});

test('route referencing unknown destination is rejected', () => {
  const s = validState();
  s.routes.r1.destinationIds = ['ghost'];
  expectInvalid(s, /unknown destination/);
});

test('route with both fields null is rejected', () => {
  const s = validState();
  s.routes.r1.destinationIds = null;
  s.routes.r1.quiet = null;
  expectInvalid(s, /at least one/);
});

test('global route scopeId must be star', () => {
  const s = validState();
  s.routes.r1.scopeId = 'x';
  expectInvalid(s, /global scope requires/);
});

test('account limit is enforced', () => {
  const s = createEmptyState();
  for (let i = 0; i < 101; i++) s.accounts[`a${i}`] = account(`a${i}`);
  expectInvalid(s, /exceeds 100/);
});

test('two enabled owners in one account are rejected', () => {
  const s = validState();
  s.principals.prn2 = principal('prn2', 'acc1', 'rc1', { userId: 'u2' });
  expectInvalid(s, /enabled owners/);
});

test('compound request key is required', () => {
  const s = validState();
  s.requests.plainkey = {
    hash: 'h', kind: 'effect', status: 'done', result: null, createdAt: NOW, expiresAt: NOW + 1000,
  };
  expectInvalid(s, /compound key/);

  const s2 = validState();
  s2.requests[compoundKey(['local-owner', 'owner', 'notify', 'req1'])] = {
    hash: 'h', kind: 'effect', status: 'done', result: null, createdAt: NOW, expiresAt: NOW + 1000,
  };
  assert.equal(validateState(s2), s2);
});

test('secret envelope must be literal or env', () => {
  const s = validState();
  s.accounts.acc1.secrets['outbound.token'] = { kind: 'env', name: 'lower_case' };
  expectInvalid(s, /env var name/);

  const s2 = validState();
  s2.accounts.acc1.secrets['outbound.token'] = { kind: 'env', name: 'TELEGRAM_TOKEN' };
  assert.equal(validateState(s2), s2);

  const s3 = validState();
  s3.accounts.acc1.secrets['outbound.token'] = { kind: 'weird', value: 'x' };
  expectInvalid(s3, /literal|env/);
});

test('map key must equal entity id', () => {
  const s = validState();
  s.accounts.acc1.id = 'different';
  expectInvalid(s, /map key must equal/);
});

test('activity entry is metadata only and validated', () => {
  const s = validState();
  s.activity.push({ id: 'a1', time: NOW, kind: 'send', accountId: 'acc1', sessionId: null, status: 'ok', code: null });
  assert.equal(validateState(s), s);

  const bad = validState();
  bad.activity.push({ id: 'a1', time: NOW, kind: 'send', status: 'ok', body: 'chat text' });
  expectInvalid(bad, /unknown field/);
});

test('retention days must be within 1..30', () => {
  const s = validState();
  s.settings.activityRetentionDays = 0;
  expectInvalid(s, /activityRetentionDays/);
  s.settings.activityRetentionDays = 31;
  expectInvalid(s, /activityRetentionDays/);
});