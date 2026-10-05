// T12 messages/replies/media: complete references, media to the Host, and the
// scope / cancel / too-large boundaries. No sockets: ports are injected fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeInboundMessage,
  composeHostText,
  buildHostSubmission,
} from '../../src/domain/messages.mjs';
import { resolveReplyTo, replyLookupSupported } from '../../src/services/replies.mjs';
import { admitInboundAttachment, readOutboundAttachment } from '../../src/services/media.mjs';
import { makeNetwork } from '../protocol/helpers.mjs';

const envelope = (overrides = {}) => ({
  kind: 'message',
  eventId: 'ev-1',
  accountId: 'ac-1',
  userId: 'u-1',
  chatId: 'c-1',
  messageId: 'm-1',
  text: 'hello',
  attachments: [],
  replyTo: null,
  ...overrides,
});

// --- messages --------------------------------------------------------------

test('normalizeInboundMessage accepts a canonical message and normalizes attachments', () => {
  const normalized = normalizeInboundMessage(envelope({
    attachments: [{ id: 'a-1', name: 'p.png', mime: 'image/png', size: 10 }],
  }));
  assert.equal(normalized.text, 'hello');
  assert.deepEqual(normalized.attachments, [{ id: 'a-1', name: 'p.png', mime: 'image/png', size: 10 }]);
  assert.equal(normalized.replyTo, null);
});

test('normalizeInboundMessage enforces the attachment count and total-size caps', () => {
  const five = Array.from({ length: 5 }, (_, i) => ({ id: `a-${i}`, name: '', mime: 'application/octet-stream', size: 1 }));
  assert.throws(() => normalizeInboundMessage(envelope({ attachments: five })), (e) => e.code === 'VALIDATION');

  const big = [{ id: 'a-1', name: '', mime: 'application/octet-stream', size: 41 * 1024 * 1024 }];
  assert.throws(() => normalizeInboundMessage(envelope({ attachments: big })), (e) => e.code === 'VALIDATION');
});

test('normalizeInboundMessage rejects a wrong kind and an empty message', () => {
  assert.throws(() => normalizeInboundMessage(envelope({ kind: 'callback' })), (e) => e.code === 'VALIDATION');
  assert.throws(() => normalizeInboundMessage(envelope({ text: '' })), (e) => e.code === 'VALIDATION');
});

test('composeHostText carries a reference as user data, never as a system directive', () => {
  const text = composeHostText('my reply', { messageId: 'm-0', content: 'quoted line' });
  assert.equal(text, '> quoted line\n\nmy reply');
  assert.equal(composeHostText('plain', null), 'plain');
});

test('buildHostSubmission produces a role-free host payload', () => {
  const submission = buildHostSubmission({
    sessionId: 's-1',
    requestId: 'r-1',
    text: 'hi',
    attachments: [{ id: 'a-1', name: '', mime: 'image/png', size: 1 }],
    replyTo: { messageId: 'm-0', content: 'ctx' },
  });
  assert.equal(submission.mode, 'followup');
  assert.equal(submission.text, '> ctx\n\nhi');
  assert.equal('role' in submission, false);
  assert.equal('instructions' in submission, false);
});

// --- replies ---------------------------------------------------------------

test('a complete reference in the payload is used without any provider lookup', async () => {
  let called = 0;
  const provider = { capabilities: { replyLookup: true }, async resolveReply() { called += 1; return { content: 'x' }; } };
  const result = await resolveReplyTo(provider, {
    accountId: 'ac-1',
    chatId: 'c-1',
    reference: { messageId: 'm-0', content: 'from payload' },
  });
  assert.deepEqual(result, { messageId: 'm-0', content: 'from payload', unavailableReason: null });
  assert.equal(called, 0);
});

test('a provider without replyLookup returns unavailableReason unsupported', async () => {
  assert.equal(replyLookupSupported({ capabilities: {} }), false);
  const result = await resolveReplyTo({ capabilities: {} }, {
    accountId: 'ac-1',
    chatId: 'c-1',
    reference: { messageId: 'm-0' },
  });
  assert.deepEqual(result, { messageId: 'm-0', content: null, unavailableReason: 'unsupported' });
});

test('a capable provider is queried and its content returned', async () => {
  const seen = [];
  const provider = {
    capabilities: { replyLookup: true },
    async resolveReply(input) { seen.push(input); return { content: 'fetched' }; },
  };
  const result = await resolveReplyTo(provider, { accountId: 'ac-1', chatId: 'c-1', reference: { messageId: 'm-9' } });
  assert.equal(result.content, 'fetched');
  assert.equal(seen[0].accountId, 'ac-1');
  assert.equal(seen[0].chatId, 'c-1');
});

test('a reference naming another account or chat is refused, not followed', async () => {
  const provider = { capabilities: { replyLookup: true }, async resolveReply() { return { content: 'x' }; } };
  await assert.rejects(
    resolveReplyTo(provider, { accountId: 'ac-1', chatId: 'c-1', reference: { messageId: 'm-0', accountId: 'ac-2' } }),
    (e) => e.code === 'CONFLICT',
  );
  await assert.rejects(
    resolveReplyTo(provider, { accountId: 'ac-1', chatId: 'c-1', reference: { messageId: 'm-0', chatId: 'c-2' } }),
    (e) => e.code === 'CONFLICT',
  );
});

