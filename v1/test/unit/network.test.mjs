import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createNetwork, resolveNetworkTarget, NetworkError } from '../../src/security/network.mjs';
import { DomainError } from '../../src/domain/errors.mjs';

function streamOf(bytes) {
  return new Response(bytes).body;
}

// N01 — protocol / authority validation
test('N01: only http(s), no userinfo, host required', async () => {
  await assert.rejects(resolveNetworkTarget('file:///etc/passwd'), (e) => e instanceof NetworkError && e.code === 'UNSUPPORTED_PROTOCOL');
  await assert.rejects(resolveNetworkTarget('http://user:pass@example.com/'), (e) => e.code === 'UNSAFE_TARGET');
  await assert.rejects(resolveNetworkTarget('not a url'), (e) => e.code === 'NOT_CONFIGURED');
});

// N02 — private / reserved ranges by CIDR math
test('N02: private, loopback, link-local and mapped ranges are blocked', async () => {
  const blocked = [
    'http://127.0.0.1/', 'http://10.1.2.3/', 'http://192.168.1.1/', 'http://169.254.0.1/',
    'http://172.16.5.5/', 'http://[::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://localhost/', 'http://foo.internal/',
  ];
  for (const url of blocked) {
    await assert.rejects(resolveNetworkTarget(url), (e) => e instanceof NetworkError && e.code === 'UNSAFE_TARGET', url);
  }
  // Public literal passes.
  const ok = await resolveNetworkTarget('http://93.184.216.34/');
  assert.equal(ok.host, '93.184.216.34');
});

test('N02b: allowPrivateNetwork only relaxes the check for that call', async () => {
  const ok = await resolveNetworkTarget('http://127.0.0.1:8080/', { allowPrivate: true });
  assert.deepEqual(ok.addresses, [{ address: '127.0.0.1', family: 4 }]);
});

test('N02c: a hostname resolving to any blocked address is rejected', async () => {
  const lookup = async () => [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }];
  await assert.rejects(resolveNetworkTarget('http://mixed.example/', { lookupImpl: lookup }), (e) => e.code === 'UNSAFE_TARGET');
});

// N03 — redirects refused
test('N03: redirect responses are refused', async () => {
  const net = createNetwork({
    requestImpl: async () => ({ status: 302, headers: { location: 'http://evil.example/' }, body: null }),
  });
  await assert.rejects(
    net.request({ url: 'http://93.184.216.34/', method: 'GET', headers: {}, timeoutMs: 1000, signal: new AbortController().signal }),
    (e) => e instanceof NetworkError && e.code === 'REDIRECT',
  );
});

// N04 — stream caps
test('N04: responses over maxBytes are aborted with TOO_LARGE', async () => {
  const big = new Uint8Array(4096);
  const net = createNetwork({ requestImpl: async () => ({ status: 200, headers: {}, body: streamOf(big) }) });
  await assert.rejects(
    net.request({ url: 'http://93.184.216.34/', method: 'GET', headers: {}, timeoutMs: 1000, maxBytes: 1024, signal: new AbortController().signal }),
    (e) => e instanceof NetworkError && e.code === 'TOO_LARGE',
  );
  // Within the cap succeeds and returns exact bytes.
  const net2 = createNetwork({ requestImpl: async () => ({ status: 200, headers: {}, body: streamOf(big) }) });
  const res = await net2.request({ url: 'http://93.184.216.34/', method: 'GET', headers: {}, timeoutMs: 1000, maxBytes: 8192, signal: new AbortController().signal });
  assert.equal(res.body.byteLength, 4096);
});

