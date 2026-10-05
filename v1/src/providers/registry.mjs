// Provider registry (T13, 04-PROVIDERS.md).
// Enumerates all 29 frozen descriptors and exposes the wired outbound providers.
// Constructing the registry starts no transport and opens no socket: platform
// channels that land in a later phase are listed but not wired, and getProvider()
// raises a typed UNSUPPORTED instead of fabricating a stub that always succeeds.
import { DomainError } from '../domain/errors.mjs';
import { descriptors } from '../domain/descriptors.mjs';
import { specProviders } from './specs.mjs';
import bark from './bark/index.mjs';
import pushplus from './pushplus/index.mjs';
import serverchan from './serverchan/index.mjs';
import webhook from './webhook/index.mjs';
import wecomApp from './wecom-app/index.mjs';
import bell from './bell/index.mjs';
import desktop from './desktop/index.mjs';
import telegram from './telegram/index.mjs';
import feishu from './feishu/index.mjs';
import wxpusher from './wxpusher/index.mjs';

/**
 * Every implemented platform channel, including inbound-only channels that have
 * no outbound `send` (e.g. WeChat iLink). `getChannelProvider` is what the
 * runtime resolves inbound connections through.
 */
export const CHANNEL_IMPLEMENTATIONS = Object.freeze({
  ...specProviders,
  bark,
  pushplus,
  serverchan,
  webhook,
  'wecom-app': wecomApp,
  bell,
  desktop,
  telegram,
  feishu,
  wxpusher,
});

/** Concrete outbound providers, keyed by channel id (capability.outbound === true). */
export const WIRED_PROVIDERS = Object.freeze(
  Object.fromEntries(Object.entries(CHANNEL_IMPLEMENTATIONS).filter(([, p]) => p.capabilities?.outbound === true)),
);

/** Any implementation for a channel (outbound or inbound-only), or null. */
export function getChannelProvider(channelId) {
  return Object.prototype.hasOwnProperty.call(CHANNEL_IMPLEMENTATIONS, channelId)
    ? CHANNEL_IMPLEMENTATIONS[channelId]
    : null;
}

export function hasProvider(channelId) {
  return Object.prototype.hasOwnProperty.call(WIRED_PROVIDERS, channelId);
}

/**
 * The provider for a channel, or a typed UNSUPPORTED. A channel without an
 * implementation never returns a fake success.
 */
export function getProvider(channelId) {
  if (!hasProvider(channelId)) {
    throw new DomainError('UNSUPPORTED', `channel ${channelId} has no outbound provider implementation`);
  }
  return WIRED_PROVIDERS[channelId];
}

/**
 * All 29 registry entries. `wired` is true only when an outbound implementation
 * exists; capabilities always come from the frozen descriptors.
 */
export function registryEntries() {
  return descriptors().map((descriptor) => Object.freeze({
    id: descriptor.id,
    capabilities: descriptor.capabilities,
    outbound: descriptor.outbound,
    inbound: descriptor.inbound,
    defaultDestinationKind: descriptor.defaultDestinationKind,
    wired: hasProvider(descriptor.id),
  }));
}

/**
 * Static invariant check: the registry covers exactly the frozen channel ids, and
 * every wired provider agrees with its descriptor capabilities. Throws on drift so
 * `npm run check` / tests fail loudly instead of silently diverging.
 */
export function assertRegistryConsistent() {
  const entries = registryEntries();
  const ids = entries.map((entry) => entry.id).sort();
  const expected = descriptors().map((d) => d.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify(expected)) {
    throw new DomainError('INTERNAL', `registry ids differ from descriptors: ${ids.join(',')}`);
  }
  for (const entry of entries) {
    if (!entry.wired) continue;
    const provider = WIRED_PROVIDERS[entry.id];
    if (provider.id !== entry.id) {
      throw new DomainError('INTERNAL', `provider id mismatch for ${entry.id}: ${provider.id}`);
    }
    if (provider.capabilities !== entry.capabilities && provider.capabilities.outbound !== entry.capabilities.outbound) {
      throw new DomainError('INTERNAL', `provider capabilities disagree with descriptor for ${entry.id}`);
    }
  }
  return true;
}

export { specProviders };