// Reply contexts (02-DATA.md replyContext, 20-HOST-PROTOCOL-MAP.md 控制回程).
//
// A reply context is the accountable return path for one private chat. It is
// created and refreshed ONLY by authenticated inbound, may carry platform reply
// secrets in transportData, and is never exposed through an RPC view. Without a
// usable context a control push fails with CONTEXT_EXPIRED so the UI can ask the
// user to send one private message to refresh it.
import { randomUUID } from 'node:crypto';
import { DomainError, notFound, validationError } from '../domain/errors.mjs';
import { LIMITS } from '../domain/limits.mjs';

const MAX_TRANSPORT_BYTES = 16 * 1024;

function nowOf(ctx) {
  return Number.isInteger(ctx?.now) ? ctx.now : Date.now();
}

export function replyContextKey(id) {
  return id;
}

function validateTransportData(transportData) {
  if (transportData === undefined || transportData === null) return {};
  if (typeof transportData !== 'object' || Array.isArray(transportData)) {
    throw validationError('transportData must be an object');
  }
  const bytes = Buffer.byteLength(JSON.stringify(transportData), 'utf8');
  if (bytes > MAX_TRANSPORT_BYTES) throw validationError(`transportData exceeds ${MAX_TRANSPORT_BYTES} bytes`);
  return structuredClone(transportData);
}

function requirePrivateChat(chatType) {
  if (chatType !== 'private') throw validationError('reply contexts are private-chat only');
}

/**
 * Create or refresh a reply context from an authenticated inbound event.
 * @param {object} draft
 * @param {{accountId:string,userId:string,chatId:string,chatType?:'private',transportData?:object,
 *   expiresAt?:number|null,principalId?:string|null,id?:string|null}} input
 */
export function upsertReplyContext(draft, input, ctx = {}) {
  const accountId = input?.accountId;
  const account = draft.accounts[accountId];
  if (!account) throw notFound('account not found');
  if (typeof input?.userId !== 'string' || input.userId === '') throw validationError('userId is required');
  if (typeof input?.chatId !== 'string' || input.chatId === '') throw validationError('chatId is required');
  requirePrivateChat(input?.chatType ?? 'private');
  const expiresAt = input?.expiresAt ?? null;
  if (expiresAt !== null && (!Number.isInteger(expiresAt) || expiresAt < 0)) {
    throw validationError('expiresAt must be null or a non-negative integer');
  }
  const transportData = validateTransportData(input?.transportData);
  const now = nowOf(ctx);

  let id = input?.id ?? null;
  const principalId = input?.principalId ?? null;
  if (principalId !== null) {
    const principal = draft.principals[principalId];
    if (!principal) throw notFound('principal not found');
    if (principal.accountId !== accountId) throw validationError('principal belongs to another account');
    // At most one context per principal: reuse the principal's current one.
    if (principal.replyContextId && draft.replyContexts[principal.replyContextId]) {
      id = principal.replyContextId;
    } else if (id === null) {
      id = randomUUID();
    }
  } else if (id === null) {
    id = randomUUID();
    enforceUnpairedCap(draft, accountId, now);
  }

  const existing = id !== null ? draft.replyContexts[id] : null;
  if (existing) {
    if (existing.accountId !== accountId) throw validationError('reply context belongs to another account');
    existing.userId = input.userId;
    existing.chatId = input.chatId;
    existing.transportData = transportData;
    existing.expiresAt = expiresAt;
    existing.updatedAt = now;
    return existing;
  }

  const record = {
    id,
    accountId,
    userId: input.userId,
    chatId: input.chatId,
    chatType: 'private',
    transportData,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  };
  draft.replyContexts[record.id] = record;
  return record;
}

export function getReplyContext(draft, id) {
  const record = draft.replyContexts[id];
  if (!record) throw notFound('reply context not found');
  return record;
}

export function isReplyContextUsable(record, now = Date.now()) {
  if (!record) return false;
  return record.expiresAt === null || record.expiresAt > now;
}

/** Throws EXPIRED/CONTEXT_EXPIRED when a control push cannot use this context. */
export function assertReplyContextUsable(record, now = Date.now()) {
  if (!record) throw new DomainError('EXPIRED', 'reply context is unavailable', { code: 'CONTEXT_EXPIRED' });
  if (!isReplyContextUsable(record, now)) {
    throw new DomainError('EXPIRED', 'reply context expired; ask the user to send a private message', {
      code: 'CONTEXT_EXPIRED',
    });
  }
  return record;
}

/** The only shape safe to leave the process: transportData is never returned. */
export function replyContextView(record) {
  return {
    id: record.id,
    accountId: record.accountId,
    userId: record.userId,
    chatId: record.chatId,
    chatType: record.chatType,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function enforceUnpairedCap(draft, accountId, now) {
  const referenced = new Set(
    Object.values(draft.principals).map((p) => p.replyContextId).filter((v) => typeof v === 'string'),
  );
  const unpaired = Object.values(draft.replyContexts)
    .filter((c) => c.accountId === accountId && !referenced.has(c.id))
    .sort((a, b) => a.createdAt - b.createdAt);
  if (unpaired.length >= LIMITS.REPLY_CONTEXT_PER_ACCOUNT) {
    // Drop the oldest unpair context rather than refusing a fresh login.
    for (let i = 0; i <= unpaired.length - LIMITS.REPLY_CONTEXT_PER_ACCOUNT; i++) {
      delete draft.replyContexts[unpaired[i].id];
    }
  }
}

/**
 * Remove expired contexts and unpair contexts older than the cache window. A
 * context still referenced by a principal is kept even when unexpired.
 */
export function pruneReplyContexts(draft, { now = Date.now() } = {}) {
  const referenced = new Set(
    Object.values(draft.principals).map((p) => p.replyContextId).filter((v) => typeof v === 'string'),
  );
  const cutoff = now - LIMITS.REPLY_CONTEXT_WINDOW_MS;
  for (const [id, record] of Object.entries(draft.replyContexts)) {
    if (record.expiresAt !== null && record.expiresAt <= now && !referenced.has(id)) {
      delete draft.replyContexts[id];
      continue;
    }
    if (!referenced.has(id) && record.updatedAt < cutoff) delete draft.replyContexts[id];
  }
}

export { MAX_TRANSPORT_BYTES as REPLY_CONTEXT_MAX_TRANSPORT_BYTES };