// N05 — timeout / cancel
test('N05: an exceeded timeout is TIMEOUT', async () => {
  const net = createNetwork({
    requestImpl: (_t, init) => new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  await assert.rejects(
    net.request({ url: 'http://93.184.216.34/', method: 'GET', headers: {}, timeoutMs: 1000, signal: new AbortController().signal }),
    (e) => e instanceof NetworkError && e.code === 'TIMEOUT',
  );
});

test('N05b: an aborted caller signal is CANCELLED', async () => {
  const net = createNetwork({
    requestImpl: (_t, init) => new Promise((_res, rej) => {
      if (init.signal.aborted) rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      else init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    net.request({ url: 'http://93.184.216.34/', method: 'GET', headers: {}, timeoutMs: 1000, signal: controller.signal }),
    (e) => e instanceof NetworkError && e.code === 'CANCELLED',
  );
});

test('N05c: timeoutMs outside 1000..60000 is a VALIDATION error', async () => {
  const net = createNetwork({ requestImpl: async () => ({ status: 200, headers: {}, body: null }) });
  await assert.rejects(
    net.request({ url: 'http://93.184.216.34/', method: 'GET', headers: {}, timeoutMs: 500, signal: new AbortController().signal }),
    (e) => e instanceof DomainError && e.code === 'VALIDATION',
  );
});

// N06 — DNS pinning
test('N06: the pinned lookup only returns validated addresses', async () => {
  const target = await resolveNetworkTarget('http://pin.example/', {
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  const net = createNetwork({
    requestImpl: async (t) => {
      assert.equal(t.host, 'pin.example');
      assert.deepEqual(t.addresses, [{ address: '93.184.216.34', family: 4 }]);
      return { status: 200, headers: {}, body: streamOf(new TextEncoder().encode('ok')) };
    },
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  const res = await net.request({ url: 'http://pin.example/', method: 'GET', headers: {}, timeoutMs: 1000, signal: new AbortController().signal });
  assert.equal(new TextDecoder().decode(res.body), 'ok');
  assert.ok(target.addresses.length === 1);
});

// WebSocket
test('websocket: only ws/wss and safe targets are accepted', async () => {
  const net = createNetwork();
  await assert.rejects(
    net.openWebSocket({ url: 'http://example.com/', timeoutMs: 1000, maxFrameBytes: 1024, signal: new AbortController().signal, onFrame() {}, onClose() {} }),
    (e) => e.code === 'UNSUPPORTED_PROTOCOL',
  );
  await assert.rejects(
    net.openWebSocket({ url: 'ws://127.0.0.1:9/', timeoutMs: 1000, maxFrameBytes: 1024, signal: new AbortController().signal, onFrame() {}, onClose() {} }),
    (e) => e.code === 'UNSAFE_TARGET',
  );
});

function serverFrame(payload, opcode = 0x1) {
  const len = payload.length;
  const header = len < 126 ? Buffer.from([0x80 | opcode, len]) : Buffer.from([0x80 | opcode, 126, len >> 8, len & 0xff]);
  return Buffer.concat([header, payload]);
}

async function withWsServer(handler, fn) {
  const server = http.createServer();
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1')
      .update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    handler(socket);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    return await fn(port);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections?.();
    server.close();
  }
}

test('websocket: handshake, receive a frame, send and close', async () => {
  await withWsServer((socket) => {
    socket.write(serverFrame(Buffer.from('hello')));
  }, async (port) => {
    const frames = [];
    const closes = [];
    const net = createNetwork();
    const ws = await net.openWebSocket(
      {
        url: `ws://127.0.0.1:${port}/ws`,
        headers: {},
        timeoutMs: 5000,
        maxFrameBytes: 1024,
        signal: new AbortController().signal,
        onFrame: (bytes) => frames.push(new TextDecoder().decode(bytes)),
        onClose: (code) => closes.push(code),
      },
      { allowPrivateNetwork: true },
    );
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(frames, ['hello']);
    await ws.send(new Uint8Array([1, 2, 3]));
    await ws.close();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(closes.length >= 1, true);
  });
});

test('websocket: an oversized frame closes with 1009', async () => {
  await withWsServer((socket) => {
    socket.write(serverFrame(Buffer.alloc(4096, 0x61)));
    // keep the socket open briefly
    setTimeout(() => socket.destroy(), 100);
  }, async (port) => {
    const closes = [];
    const net = createNetwork();
    await net.openWebSocket(
      {
        url: `ws://127.0.0.1:${port}/ws`,
        headers: {},
        timeoutMs: 5000,
        maxFrameBytes: 512,
        signal: new AbortController().signal,
        onFrame() {},
        onClose: (code) => closes.push(code),
      },
      { allowPrivateNetwork: true },
    );
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(closes, [1009]);
  });
});