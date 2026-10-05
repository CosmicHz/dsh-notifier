// User-controllable network access (04-PROVIDERS.md "WS / SDK / callback 的唯一执行规则").
// Ported from the frozen security/network-policy: IP-range validation by CIDR math
// (not a regex allow/deny list), DNS pinned to a validated address, no redirects,
// hard stream caps, abort destroys the socket.
import { lookup as defaultLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { DomainError } from '../domain/errors.mjs';
import { LIMITS } from '../domain/limits.mjs';

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 256;

const BLOCKED_V4 = [
  ['本网络 0.0.0.0/8', 0x00000000, 0x00ffffff],
  ['私网 10.0.0.0/8', 0x0a000000, 0x0affffff],
  ['CGNAT 100.64.0.0/10', 0x64400000, 0x647fffff],
  ['环回 127.0.0.0/8', 0x7f000000, 0x7fffffff],
  ['链路本地 169.254.0.0/16', 0xa9fe0000, 0xa9feffff],
  ['私网 172.16.0.0/12', 0xac100000, 0xac1fffff],
  ['IANA 特殊 192.0.0.0/24', 0xc0000000, 0xc00000ff],
  ['文档 192.0.2.0/24', 0xc0000200, 0xc00002ff],
  ['私网 192.168.0.0/16', 0xc0a80000, 0xc0a8ffff],
  ['基准 198.18.0.0/15', 0xc6120000, 0xc613ffff],
  ['文档 198.51.100.0/24', 0xc6336400, 0xc63364ff],
  ['文档 203.0.113.0/24', 0xcb007100, 0xcb0071ff],
  ['组播 224.0.0.0/4', 0xe0000000, 0xefffffff],
  ['保留 240.0.0.0/4', 0xf0000000, 0xfeffffff],
  ['广播 255.255.255.255/32', 0xffffffff, 0xffffffff],
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
  'metadata.google.internal', 'metadata.goog',
]);
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan'];

const cache = new Map();
const realLookup = defaultLookup;
let baselineLookup = realLookup;
let activeLookup = baselineLookup;

export const DEFAULT_MAX_BYTES = LIMITS.MAX_RPC_BYTES;
export const DEFAULT_ATTACHMENT_MAX_BYTES = LIMITS.MAX_ATTACHMENT_BYTES;
export const TIMEOUT_MIN_MS = 1000;
export const TIMEOUT_MAX_MS = 60000;
export const BARK_TIMEOUT_MS = 5000;

export class NetworkError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'NetworkError';
    this.code = code;
    this.detail = detail;
  }
}

// Explicit test seams; the module never inspects process state for a "test mode".
export function __setLookupForTests(fn) {
  activeLookup = typeof fn === 'function' ? fn : baselineLookup;
  cache.clear();
}
export function __setBaselineLookupForTests(fn) {
  baselineLookup = typeof fn === 'function' ? fn : realLookup;
  activeLookup = baselineLookup;
  cache.clear();
}

function parseIpv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = (value << 8) | Number(part);
  }
  return value >>> 0;
}

