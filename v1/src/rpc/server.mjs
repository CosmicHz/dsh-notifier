// Loopback RPC server (T27; 05-HOST-CLI.md "本地 CLI 管理口").
//
// Binds 127.0.0.1:0 ONLY (never another address), mints a 32-byte random token,
// writes <stateDir>/runtime-control.json as {pid,port,token} with mode 0600, and
// serves POST /v1/rpc behind `Authorization: Bearer <token>` with a hard 1 MiB
// body cap. GET never performs a mutation. stop() closes the listener and removes
// the token file, idempotently. runtime-control.json is never backed up (backup.mjs
// only snapshots state.json) and the token is never logged.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { LIMITS } from '../domain/limits.mjs';

export const CONTROL_FILE = 'runtime-control.json';
export const RPC_PATH = '/v1/rpc';
export const LOOPBACK_HOST = '127.0.0.1';

function tokenEquals(provided, expected) {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerOf(req) {
  const header = req.headers?.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match === null ? null : match[1];
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
    connection: 'close',
  });
  res.end(json);
}

/**
 * @param {object} options
 * @param {{handle:(method:string,payload:object,ctx:object)=>Promise<object>}} options.router
 * @param {string} options.stateDir
 * @param {object|null} [options.logger]
 */
export function createRpcServer({ router, stateDir, logger = null } = {}) {
  if (!router || typeof router.handle !== 'function') {
    throw new Error('createRpcServer requires a router with handle()');
  }
  if (typeof stateDir !== 'string' || stateDir === '') {
    throw new Error('createRpcServer requires a stateDir');
  }
  const token = randomBytes(32).toString('hex');
  const tokenFile = join(stateDir, CONTROL_FILE);
  let server = null;
  let started = false;
  let stopPromise = null;
  let exitHook = null;

  function warn(message) {
    try { logger?.warn?.(`[dsh-notifier/rpc-server] ${message}`); } catch { /* logging is never fatal */ }
  }

  async function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let over = false;
      req.on('data', (chunk) => {
        if (over) return; // keep draining so the client can read our response
        size += chunk.length;
        if (size > LIMITS.MAX_RPC_BYTES) {
          over = true;
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (over) reject(Object.assign(new Error('body too large'), { code: 'TOO_LARGE' }));
        else resolve(Buffer.concat(chunks));
      });
      req.on('error', (error) => reject(error));
    });
  }

  async function handleRequest(req, res) {
    const path = (req.url ?? '').split('?')[0];
    if (path !== RPC_PATH) {
      sendJson(res, 404, { code: 'NOT_FOUND', message: 'unknown endpoint', details: null });
      return;
    }
    if (req.method !== 'POST') {
      // A GET (or any non-POST) can never perform a mutation.
      sendJson(res, 405, { code: 'UNSUPPORTED', message: `${req.method} is not allowed; use POST ${RPC_PATH}`, details: null });
      return;
    }
    if (!tokenEquals(bearerOf(req), token)) {
      sendJson(res, 401, { code: 'FORBIDDEN', message: 'a valid Bearer token is required', details: null });
      return;
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (error) {
      if (error?.code === 'TOO_LARGE') {
        sendJson(res, 413, { code: 'VALIDATION', message: `request body exceeds ${LIMITS.MAX_RPC_BYTES} bytes`, details: null });
        return;
      }
      sendJson(res, 400, { code: 'VALIDATION', message: 'could not read the request body', details: null });
      return;
    }

    let envelope;
    try {
      envelope = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { code: 'VALIDATION', message: 'request body must be valid JSON', details: null });
      return;
    }
    if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)
      || typeof envelope.method !== 'string' || envelope.method === '') {
      sendJson(res, 400, { code: 'VALIDATION', message: 'request must be {method, payload}', details: null });
      return;
    }

    // The actor is the adapter's, not the caller's: a loopback Bearer is
    // local-owner. A client disconnect aborts anything the method is waiting on.
    const controller = new AbortController();
    const onClose = () => controller.abort();
    req.on('close', onClose);
    try {
      const body = await router.handle(envelope.method, envelope.payload ?? {}, {
        actor: { kind: 'local-owner', id: 'local-owner' },
        signal: controller.signal,
      });
      sendJson(res, 200, body);
    } catch (error) {
      warn(`router threw instead of returning an envelope: ${error?.code ?? error?.message ?? 'error'}`);
      sendJson(res, 500, { code: 'INTERNAL', message: 'internal error', details: null });
    } finally {
      req.off('close', onClose);
    }
  }

  async function start() {
    if (started) return { address: server.address() };
    stopPromise = null;
    await mkdir(stateDir, { recursive: true });
    server = createServer((req, res) => {
      handleRequest(req, res).catch((error) => {
        warn(`request handler failed: ${error?.code ?? error?.message ?? 'error'}`);
        if (!res.headersSent) sendJson(res, 500, { code: 'INTERNAL', message: 'internal error', details: null });
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, LOOPBACK_HOST, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    // The token file is 0600; the token itself is never logged.
    await writeFile(tokenFile, JSON.stringify({ pid: process.pid, port: address.port, token }), { mode: 0o600 });
    exitHook = () => { try { rmSync(tokenFile, { force: true }); } catch { /* best effort */ } };
    process.on('exit', exitHook);
    started = true;
    return { address };
  }

  function stop() {
    if (stopPromise !== null) return stopPromise;
    stopPromise = (async () => {
      if (exitHook !== null) {
        process.removeListener('exit', exitHook);
        exitHook = null;
      }
      if (server !== null) {
        const closing = server;
        server = null;
        await new Promise((resolve) => {
          closing.close(() => resolve());
          // Force-close idle keep-alive sockets so close() always completes.
          closing.closeAllConnections?.();
        });
      }
      await rm(tokenFile, { force: true });
      started = false;
    })();
    return stopPromise;
  }

  return {
    start,
    stop,
    address: () => (server === null ? null : server.address()),
    get token() { return token; },
    get tokenFile() { return tokenFile; },
    get path() { return RPC_PATH; },
    get listening() { return started; },
  };
}
