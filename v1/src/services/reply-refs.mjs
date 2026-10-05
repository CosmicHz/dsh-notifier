// Reply references / callback tokens (02-DATA.md replyRef, 04-PROVIDERS.md,
// 18-WIRING.md 交互回复, W04).
//
// A replyRef is the durable, scoped credential for one interaction action. Only
// the token hash is stored (the plaintext token exists only while the card is
// being sent), so a restart can still verify a button press but a leaked store
// cannot be replayed. Lookups are pinned to account/principal/chat: a token from
// another chat never matches, and list position / "most recent" are never used.
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { DomainError, notFound, validationError } from '../domain/errors.mjs';
import { LIMITS } from '../domain/limits.mjs';

export const REPLY_ACTIONS = Object.freeze(['approve', 'reject', 'answer']);
export const REPLY_REF_STATES = Object.freeze(['active', 'used', 'revoked']);

export function hashReplyToken(token) {
  if (typeof token !== 'string' || token === '') throw validationError('token is required');
  return createHash('sha256').update(token).digest('hex');
}

function nowOf(ctx) {
  return Number.isInteger(ctx?.now) ? ctx.now : Date.now();
}

/**
 * Issue one replyRef and return the plaintext token exactly once.
 * @returns {{ref:object, token:string}}
 */
export function issueReplyRef(draft, input, ctx = {}) {
  const account = draft.accounts[input?.accountId];
  if (!account) throw notFound('account not found');
  const principal = draft.principals[input?.principalId];
  if (!principal) throw notFound('principal not found');
  if (principal.accountId !== account.id) throw validationError('principal belongs to another account');
  const context = draft.replyContexts[input?.replyContextId];
  if (!context) throw notFound('reply context not found');
  if (context.accountId !== account.id) throw validationError('reply context belongs to another account');
  if (!REPLY_ACTIONS.includes(input?.action)) throw validationError(`action must be one of ${REPLY_ACTIONS.join('|')}`);
  const interaction = draft.interactions[input?.interactionId];
  if (!interaction) throw notFound('interaction not found');
  const expiresAt = input?.expiresAt;
  if (!Number.isInteger(expiresAt) || expiresAt <= 0) throw validationError('expiresAt is required');

  const now = nowOf(ctx);
  const token = input?.token ?? randomBytes(24).toString('hex');
  const ref = {
    id: input?.id ?? (ctx.newId ? ctx.newId() : randomUUID()),
    tokenHash: hashReplyToken(token),
    accountId: account.id,
    principalId: principal.id,
    replyContextId: context.id,
    interactionId: interaction.id,
    interactionRevision: Number.isInteger(input?.interactionRevision) ? input.interactionRevision : interaction.revision,
    policyRevision: Number.isInteger(input?.policyRevision) ? input.policyRevision : account.policyRevision,
    action: input.action,
    messageId: null,
    expiresAt,
    state: 'active',
    createdAt: now,
  };
  draft.replyRefs[ref.id] = ref;
  pruneReplyRefs(draft, { now });
  return { ref, token };
}

export function setReplyRefMessageId(draft, refId, messageId) {
  const ref = draft.replyRefs[refId];
  if (!ref) throw notFound('reply ref not found');
  if (typeof messageId !== 'string' || messageId === '') throw validationError('messageId must be a non-empty string');
  ref.messageId = messageId;
  return ref;
}

function scopeMatches(draft, ref, { accountId, principalId = null, chatId = null }) {
  if (ref.accountId !== accountId) return false;
  if (principalId !== null && ref.principalId !== principalId) return false;
  if (chatId !== null) {
    const context = draft.replyContexts[ref.replyContextId];
    if (!context || context.chatId !== chatId) return false;
  }
  return true;
}

function assertUsable(ref, now) {
  if (!ref) throw notFound('reply ref not found');
  if (ref.state === 'used') throw new DomainError('ALREADY_HANDLED', 'this reply was already used');
  if (ref.state === 'revoked') throw new DomainError('EXPIRED', 'this reply was revoked');
  if (ref.expiresAt <= now) throw new DomainError('EXPIRED', 'this reply expired');
  return ref;
}

/** Resolve a platform button token, scoped to account/principal/chat. */
export function lookupReplyRefByToken(draft, { token, accountId, chatId = null, principalId = null, now = Date.now() }) {
  if (typeof token !== 'string' || token === '') throw validationError('token is required');
  const wanted = hashReplyToken(token);
  const match = Object.values(draft.replyRefs).find((ref) => ref.tokenHash === wanted);
  if (!match || !scopeMatches(draft, match, { accountId, principalId, chatId })) {
    throw notFound('reply ref not found for this scope');
  }
  return assertUsable(match, now);
}

/** Resolve a text command REF (/approve REF etc.), scoped the same way. */
export function lookupReplyRefById(draft, { refId, accountId, principalId = null, chatId = null, now = Date.now() }) {
  const ref = draft.replyRefs[refId];
  if (!ref || !scopeMatches(draft, ref, { accountId, principalId, chatId })) {
    throw notFound('reply ref not found for this scope');
  }
  return assertUsable(ref, now);
}

export function markReplyRefUsed(draft, refId) {
  const ref = draft.replyRefs[refId];
  if (!ref) throw notFound('reply ref not found');
  ref.state = 'used';
  return ref;
}

function revokeWhere(draft, predicate) {
  let count = 0;
  for (const ref of Object.values(draft.replyRefs)) {
    if (ref.state === 'active' && predicate(ref)) {
      ref.state = 'revoked';
      count += 1;
    }
  }
  return count;
}

export function revokeReplyRefsForInteraction(draft, interactionId) {
  return revokeWhere(draft, (ref) => ref.interactionId === interactionId);
}

export function revokeReplyRefsForPrincipal(draft, principalId) {
  return revokeWhere(draft, (ref) => ref.principalId === principalId);
}

export function revokeReplyRefsForAccount(draft, accountId) {
  return revokeWhere(draft, (ref) => ref.accountId === accountId);
}

export function revokeReplyRefsForContext(draft, replyContextId) {
  return revokeWhere(draft, (ref) => ref.replyContextId === replyContextId);
}

/** Active refs for one interaction (used to refresh targets after re-auth). */
export function activeReplyRefsForInteraction(draft, interactionId) {
  return Object.values(draft.replyRefs).filter(
    (ref) => ref.interactionId === interactionId && ref.state === 'active',
  );
}

export function pruneReplyRefs(draft, { now = Date.now() } = {}) {
  for (const [id, ref] of Object.entries(draft.replyRefs)) {
    if (ref.state !== 'active' && ref.expiresAt <= now) delete draft.replyRefs[id];
    else if (ref.state === 'active' && ref.expiresAt <= now) ref.state = 'revoked';
  }
  const ids = Object.keys(draft.replyRefs);
  if (ids.length <= LIMITS.MAX_REPLY_REFS) return;
  const terminal = ids
    .filter((id) => draft.replyRefs[id].state !== 'active')
    .sort((a, b) => draft.replyRefs[a].createdAt - draft.replyRefs[b].createdAt);
  for (let i = 0; i < ids.length - LIMITS.MAX_REPLY_REFS && i < terminal.length; i++) {
    delete draft.replyRefs[terminal[i]];
  }
}