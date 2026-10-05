// T13 provider registry: the registry enumerates exactly the 29 frozen
// descriptors, wires every landed outbound adapter, and refuses to fabricate a
// provider for a channel that has no implementation (no default fake success).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { descriptors } from '../../src/domain/descriptors.mjs';
import { specProviders } from '../../src/providers/specs.mjs';
import {
  WIRED_PROVIDERS, hasProvider, getProvider, registryEntries, assertRegistryConsistent,
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
  assert.equal(wired.length, 23);
  for (const entry of wired) {
    const provider = getProvider(entry.id);
    assert.equal(provider.id, entry.id, entry.id);
    assert.equal(typeof provider.validate, 'function', `${entry.id} validate`);
    assert.equal(typeof provider.send, 'function', `${entry.id} send`);
    assert.equal(provider.capabilities.outbound, entry.capabilities.outbound, entry.id);
  }
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

test('a channel without an implementation raises UNSUPPORTED instead of a fake success', () => {
  for (const id of ['telegram', 'feishu', 'qq-bot', 'dingtalk', 'wxpusher']) {
    assert.equal(hasProvider(id), false, id);
    assert.throws(() => getProvider(id), (e) => e.code === 'UNSUPPORTED', id);
  }
  // wechat-ilink is an inbound/control channel with no outbound provider yet.
  assert.throws(() => getProvider('wechat-ilink'), (e) => e.code === 'UNSUPPORTED');
  assert.throws(() => getProvider('nope'), (e) => e.code === 'UNSUPPORTED');
});

test('constructing the registry opens no transport: entries are frozen data', () => {
  const entries = registryEntries();
  assert.equal(Object.isFrozen(entries[0]), true);
  assert.equal(Object.isFrozen(WIRED_PROVIDERS), true);
  // A second read is byte-identical, i.e. no lazy socket/transport is created.
  assert.equal(JSON.stringify(registryEntries()), JSON.stringify(entries));
});