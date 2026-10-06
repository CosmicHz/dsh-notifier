// R12 acceptance: the production conversation path must never hand a provider
// download descriptor (which embeds a platform token URL) to Host.submit. Media
// is downloaded through the bounded, non-private NetworkPort via MediaService and
// admitted as a secret-free Host AttachmentRef first. Real Store, real manager,
// real conversation/media services and the in-memory Host fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/storage/store.mjs';
import { createAccount } from '../../src/services/accounts.mjs';
import { createRuntimeManager } from '../../src/runtime/manager.mjs';
import { createFixtureHost } from '../fixtures/host.mjs';
import { upsertReplyContext } from '../../src/services/reply-contexts.mjs';
import { makeNetwork } from '../protocol/helpers.mjs';

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-r12-'));
  const { store } = await openStore(dir);
  const account = await createAccount(store, {
    channelId: 'telegram',
    label: 'TG',
    enabled: true,
    config: { outbound: {}, inbound: {} },
    notificationEnabled: false,
    controlEnabled: true,
    secretChanges: [{ op: 'set', path: 'inbound.botToken', value: { kind: 'literal', value: '"fake-token"' } }],
  }, { now: 100 });
  return { store, account };
}

async function seedPrincipal(store, account, { id = 'p-1', userId = 'u-1', chatId = 'c-1', rcId = 'rc-1' } = {}) {
  await store.transact(null, (draft) => {
    upsertReplyContext(draft, { accountId: account.id, userId, chatId, id: rcId }, { now: 10 });
    draft.principals[id] = {
      id, revision: 0, accountId: account.id, userId, role: 'owner', canConverse: true,
      sessionIds: ['s-1'], enabled: true, replyContextId: rcId, createdAt: 10, updatedAt: 10,
    };
    return null;
  });
}

/** A control-reply-capable provider so an inbound reply can be delivered. */
function replyProvider(sent) {
  return {
    id: 'telegram',
    capabilities: { outbound: true, inbound: true, controlReply: true },
    async sendControlReply({ content }) {
      sent.push(content);
      return { status: 'accepted', providerMessageId: `pm-${sent.length}` };
    },
  };
}

test('R12 inbound media is admitted; the token URL never reaches the Host', async () => {
  const { store, account } = await scratch();
  await seedPrincipal(store, account);
  const host = createFixtureHost();
  const network = makeNetwork(() => ({ status: 200, body: new Uint8Array([1, 2, 3]) }));
  const manager = createRuntimeManager({
    store, host, network, resolveProvider: () => replyProvider([]),
  });
  await manager.start();
  const epoch = manager.connectionView(account.id).epoch;

  const result = await manager.ingest({
    accountId: account.id, eventId: 'e-media', epoch, userId: 'u-1', chatId: 'c-1',
    kind: 'message', text: '看图',
    attachments: [{
      id: 'tg-file-1', url: 'https://api.telegram.org/file/botFAKE/secret.jpg',
      name: 'p.jpg', mime: 'image/jpeg', size: 3,
    }],
  });

  assert.equal(result.accepted, true);
  assert.equal(result.outcome.mode, 'followup');
  assert.equal(network.calls.length, 1, 'the descriptor is fetched exactly once');
  assert.equal(network.calls[0].allowPrivateNetwork, false, 'inbound media never relaxes the network policy');
  assert.equal(network.calls[0].maxBytes, 10 * 1024 * 1024, 'the download is byte-bounded');

  const submitted = host.submitted.at(-1);
  assert.equal(submitted.attachments.length, 1);
  const ref = submitted.attachments[0];
  assert.equal(typeof ref.id, 'string');
  assert.equal(ref.name, 'p.jpg');
  assert.equal(ref.mime, 'image/jpeg');
  assert.equal(ref.size, 3);
  assert.equal(ref.url, undefined, 'the token URL is never handed to the Host');
  assert.ok(!JSON.stringify(submitted).includes('botFAKE'), 'no token leaks into the host submission');
  await manager.stop();
});

