// Reply-reference completion (T12; 04-PROVIDERS.md:28 "统一引用").
//
// Rules:
//  - a complete reference in the payload wins: no network, no provider call.
//  - otherwise, only a provider that actually declares `replyLookup` (with a real
//    resolveReply method) may be queried; without the capability we return a typed
//    unavailableReason instead of guessing.
//  - lookup scope is fixed to the current account/chat; a reference that names a
//    different account or chat is refused rather than silently followed.
//  - cancelled lookups surface CANCELLED; oversized results fail closed.
import { DomainError, cancelled, conflict, validationError } from '../domain/errors.mjs';
import { LIMITS, codepointLength } from '../domain/limits.mjs';

export const REPLY_CONTENT_MAX_CODEPOINTS = LIMITS.MAX_MESSAGE_CODEPOINTS;

export function replyLookupSupported(provider) {
  return provider?.capabilities?.replyLookup === true && typeof provider.resolveReply === 'function';
}

function assertSameScope(reference, accountId, chatId) {
  if (reference?.accountId !== undefined && reference.accountId !== null && reference.accountId !== accountId) {
    throw conflict('reply reference belongs to a different account');
  }
  if (reference?.chatId !== undefined && reference.chatId !== null && reference.chatId !== chatId) {
    throw conflict('reply reference belongs to a different chat');
  }
}

function finish(messageId, content) {
  if (codepointLength(content) > REPLY_CONTENT_MAX_CODEPOINTS) {
    return { messageId, content: null, unavailableReason: 'too_large' };
  }
  return { messageId, content, unavailableReason: null };
}

/**
 * Resolve one reply reference to content.
 * @param {object} provider provider with optional replyLookup capability
 * @param {{accountId:string, chatId:string, reference:object, signal?:AbortSignal, network?:object}} input
 * @returns {Promise<{messageId:string, content:string|null, unavailableReason:string|null}>}
 */
export async function resolveReplyTo(provider, { accountId, chatId, reference, signal = null, network = null }) {
  const messageId = reference?.messageId;
  if (typeof messageId !== 'string' || messageId === '' || messageId.length > LIMITS.MAX_ID_LENGTH) {
    throw validationError('replyTo.messageId must be a non-empty id');
  }
  assertSameScope(reference, accountId, chatId);

  // 1. complete reference already present in the payload.
  if (typeof reference.content === 'string' && reference.content !== '') {
    return finish(messageId, reference.content);
  }

  // 2. no protocol capability: a typed reason, never a fabricated result.
  if (!replyLookupSupported(provider)) {
    return { messageId, content: null, unavailableReason: 'unsupported' };
  }

  if (signal?.aborted) throw cancelled('reply lookup cancelled');
  let resolved;
  try {
    resolved = await provider.resolveReply({ accountId, chatId, reference: { messageId }, signal, network });
  } catch (error) {
    if (signal?.aborted || error?.code === 'CANCELLED') throw cancelled('reply lookup cancelled');
    if (error instanceof DomainError) throw error;
    throw new DomainError('NETWORK', 'reply lookup failed');
  }

  const content = typeof resolved?.content === 'string' ? resolved.content : '';
  if (content === '') return { messageId, content: null, unavailableReason: 'unavailable' };
  return finish(messageId, content);
}