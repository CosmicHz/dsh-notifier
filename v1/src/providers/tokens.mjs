// Shared provider token manager (04-PROVIDERS.md). Fetch -> cache -> refresh
// before expiry -> invalidate on a rejected token. Used by wecom-app now and by
// the platform providers that reuse an access token later; the fetch function is
// supplied by each provider so the token exchange stays channel-specific.
import { ProviderError } from './http.mjs';

const TTL_MIN_MS = 1000;
const TTL_MAX_MS = 7 * 24 * 60 * 60 * 1000;

/** Clamp an upstream TTL to [1s, 7d]; a non-positive/non-finite TTL is an error. */
export function normalizeTtlMs(value, what = 'expiresInMs') {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ProviderError('BAD_UPSTREAM_RESPONSE', `上游返回的 token TTL 非法（${what}=${String(value)}）`, null);
  }
  return Math.min(TTL_MAX_MS, Math.max(TTL_MIN_MS, Math.round(n)));
}

/**
 * Create a token manager.
 * @param {() => Promise<{token:string, expiresInMs:number}>} fetchToken
 * @param {{refreshMarginMs?:number, now?:()=>number}} [options]
 * @returns {{get:(force?:boolean)=>Promise<string>, invalidate:()=>void}}
 */
export function createTokenManager(fetchToken, { refreshMarginMs = 60000, now = Date.now } = {}) {
  let cached = null; // { token, expiresAt }
  let inflight = null;
  let generation = 0;

  function marginFor(entry) {
    const remaining = entry.expiresAt - now();
    return Math.min(Math.max(0, refreshMarginMs), Math.max(1, remaining * 0.2));
  }

  async function get(force = false) {
    const fresh = cached !== null && now() < cached.expiresAt - marginFor(cached);
    if (!force && fresh) return cached.token;
    if (!force && inflight !== null) return inflight;
    const myGeneration = generation;
    inflight = (async () => {
      const { token, expiresInMs } = await fetchToken();
      const entry = { token, expiresAt: now() + normalizeTtlMs(expiresInMs, 'expiresInMs') };
      if (myGeneration === generation) cached = entry;
      return token;
    })();
    try {
      return await inflight;
    } finally {
      if (myGeneration === generation) inflight = null;
    }
  }

  function invalidate() {
    generation += 1;
    cached = null;
    inflight = null;
  }

  return { get, invalidate };
}