function parseIpv6Groups(host) {
  const text = String(host).split('%')[0];
  let body = text;
  const dotted = text.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted !== null) {
    const v4 = parseIpv4(dotted[2]);
    if (v4 === null) return null;
    body = `${dotted[1]}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const parse = (chunk) => (chunk === '' ? [] : chunk.split(':').map((group) => (
    /^[0-9a-f]{1,4}$/i.test(group) ? Number.parseInt(group, 16) : null
  )));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (head.includes(null) || tail.includes(null)) return null;
  const missing = 8 - head.length - tail.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => 0), ...tail];
  return groups.length === 8 ? groups : null;
}

function ipv6Value(host) {
  const groups = parseIpv6Groups(host);
  if (groups === null) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
}

function ipv6Cidr(name, base, prefix) {
  const value = ipv6Value(base);
  const shift = 128n - BigInt(prefix);
  const start = (value >> shift) << shift;
  return [name, start, start | ((1n << shift) - 1n)];
}

const BLOCKED_V6 = [
  ipv6Cidr('未指定 ::/128', '::', 128),
  ipv6Cidr('环回 ::1/128', '::1', 128),
  ipv6Cidr('IPv4-compatible ::/96', '::', 96),
  ipv6Cidr('Discard 100::/64', '100::', 64),
  ipv6Cidr('6to4 2002::/16', '2002::', 16),
  ipv6Cidr('文档 2001:db8::/32', '2001:db8::', 32),
  ipv6Cidr('ULA fc00::/7', 'fc00::', 7),
  ipv6Cidr('链路本地 fe80::/10', 'fe80::', 10),
  ipv6Cidr('组播 ff00::/8', 'ff00::', 8),
];

function blockedReasonOf(address) {
  const raw = String(address ?? '').replace(/^\[|\]$/g, '');
  const family = isIP(raw);
  if (family === 4) {
    const value = parseIpv4(raw);
    if (value === null) return `无法解析的 IPv4 地址 ${raw}`;
    return BLOCKED_V4.find(([, start, end]) => value >= start && value <= end)?.[0] ?? null;
  }
  if (family === 6) {
    const value = ipv6Value(raw);
    if (value === null) return `无法解析的 IPv6 地址 ${raw}`;
    const groups = parseIpv6Groups(raw);
    const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
    const nat64 = groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0);
    if (mapped || nat64) {
      const embedded = ((groups[6] << 16) | groups[7]) >>> 0;
      const reason = BLOCKED_V4.find(([, start, end]) => embedded >= start && embedded <= end)?.[0];
      return reason === undefined ? null : `${reason}（经 IPv6 映射 ${raw}）`;
    }
    return BLOCKED_V6.find(([, start, end]) => value >= start && value <= end)?.[0] ?? null;
  }
  return undefined;
}

function targetError(channel, reason) {
  return new NetworkError(
    'UNSAFE_TARGET',
    `${channel}目标被 SSRF 防护拒绝：${reason}。内网/本机自托管服务请配置 allowPrivateNetwork: true`,
  );
}

function remember(host, entry) {
  cache.set(host, { ...entry, expires: Date.now() + CACHE_TTL_MS });
  if (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
}

/** Validate a user-controllable URL and return pinned, validated addresses. */
export async function resolveNetworkTarget(url, {
  allowPrivate = false,
  channel = '渠道',
  lookupImpl = activeLookup,
} = {}) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ''));
  } catch {
    throw new NetworkError('NOT_CONFIGURED', `${channel}地址无效，无法校验`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new NetworkError('UNSUPPORTED_PROTOCOL', `${channel}仅支持 http/https 地址（当前 ${parsed.protocol.replace(':', '')}）`);
  }
  if (parsed.username !== '' || parsed.password !== '') throw targetError(channel, 'URL 不允许包含凭证段');
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === '') throw new NetworkError('NOT_CONFIGURED', `${channel}地址缺少主机名`);
  if (!allowPrivate && (BLOCKED_HOSTNAMES.has(host) || BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)))) {
    throw targetError(channel, `内部主机名 ${host}`);
  }

  const literal = blockedReasonOf(host);
  if (!allowPrivate && typeof literal === 'string') throw targetError(channel, literal);
  if (literal !== undefined) {
    return Object.freeze({ url: parsed, host, addresses: Object.freeze([{ address: host, family: isIP(host) }]) });
  }

  const cached = cache.get(host);
  if (cached !== undefined && cached.expires > Date.now()) {
    if (!allowPrivate && cached.blocked !== null) throw targetError(channel, cached.blocked);
    return Object.freeze({ url: parsed, host, addresses: cached.addresses });
  }

  let records;
  try {
    records = await lookupImpl(host, { all: true, verbatim: true });
  } catch (error) {
    throw new NetworkError('NETWORK_ERROR', `${channel}域名解析失败（${host}）`, error?.message ?? String(error));
  }
  const addresses = Object.freeze((Array.isArray(records) ? records : [])
    .map((record) => ({ address: String(record?.address ?? ''), family: Number(record?.family) || isIP(record?.address) }))
    .filter((record) => record.address !== '' && (record.family === 4 || record.family === 6)));
  if (addresses.length === 0) throw new NetworkError('NETWORK_ERROR', `${channel}域名无解析结果（${host}）`);
  let blocked = null;
  if (!allowPrivate) {
    for (const record of addresses) {
      const reason = blockedReasonOf(record.address);
      if (typeof reason === 'string') {
        blocked = `${reason}（${host} → ${record.address}）`;
        break;
      }
    }
  }
  remember(host, { addresses, blocked });
  if (blocked !== null) throw targetError(channel, blocked);
  return Object.freeze({ url: parsed, host, addresses });
}

/** A `lookup` that only returns already-validated addresses (DNS pinning). */
export function pinnedLookupFor(target) {
  const records = target.addresses;
  return (_hostname, options, callback) => {
    const opts = typeof options === 'object' && options !== null ? options : {};
    const family = Number(opts.family) || 0;
    const eligible = family === 0 ? records : records.filter((record) => record.family === family);
    if (eligible.length === 0) {
      callback(Object.assign(new Error('validated address family unavailable'), { code: 'ENOTFOUND' }));
      return;
    }
    if (opts.all === true) callback(null, eligible.map((record) => ({ ...record })));
    else callback(null, eligible[0].address, eligible[0].family);
  };
}

function nativeRequest(target, init) {
  return new Promise((resolve, reject) => {
    const client = target.url.protocol === 'https:' ? https : http;
    const request = client.request(target.url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      lookup: pinnedLookupFor(target),
      // Never use a shared/proxy agent: it would bypass the validated address.
      agent: false,
    }, (response) => {
      const headers = {};
      for (const [key, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) headers[key] = value.join(', ');
        else if (value !== undefined) headers[key] = String(value);
      }
      const status = response.statusCode ?? 500;
      const bodyAllowed = status !== 101 && status !== 204 && status !== 205 && status !== 304;
      if (!bodyAllowed) response.resume();
      resolve({ status, headers, body: bodyAllowed ? Readable.toWeb(response) : null });
    });
    request.once('error', reject);
    const abort = () => request.destroy(Object.assign(new Error('request aborted'), { name: 'AbortError' }));
    if (init.signal?.aborted === true) abort();
    else init.signal?.addEventListener?.('abort', abort, { once: true });
    if (init.body !== undefined && init.body !== null) request.write(init.body);
    request.end();
  });
}

let activeRequestImpl = nativeRequest;
export function __setRequestImplForTests(fn) {
  activeRequestImpl = typeof fn === 'function' ? fn : nativeRequest;
}

async function readBodyLimited(body, maxBytes, onAbort) {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      onAbort?.();
      throw new NetworkError('TOO_LARGE', `响应超过上限 ${maxBytes} 字节`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function clampTimeout(timeoutMs, channel) {
  if (!Number.isFinite(timeoutMs)) throw new DomainError('VALIDATION', `${channel} timeoutMs must be a number`);
  if (timeoutMs < TIMEOUT_MIN_MS || timeoutMs > TIMEOUT_MAX_MS) {
    throw new DomainError('VALIDATION', `${channel} timeoutMs must be within ${TIMEOUT_MIN_MS}..${TIMEOUT_MAX_MS}`);
  }
  return timeoutMs;
}

/**
 * Build a NetworkPort. Tests inject `requestImpl` / `lookupImpl`; production never
 * branches on a test flag.
 */
export function createNetwork({ requestImpl = activeRequestImpl, lookupImpl = activeLookup } = {}) {
  return {
    /**
     * @param {{url:string,method:string,headers:Record<string,string>,body?:Uint8Array,
     *   timeoutMs:number,maxBytes?:number,allowPrivateNetwork?:boolean,signal:AbortSignal,channel?:string}} x
     */
    async request(x) {
      const channel = x.channel ?? '渠道';
      const maxBytes = x.maxBytes ?? DEFAULT_MAX_BYTES;
      const timeoutMs = clampTimeout(x.timeoutMs, channel);
      if (typeof x.url !== 'string') throw new DomainError('VALIDATION', 'request.url is required');
      const target = await resolveNetworkTarget(x.url, {
        allowPrivate: x.allowPrivateNetwork === true,
        channel,
        lookupImpl,
      });

      const controller = new AbortController();
      const onOuterAbort = () => controller.abort();
      if (x.signal?.aborted) controller.abort();
      else x.signal?.addEventListener?.('abort', onOuterAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      try {
        const response = await requestImpl(target, {
          method: x.method ?? 'GET',
          headers: x.headers ?? {},
          body: x.body,
          signal: controller.signal,
        });
        if (response.status >= 300 && response.status < 400) {
          throw new NetworkError('REDIRECT', `${channel}拒绝重定向响应（HTTP ${response.status}）`);
        }
        const body = await readBodyLimited(response.body, maxBytes, () => controller.abort());
        return { status: response.status, headers: response.headers ?? {}, body };
      } catch (err) {
        if (err instanceof NetworkError || err instanceof DomainError) throw err;
        if (controller.signal.aborted) {
          throw timedOut
            ? new NetworkError('TIMEOUT', `${channel}请求超时（${timeoutMs}ms）`)
            : new NetworkError('CANCELLED', `${channel}请求已取消`);
        }
        if (err?.name === 'AbortError') throw new NetworkError('CANCELLED', `${channel}请求已取消`);
        throw new NetworkError('NETWORK_ERROR', `${channel}请求失败`, err?.code ?? err?.message ?? String(err));
      } finally {
        clearTimeout(timer);
        x.signal?.removeEventListener?.('abort', onOuterAbort);
      }
    },

    /**
     * @param {{url:string,headers:Record<string,string>,timeoutMs:number,maxFrameBytes:number,
     *   signal:AbortSignal,onFrame:(bytes:Uint8Array)=>void,onClose:(code:number)=>void}} x
     * @param {{allowPrivateNetwork?:boolean}} [options]
     */
    async openWebSocket(x, options = {}) {
      return activeWebSocketImpl(x, { ...options, lookupImpl: options.lookupImpl ?? lookupImpl });
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal RFC6455 client over node:http/https with pinned DNS and frame caps.
// ---------------------------------------------------------------------------

const WS_MAX_HEADER = 14;

function parseWebSocketUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ''));
  } catch {
    throw new NetworkError('NOT_CONFIGURED', 'WebSocket 地址无效');
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new NetworkError('UNSUPPORTED_PROTOCOL', `WebSocket 仅支持 ws/wss（当前 ${parsed.protocol.replace(':', '')}）`);
  }
  const httpEquiv = new URL(parsed.href);
  httpEquiv.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  return { parsed, httpEquiv };
}

function encodeFrame(payload, opcode = 0x2) {
  const mask = randomBytes(4);
  const len = payload.byteLength;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

export function openWebSocketImpl(x, { allowPrivateNetwork = false, lookupImpl = activeLookup } = {}) {
  return new Promise((resolve, reject) => {
    const channel = x.channel ?? 'WebSocket';
    const maxFrameBytes = x.maxFrameBytes ?? DEFAULT_MAX_BYTES;
    const timeoutMs = clampTimeout(x.timeoutMs ?? LIMITS.NETWORK_TIMEOUT_MS, channel);
    const { parsed, httpEquiv } = parseWebSocketUrl(x.url);

    resolveResolve();

    async function resolveResolve() {
      let target;
      try {
        target = await resolveNetworkTarget(httpEquiv.href, {
          allowPrivate: allowPrivateNetwork,
          channel,
          lookupImpl,
        });
      } catch (err) {
        reject(err);
        return;
      }

      const key = randomBytes(16).toString('base64');
      const client = parsed.protocol === 'wss:' ? https : http;
      const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'wss:' ? 443 : 80;
      const request = client.request({
        host: target.host,
        port,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: {
          ...(x.headers ?? {}),
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': key,
        },
        lookup: pinnedLookupFor(target),
        agent: false,
      });

      let settled = false;
      let socket = null;
      let closed = false;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };

      const timer = setTimeout(() => {
        request.destroy();
        fail(new NetworkError('TIMEOUT', `${channel}握手超时（${timeoutMs}ms）`));
      }, timeoutMs);

      const abort = () => {
        request.destroy();
        socket?.destroy();
        fail(new NetworkError('CANCELLED', `${channel}连接已取消`));
      };
      if (x.signal?.aborted) return abort();
      x.signal?.addEventListener?.('abort', abort, { once: true });

      request.once('response', (res) => {
        res.resume();
        fail(new NetworkError('HANDSHAKE_FAILED', `${channel}握手被拒绝（HTTP ${res.statusCode}）`));
      });
      request.once('error', (err) => fail(new NetworkError('NETWORK_ERROR', `${channel}连接失败`, err.code ?? err.message)));

      request.once('upgrade', (res, upgradedSocket, head) => {
        if (res.headers.upgrade?.toLowerCase() !== 'websocket') {
          upgradedSocket.destroy();
          return fail(new NetworkError('HANDSHAKE_FAILED', `${channel}缺少 WebSocket upgrade`));
        }
        socket = upgradedSocket;
        settled = true;
        clearTimeout(timer);
        socket.setNoDelay(true);

        let buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);
        let fragmentOpcode = 0;
        let fragments = [];

        const sendClose = (code) => {
          const payload = Buffer.alloc(2);
          payload.writeUInt16BE(code, 0);
          try { socket.write(encodeFrame(payload, 0x8)); } catch { /* noop */ }
        };

        const terminate = (code) => {
          if (closed) return;
          closed = true;
          try { socket.destroy(); } catch { /* noop */ }
          clearTimeout(timer);
          x.onClose?.(code);
        };

        const emitFrame = (opcode, payload) => {
          if (payload.byteLength > maxFrameBytes) {
            sendClose(1009);
            terminate(1009);
            return;
          }
          if (opcode === 0x0) {
            fragments.push(payload);
            const total = fragments.reduce((n, f) => n + f.byteLength, 0);
            if (total > maxFrameBytes) {
              sendClose(1009);
              terminate(1009);
            }
            return;
          }
          if (opcode === 0x1 || opcode === 0x2) {
            fragmentOpcode = opcode;
            fragments = [payload];
            x.onFrame?.(new Uint8Array(payload));
          } else if (opcode === 0x8) {
            sendClose(1000);
            terminate(1000);
          } else if (opcode === 0x9) {
            try { socket.write(encodeFrame(payload, 0xa)); } catch { /* noop */ }
          }
        };

        const pump = () => {
          for (;;) {
            if (buffer.length < 2) return;
            const finished = (buffer[0] & 0x80) !== 0;
            const opcode = buffer[0] & 0x0f;
            const masked = (buffer[1] & 0x80) !== 0;
            let length = buffer[1] & 0x7f;
            let offset = 2;
            if (length === 126) {
              if (buffer.length < 4) return;
              length = buffer.readUInt16BE(2);
              offset = 4;
            } else if (length === 127) {
              if (buffer.length < 10) return;
              const big = buffer.readBigUInt64BE(2);
              if (big > BigInt(Number.MAX_SAFE_INTEGER)) return terminate(1009);
              length = Number(big);
              offset = 10;
            }
            if (length > maxFrameBytes) {
              sendClose(1009);
              return terminate(1009);
            }
            let maskKey = null;
            if (masked) {
              if (buffer.length < offset + 4) return;
              maskKey = buffer.subarray(offset, offset + 4);
              offset += 4;
            }
            if (buffer.length < offset + length) return;
            const payload = Buffer.from(buffer.subarray(offset, offset + length));
            if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
            buffer = buffer.subarray(offset + length);
            emitFrame(opcode, payload);
            if (closed) return;
            if (finished && fragmentOpcode !== 0 && opcode === 0x0) {
              // fragment completion: deliver reassembled payload once
              fragmentOpcode = 0;
              fragments = [];
            }
          }
        };

        socket.on('data', (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          pump();
        });
        socket.on('error', () => terminate(1006));
        socket.on('close', () => terminate(1006));
        // A server may have already sent frames in the upgrade `head` buffer.
        pump();

        resolve({
          async send(bytes) {
            if (closed) throw new NetworkError('CANCELLED', `${channel}连接已关闭`);
            const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
            socket.write(encodeFrame(payload, 0x2));
          },
          async close() {
            if (closed) return;
            sendClose(1000);
            terminate(1000);
          },
        });
      });

      request.end();
    }
  });
}

let activeWebSocketImpl = openWebSocketImpl;
export function __setWebSocketImplForTests(fn) {
  activeWebSocketImpl = typeof fn === 'function' ? fn : openWebSocketImpl;
}
export function __resetNetworkForTests() {
  activeLookup = baselineLookup;
  activeRequestImpl = nativeRequest;
  activeWebSocketImpl = openWebSocketImpl;
  cache.clear();
}