test('R12 an attachment-only message is allowed and admitted', async () => {
  const { store, account } = await scratch();
  await seedPrincipal(store, account);
  const host = createFixtureHost();
  const network = makeNetwork(() => ({ status: 200, body: new Uint8Array([9, 9]) }));
  const manager = createRuntimeManager({
    store, host, network, resolveProvider: () => replyProvider([]),
  });
  await manager.start();
  const epoch = manager.connectionView(account.id).epoch;

  const result = await manager.ingest({
    accountId: account.id, eventId: 'e-media-only', epoch, userId: 'u-1', chatId: 'c-1',
    kind: 'message', text: '',
    attachments: [{ url: 'https://cdn.example.com/a.png', name: 'a.png', mime: 'image/png', size: 2 }],
  });

  assert.equal(result.accepted, true);
  const submitted = host.submitted.at(-1);
  assert.equal(submitted.text, '');
  assert.equal(submitted.attachments.length, 1);
  assert.equal(submitted.attachments[0].size, 2);
  await manager.stop();
});

test('R12 a media download failure aborts the turn; no raw URL reaches the Host', async () => {
  const { store, account } = await scratch();
  await seedPrincipal(store, account);
  const host = createFixtureHost();
  const network = makeNetwork(() => new Error('boom'));
  const manager = createRuntimeManager({
    store, host, network, resolveProvider: () => replyProvider([]),
  });
  await manager.start();
  const epoch = manager.connectionView(account.id).epoch;

  const result = await manager.ingest({
    accountId: account.id, eventId: 'e-media-fail', epoch, userId: 'u-1', chatId: 'c-1',
    kind: 'message', text: 'x',
    attachments: [{ url: 'https://cdn.example.com/x.png', name: 'x.png', mime: 'image/png' }],
  });

  assert.equal(result.accepted, true);
  assert.equal(result.code, 'NETWORK');
  assert.equal(host.submitted.length, 0, 'the Host is never asked to submit an unresolved attachment');
  await manager.stop();
});

test('R12 a host that cannot store attachments refuses cleanly, never falling back to the URL', async () => {
  const { store, account } = await scratch();
  await seedPrincipal(store, account);
  const host = createFixtureHost();
  host.saveAttachment = async () => {
    throw Object.assign(new Error('no attachment store'), { code: 'UNSUPPORTED' });
  };
  const network = makeNetwork(() => ({ status: 200, body: new Uint8Array([1]) }));
  const manager = createRuntimeManager({
    store, host, network, resolveProvider: () => replyProvider([]),
  });
  await manager.start();
  const epoch = manager.connectionView(account.id).epoch;

  const result = await manager.ingest({
    accountId: account.id, eventId: 'e-media-unsupported', epoch, userId: 'u-1', chatId: 'c-1',
    kind: 'message', text: 'x',
    attachments: [{ url: 'https://cdn.example.com/x.png', name: 'x.png', mime: 'image/png' }],
  });

  assert.equal(result.code, 'UNSUPPORTED');
  assert.equal(host.submitted.length, 0);
  await manager.stop();
});

test('R12 group and unpaired inbound media is rejected before any download', async () => {
  const { store, account } = await scratch();
  await seedPrincipal(store, account);
  const host = createFixtureHost();
  const network = makeNetwork(() => ({ status: 200, body: new Uint8Array([1]) }));
  const manager = createRuntimeManager({
    store, host, network, resolveProvider: () => replyProvider([]),
  });
  await manager.start();
  const epoch = manager.connectionView(account.id).epoch;

  const group = await manager.ingest({
    accountId: account.id, eventId: 'e-media-group', epoch, userId: 'u-1', chatId: 'c-1',
    chatType: 'group', kind: 'message', text: '',
    attachments: [{ url: 'https://cdn.example.com/g.png', name: 'g.png', mime: 'image/png' }],
  });
  assert.equal(group.outcome.ignored, 'GROUP_CONTROL_DENIED');

  const unpaired = await manager.ingest({
    accountId: account.id, eventId: 'e-media-unpaired', epoch, userId: 'u-9', chatId: 'c-9',
    kind: 'message', text: '',
    attachments: [{ url: 'https://cdn.example.com/u.png', name: 'u.png', mime: 'image/png' }],
  });
  assert.equal(unpaired.outcome.code, 'NOT_PAIRED');

  assert.equal(network.calls.length, 0, 'group/unpaired media is never downloaded');
  assert.equal(host.submitted.length, 0);
  await manager.stop();
});
