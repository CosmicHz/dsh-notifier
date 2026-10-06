// T13 provider registry: the registry enumerates exactly the 29 frozen
// descriptors, wires every landed outbound adapter, and refuses to fabricate a
// provider for a channel that has no implementation (no default fake success).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { descriptors } from '../../src/domain/descriptors.mjs';
import { specProviders } from '../../src/providers/specs.mjs';
import {
  WIRED_PROVIDERS, hasProvider, getProvider, getChannelProvider, registryEntries, assertRegistryConsistent,
  capabilityGaps, PENDING_CAPABILITY_GAPS,
} from '../../src/providers/registry.mjs';

test('registry enumerates exactly the frozen descriptors with no missing/extra ids', () => {
  assert.equal(assertRegistryConsistent(), true);
  const entries = registryEntries();
  assert.equal(entries.length, 29);
  assert.equal(entries.filter((e) => e.outbound).length, 28);
  assert.deepEqual(
    entries.map((e) => e.id).sort(),
    descriptors().map((d) => d.id).sort(),
  );
});

test('every wired outbound adapter is present and agrees with its descriptor capability', () => {
  const wired = registryEntries().filter((e) => e.wired);
  assert.equal(wired.length, Object.keys(WIRED_PROVIDERS).length);
  for (const entry of wired) {
    const provider = getProvider(entry.id);
    assert.equal(provider.id, entry.id, entry.id);
    assert.equal(typeof provider.validate, 'function', `${entry.id} validate`);
    assert.equal(typeof provider.send, 'function', `${entry.id} send`);
    assert.equal(provider.capabilities.outbound, entry.capabilities.outbound, entry.id);
  }
  // A wired entry is exactly an outbound-capable channel; nothing inbound-only is
  // listed as an outbound provider.
  for (const entry of wired) assert.equal(entry.capabilities.outbound, true, entry.id);
  // Telegram (T16) is an outbound platform channel.
  assert.equal(hasProvider('telegram'), true);
  assert.equal(getProvider('telegram').id, 'telegram');
});

test('the 16 declarative channels are all wired through the spec compiler', () => {
  for (const id of Object.keys(specProviders)) {
    assert.equal(hasProvider(id), true, id);
    assert.equal(getProvider(id), specProviders[id], id);
  }
  assert.equal(WIRED_PROVIDERS.bell.id, 'bell');
  assert.equal(WIRED_PROVIDERS.desktop.id, 'desktop');
  assert.equal(WIRED_PROVIDERS['wecom-app'].id, 'wecom-app');
});

test('an outbound channel without an implementation raises UNSUPPORTED instead of a fake success', () => {
  // wechat-ilink is inbound/control only: it has no outbound `send`, so asking
  // for it as an outbound provider must fail even though a channel implementation
  // exists for the runtime.
  assert.equal(hasProvider('wechat-ilink'), false);
  assert.throws(() => getProvider('wechat-ilink'), (e) => e.code === 'UNSUPPORTED');
  // A channel with no implementation at all is null via the runtime resolver.
  assert.equal(getChannelProvider('nope'), null);
  assert.throws(() => getProvider('nope'), (e) => e.code === 'UNSUPPORTED');
});

test('constructing the registry opens no transport: entries are frozen data', () => {
  const entries = registryEntries();
  assert.equal(Object.isFrozen(entries[0]), true);
  assert.equal(Object.isFrozen(WIRED_PROVIDERS), true);
  // A second read is byte-identical, i.e. no lazy socket/transport is created.
  assert.equal(JSON.stringify(registryEntries()), JSON.stringify(entries));
});
// --- N04: capability truth and method evidence -----------------------------

test('N04: login (a scan flow) is declared only by Feishu and WeChat iLink', () => {
  const login = descriptors().filter((d) => d.capabilities.login === true).map((d) => d.id).sort();
  assert.deepEqual(login, ['feishu', 'wechat-ilink']);
  for (const id of ['telegram', 'qq-bot', 'dingtalk', 'wxpusher']) {
    assert.equal(descriptors().find((d) => d.id === id).capabilities.login, false, `${id} must not advertise a scan`);
  }
});

test('N04: every declared capability has a backing method or is an explicit pending gap', () => {
  const gaps = capabilityGaps();
  for (const gap of gaps) {
    assert.equal(gap.pending, true, `${gap.channelId}:${gap.capability} must be recorded in PENDING_CAPABILITY_GAPS`);
  }
  // No declared capability may be a gap: the list must stay empty.
  assert.deepEqual(gaps.map((g) => `${g.channelId}:${g.capability}`).sort(), []);
  assert.equal(PENDING_CAPABILITY_GAPS.length, 0);
  assert.equal(assertRegistryConsistent(), true);
});

test('N04: the support matrix covers 29 channels / 6 control replies / 2 scans', async () => {
  const { readFile } = await import('node:fs/promises');
  const matrix = JSON.parse(await readFile(new URL('../../docs/SUPPORT-MATRIX.json', import.meta.url), 'utf8'));
  assert.equal(matrix.counts.channels, 29);
  assert.deepEqual([...matrix.counts.loginChannels].sort(), ['feishu', 'wechat-ilink']);
  const control = descriptors().filter((d) => d.capabilities.controlReply === true).map((d) => d.id);
  assert.equal(control.length, 6);
  const missing = Object.entries(matrix.channels).flatMap(([id, c]) => Object.entries(c.capabilities)
    .filter(([, v]) => v.status === 'missing').map(([k]) => `${id}:${k}`));
  assert.deepEqual(missing, [], 'no declared capability may be silently missing');
});
