// Public callback mount boundary (B04; 04-PROVIDERS.md callback, W06).
//
// The Host adapter owns the HTTP route; this module owns the mechanics that must
// be identical for every channel:
//   - exact path match `/dsh-notifier-v1/callback/:channelId/:accountId`
//   - bounded raw body (<= maxBytes) validated BEFORE any JSON re-encoding
//   - the provider verifies the platform signature over the raw bytes
//   - the durable inbox write happens BEFORE the platform ACK is returned
//   - a missing host webServer/mount capability is CALLBACK_UNAVAILABLE, never a
//     loopback-to-public workaround and never a fake success
// The provider receives finite raw bytes + headers and returns an envelope; it
// never sees the store. Old-epoch events are rejected by the epoch guard.
import { DomainError } from '../domain/errors.mjs';
import { LIMITS } from '../domain/limits.mjs';

export const CALLBACK_PATH_PREFIX = '/dsh-notifier-v1/callback';

export function callbackPathOf(channelId, accountId) {
  if (typeof channelId !== 'string' || channelId === '') throw new DomainError('INTERNAL', 'channelId is required');
  if (typeof accountId !== 'string' || accountId === '') throw new DomainError('INTERNAL', 'accountId is required');
  return `${CALLBACK_PATH_PREFIX}/${channelId}/${accountId}`;
}

/** Parse a callback path; returns null for anything that is not exactly ours. */
export function parseCallbackPath(path) {
  if (typeof path !== 'string') return null;
  const query = path.indexOf('?');
  const clean = query === -1 ? path : path.slice(0, query);
  const parts = clean.split('/');
  if (parts.length !== 5) return null;
  if (`/${parts[1]}/${parts[2]}` !== CALLBACK_PATH_PREFIX) return null;
  const [, , , channelId, accountId] = parts;
  if (channelId === '' || accountId === '') return null;
  return { channelId, accountId };
}

function textAck(status, body = '') {
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: new TextEncoder().encode(body) };
}

/**
 * @param {object} options
 * @param {object} options.host HostPort (only mountCallback is used)
 * @param {(accountId:string)=>object|null} options.resolveAccount
 * @param {(channelId:string)=>object|null} options.resolveProvider
 * @param {(envelope:object)=>Promise<{replayed:boolean}>} options.ingest durable inbox write
 * @param {string} options.epoch current runtime epoch
 * @param {(reason:string)=>void} [options.onUnavailable]
 * @param {number} [options.maxBytes]
 */
export function createCallbackMount({
  host,
  resolveAccount,
  resolveProvider,
  ingest,
  epoch,
  maxBytes = LIMITS.MAX_RPC_BYTES,
  onUnavailable = null,
  logger = null,
} = {}) {
  if (!host || typeof host.mountCallback !== 'function') {
    throw new DomainError('INTERNAL', 'createCallbackMount requires a HostPort with mountCallback');
  }
  if (typeof ingest !== 'function') throw new DomainError('INTERNAL', 'createCallbackMount requires an ingest function');
  if (typeof epoch !== 'string' || epoch === '') throw new DomainError('INTERNAL', 'createCallbackMount requires an epoch');

  const mounted = new Map(); // accountId -> { path, dispose }
  let disposed = false;

  function warn(message) {
    try { logger?.warn?.(`[dsh-notifier/callbacks] ${message}`); } catch { /* logging is never fatal */ }
  }

  function handlerFor(accountId) {
    return async ({ method, headers, rawBody, signal }) => {
      const account = resolveAccount(accountId);
      if (!account) return textAck(404, 'unknown account');
      if (account.enabled !== true) return textAck(403, 'account disabled');
      const bytes = rawBody instanceof Uint8Array ? rawBody : new Uint8Array(rawBody ?? []);
      if (bytes.byteLength > maxBytes) return textAck(413, 'payload too large');
      const provider = resolveProvider(account.channelId);
      if (!provider || provider.capabilities?.inbound !== true || typeof provider.handleCallback !== 'function') {
        return textAck(404, 'no callback for this channel');
      }
      let result;
      try {
        result = await provider.handleCallback({ account, method, headers, rawBody: bytes, epoch, signal });
      } catch (error) {
        // A verification failure must be a definite non-2xx so the platform can
        // retry; a thrown error is never treated as received.
        if (error instanceof DomainError && error.code === 'NETWORK') return textAck(503, 'upstream unavailable');
        warn(`callback handler failed: ${error?.code ?? error?.message ?? 'error'}`);
        return textAck(400, 'callback rejected');
      }
      if (!result || result.ok !== true || !result.envelope) {
        return result?.ack ?? textAck(401, 'unauthorized');
      }
      const envelope = result.envelope;
      if (envelope.epoch !== epoch) return textAck(409, 'stale epoch');
      // Durable receive BEFORE the ACK; a failed write yields a retryable 503.
      let ingestResult;
      try {
        ingestResult = await ingest(envelope);
      } catch (error) {
        warn(`durable receive failed: ${error?.code ?? error?.message ?? 'error'}`);
        return textAck(503, 'receive failed');
      }
      if (typeof provider.callbackAck === 'function') {
        return provider.callbackAck({ account, envelope, replayed: ingestResult?.replayed === true });
      }
      return textAck(200, '');
    };
  }

  /**
   * Mount one account's callback route. Returns `{mounted:false, code}` when the
   * host has no callback mount or the channel needs no callback.
   */
  async function mountAccount(account) {
    if (disposed) throw new DomainError('CANCELLED', 'callback mount was disposed');
    if (!account || typeof account.id !== 'string') throw new DomainError('INTERNAL', 'mountAccount requires an account');
    if (mounted.has(account.id)) return { mounted: true, path: mounted.get(account.id).path };
    const provider = resolveProvider(account.channelId);
    if (!provider || provider.capabilities?.inbound !== true || typeof provider.handleCallback !== 'function') {
      return { mounted: false, code: 'CALLBACK_NOT_REQUIRED' };
    }
    const path = callbackPathOf(account.channelId, account.id);
    let dispose;
    try {
      dispose = await host.mountCallback({ path, maxBytes, handler: handlerFor(account.id) });
    } catch (error) {
      if (error instanceof DomainError && error.code === 'UNSUPPORTED') {
        warn(`host cannot mount callbacks: ${error.message}`);
        onUnavailable?.('CALLBACK_UNAVAILABLE');
        return { mounted: false, code: 'CALLBACK_UNAVAILABLE' };
      }
      throw error;
    }
    mounted.set(account.id, { path, dispose });
    return { mounted: true, path };
  }

  function unmountAccount(accountId) {
    const entry = mounted.get(accountId);
    if (!entry) return false;
    mounted.delete(accountId);
    try { entry.dispose?.(); } catch (error) { warn(`unmount failed: ${error?.message ?? 'error'}`); }
    return true;
  }

  function mountCount() {
    return mounted.size;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const accountId of [...mounted.keys()]) unmountAccount(accountId);
  }

  return { mountAccount, unmountAccount, mountCount, dispose, get epoch() { return epoch; } };
}

export { textAck as callbackTextAck };