test('a cancelled reply lookup surfaces CANCELLED', async () => {
  const controller = new AbortController();
  controller.abort();
  const provider = { capabilities: { replyLookup: true }, async resolveReply() { return { content: 'x' }; } };
  await assert.rejects(
    resolveReplyTo(provider, { accountId: 'a', chatId: 'c', reference: { messageId: 'm' }, signal: controller.signal }),
    (e) => e.code === 'CANCELLED',
  );
});

test('a reply whose content is too large fails closed with too_large', async () => {
  const provider = { capabilities: { replyLookup: true }, async resolveReply() { return { content: 'x'.repeat(20001) }; } };
  const result = await resolveReplyTo(provider, { accountId: 'a', chatId: 'c', reference: { messageId: 'm' } });
  assert.equal(result.content, null);
  assert.equal(result.unavailableReason, 'too_large');
});

// --- media -----------------------------------------------------------------

function fakeHost(ref = { id: 'att-1', name: 'p.png', mime: 'image/png', size: 3 }) {
  const saved = [];
  return {
    saved,
    async saveAttachment(input) { saved.push(input); return ref; },
  };
}

test('media downloads within bounds and admits the bytes into the Host store', async () => {
  const host = fakeHost();
  const network = makeNetwork(() => ({ status: 200, body: new Uint8Array([1, 2, 3]) }));
  const ref = await admitInboundAttachment({
    host,
    network,
    sessionId: 's-1',
    requestId: 'r-1',
    attachment: { url: 'https://cdn.example.com/p.png', name: 'p.png', mime: 'image/png' },
  });
  assert.deepEqual(ref, { id: 'att-1', name: 'p.png', mime: 'image/png', size: 3 });
  assert.equal(network.calls.length, 1);
  assert.equal(network.calls[0].allowPrivateNetwork, false, 'inbound media never relaxes the network policy');
  assert.equal(network.calls[0].maxBytes, 10 * 1024 * 1024);
  assert.equal(host.saved[0].sessionId, 's-1');
  assert.deepEqual(host.saved[0].bytes, new Uint8Array([1, 2, 3]));
});

test('media is a typed UNSUPPORTED when the host cannot store attachments', async () => {
  const network = makeNetwork(() => ({ status: 200, body: new Uint8Array([1]) }));
  await assert.rejects(
    admitInboundAttachment({ host: {}, network, sessionId: 's', requestId: 'r', attachment: { url: 'https://x/y' } }),
    (e) => e.code === 'UNSUPPORTED',
  );
  assert.equal(network.calls.length, 0, 'no download when the Host cannot accept it');
});

test('media rejects an oversized attachment before downloading and after reading', async () => {
  const host = fakeHost();
  const pre = makeNetwork(() => ({ status: 200, body: new Uint8Array([1]) }));
  await assert.rejects(
    admitInboundAttachment({
      host,
      network: pre,
      sessionId: 's',
      requestId: 'r',
      attachment: { url: 'https://x/y', size: 11 * 1024 * 1024 },
    }),
    (e) => e.code === 'VALIDATION' && e.details?.reason === 'TOO_LARGE',
  );
  assert.equal(pre.calls.length, 0);

  const post = makeNetwork(() => ({ status: 200, body: new Uint8Array(11 * 1024 * 1024) }));
  await assert.rejects(
    admitInboundAttachment({ host, network: post, sessionId: 's', requestId: 'r', attachment: { url: 'https://x/y' } }),
    (e) => e.code === 'VALIDATION' && e.details?.reason === 'TOO_LARGE',
  );
  assert.equal(host.saved.length, 0, 'oversized bytes are never admitted');
});

test('media rejects a non-http URL and surfaces CANCELLED', async () => {
  const host = fakeHost();
  const network = makeNetwork(() => ({ status: 200, body: new Uint8Array([1]) }));
  await assert.rejects(
    admitInboundAttachment({ host, network, sessionId: 's', requestId: 'r', attachment: { url: 'file:///etc/passwd' } }),
    (e) => e.code === 'VALIDATION',
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    admitInboundAttachment({
      host, network, sessionId: 's', requestId: 'r', attachment: { url: 'https://x/y' }, signal: controller.signal,
    }),
    (e) => e.code === 'CANCELLED',
  );
});

test('media surfaces a download failure as NETWORK and never falls back to the URL', async () => {
  const host = fakeHost();
  const network = makeNetwork(() => Object.assign(new Error('boom'), { code: 'NETWORK' }));
  await assert.rejects(
    admitInboundAttachment({ host, network, sessionId: 's', requestId: 'r', attachment: { url: 'https://x/y' } }),
    (e) => e.code === 'NETWORK',
  );
  assert.equal(host.saved.length, 0);
});

test('readOutboundAttachment only accepts a host id and passes bytes through', async () => {
  const host = {
    async readAttachment({ attachmentId }) {
      assert.equal(attachmentId, 'att-9');
      return { name: 'r.txt', mime: 'text/plain', bytes: new Uint8Array([9]) };
    },
  };
  const result = await readOutboundAttachment({ host, sessionId: 's', attachmentId: 'att-9' });
  assert.deepEqual(result, { name: 'r.txt', mime: 'text/plain', bytes: new Uint8Array([9]) });
  await assert.rejects(
    readOutboundAttachment({ host: {}, sessionId: 's', attachmentId: 'att-9' }),
    (e) => e.code === 'UNSUPPORTED',
  );
});