import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  descriptors, channelDescriptors, channels, editorFields, channelById,
  descriptors as descriptorsFn, validateDestinationTarget, validateAccountConfig,
  fieldVisible, fieldRequired, targetFieldNames,
} from '../../src/domain/descriptors.mjs';
import {
  fieldCopy, controlFor, controlsFor, describeProblem, errorMessage,
} from '../../src/ui/field-copy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const specDir = join(here, '..', '..', '..', 'docs', 'developer', 'v1-flash-v3', 'spec');
const specChannels = JSON.parse(readFileSync(join(specDir, 'CHANNELS.json'), 'utf8'));
const specFields = JSON.parse(readFileSync(join(specDir, 'EDITOR-FIELDS.json'), 'utf8'));

test('29 descriptors: 28 outbound and 6 inbound, wechat-ilink inbound-only', () => {
  const list = descriptors();
  assert.equal(list.length, 29);
  assert.deepEqual(list.map((d) => d.id).sort(), specChannels.map((c) => c.id).sort());
  assert.equal(list.filter((d) => d.outbound).length, 28);
  assert.equal(list.filter((d) => d.inbound).length, 6);
  const ilink = list.find((d) => d.id === 'wechat-ilink');
  assert.equal(ilink.outbound, false);
  assert.equal(ilink.inbound, true);
  assert.equal(ilink.capabilities.controlReply, true);
  assert.equal(ilink.capabilities.outbound, false);
});

test('controlReply is true exactly for inbound channels', () => {
  for (const d of descriptors()) {
    assert.equal(d.capabilities.controlReply, d.inbound, d.id);
  }
});

test('every frozen editor field is represented with zh+en copy', () => {
  assert.equal(editorFields.length, specFields.length);
  for (const spec of specFields) {
    const field = editorFields.find((f) => f.id === spec.id);
    assert.ok(field, `missing field ${spec.id}`);
    const zh = fieldCopy(field, 'zh');
    const en = fieldCopy(field, 'en');
    assert.ok(zh.label.length > 0, `${spec.id} zh label`);
    assert.ok(en.label.length > 0, `${spec.id} en label`);
    assert.equal(zh.label, spec.zh.label);
    assert.equal(en.help, spec.en.help);
  }
});

test('destination target fields match CHANNELS.json exactly', () => {
  for (const spec of specChannels) {
    assert.deepEqual(targetFieldNames(spec.id).sort(), [...spec.targetFields].sort(), spec.id);
    const d = descriptors().find((x) => x.id === spec.id);
    assert.deepEqual(d.targetFields, [...spec.targetFields].sort());
  }
});

test('conditionals: qq-bot userId/groupId follow targetType', () => {
  const userId = editorFields.find((f) => f.id === 'qq-bot.outbound.userId');
  const groupId = editorFields.find((f) => f.id === 'qq-bot.outbound.groupId');
  assert.equal(fieldVisible(userId, { targetType: 'user' }), true);
  assert.equal(fieldVisible(userId, { targetType: 'group' }), false);
  assert.equal(fieldRequired(userId, { targetType: 'user' }), true);
  assert.equal(fieldRequired(userId, { targetType: 'group' }), false);
  assert.equal(fieldVisible(groupId, { targetType: 'group' }), true);
  assert.equal(fieldRequired(groupId, { targetType: 'group' }), true);
});

test('enum and min/max constraints come from the machine fields', () => {
  const tgTimeout = editorFields.find((f) => f.id === 'telegram.outbound.timeoutMs');
  const control = controlFor(tgTimeout);
  assert.equal(control.minimum, 1000);
  assert.equal(control.maximum, 60000);
  const targetType = editorFields.find((f) => f.id === 'qq-bot.outbound.targetType');
  assert.ok(Array.isArray(controlFor(targetType).enum));
  assert.ok(controlFor(targetType).enum.includes('user'));
});

test('destination target validation rejects undeclared keys', () => {
  assert.deepEqual(validateDestinationTarget('telegram', { chatId: '123' }), []);
  const problems = validateDestinationTarget('telegram', { chatId: '123', evil: 'x' });
  assert.equal(problems.some((p) => /evil/.test(p)), true);
  const missing = validateDestinationTarget('telegram', {});
  assert.equal(missing.some((p) => /chatId: required/.test(p)), true);
});

test('target type constraints of descriptors are enforced', () => {
  const onebot = validateDestinationTarget('onebot', { messageType: 'private', userId: 'u1' });
  assert.deepEqual(onebot, []);
  const bad = validateDestinationTarget('onebot', { messageType: 'nope' });
  assert.equal(bad.some((p) => /messageType/.test(p)), true);
});

test('account config validation uses account-owned public fields', () => {
  // timeoutMs is a public account field for telegram.
  assert.deepEqual(validateAccountConfig('telegram', 'outbound', { timeoutMs: 5000 }), []);
  const bad = validateAccountConfig('telegram', 'outbound', { timeoutMs: 99999 });
  assert.equal(bad.some((p) => /timeoutMs/.test(p)), true);
  const unknown = validateAccountConfig('telegram', 'outbound', { nope: 1 });
  assert.equal(unknown.some((p) => /unknown account field/.test(p)), true);
});

test('descriptors are frozen and IO/adapter-free', () => {
  const a = descriptors();
  const b = descriptors();
  assert.equal(a, b, 'descriptors are cached');
  assert.equal(channelDescriptors(), a);
  assert.ok(Object.isFrozen(a));
  const source = readFileSync(join(here, '..', '..', 'src', 'domain', 'descriptors.mjs'), 'utf8');
  assert.equal(/from\s+['"][^'"]*(providers|storage|security|runtime|node:fs)/.test(source), false);
  assert.equal(source.includes('import('), false, 'no dynamic imports');
  // channelById and channels give the same set.
  assert.equal(channels.length, 29);
  assert.equal(channelById('telegram').id, 'telegram');
  assert.equal(descriptorsFn().length, 29);
});

test('field copy maps problems to localized messages', () => {
  const problems = validateDestinationTarget('telegram', {});
  const described = describeProblem('telegram', 'outbound', 'destination', problems[0], 'en');
  assert.equal(described.code, 'REQUIRED');
  assert.equal(described.message, 'Enter chat id.');
  assert.equal(errorMessage(null, 'zh', 'REQUIRED'), '此项为必填。');

  const controls = controlsFor('telegram', 'outbound', 'destination', { locale: 'en', context: { chatId: '1' } });
  assert.ok(controls.every((c) => c.copy.label.length > 0));
  assert.equal(controls.some((c) => c.exposure === 'secret'), false, 'secret values are never exposed as controls');
});