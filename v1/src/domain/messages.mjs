// Inbound message model (T12; spec/ports.d.ts InboundEnvelope, 04-PROVIDERS.md:28).
//
// Domain-only: validates the canonical message shape and composes the text handed
// to the Host. Reference and attachment content are always user data — they are
// never turned into a system instruction, and the Host submission carries no role
// field at all, so nothing chat-derived can be elevated to a trusted directive.
import { validationError } from './errors.mjs';
import { LIMITS, codepointLength } from './limits.mjs';

export const HOST_TEXT_MAX_CODEPOINTS = LIMITS.MAX_MESSAGE_CODEPOINTS;

function requireId(value, name) {
  if (typeof value !== 'string' || value.length < 1 || value.length > LIMITS.MAX_ID_LENGTH) {
    throw validationError(`${name} must be an id string`);
  }
  return value;
}

function normalizeAttachment(input, index) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw validationError(`attachments[${index}] must be an object`);
  }
  const id = requireId(input.id, `attachments[${index}].id`);
  const name = typeof input.name === 'string' ? input.name : '';
  const mime = typeof input.mime === 'string' && input.mime !== '' ? input.mime : 'application/octet-stream';
  const size = Number.isInteger(input.size) && input.size >= 0 ? input.size : null;
  if (size === null) throw validationError(`attachments[${index}].size must be a non-negative integer`);
  return { id, name, mime, size };
}

function normalizeReplyTo(replyTo) {
  if (replyTo === null || replyTo === undefined) return null;
  if (typeof replyTo !== 'object' || Array.isArray(replyTo)) throw validationError('replyTo must be null or an object');
  const messageId = requireId(replyTo.messageId, 'replyTo.messageId');
  if (replyTo.content !== undefined && replyTo.content !== null && typeof replyTo.content !== 'string') {
    throw validationError('replyTo.content must be a string when present');
  }
  if (typeof replyTo.content === 'string' && codepointLength(replyTo.content) > HOST_TEXT_MAX_CODEPOINTS) {
    throw validationError(`replyTo.content exceeds ${HOST_TEXT_MAX_CODEPOINTS} codepoints`);
  }
  return replyTo.content === undefined ? { messageId } : { messageId, content: replyTo.content };
}

/**
 * Validate and normalize the `kind:'message'` arm of an InboundEnvelope.
 * @returns {{text:string, attachments:Array<{id,name,mime,size}>, replyTo:null|{messageId:string,content?:string}}}
 */
export function normalizeInboundMessage(envelope) {
  if (envelope === null || typeof envelope !== 'object') throw validationError('message envelope is required');
  if (envelope.kind !== 'message') throw validationError("kind must be 'message'");
  requireId(envelope.eventId, 'eventId');
  requireId(envelope.accountId, 'accountId');
  requireId(envelope.userId, 'userId');
  requireId(envelope.chatId, 'chatId');
  requireId(envelope.messageId, 'messageId');
  if (typeof envelope.text !== 'string') throw validationError('text must be a string');
  if (codepointLength(envelope.text) > HOST_TEXT_MAX_CODEPOINTS) {
    throw validationError(`text exceeds ${HOST_TEXT_MAX_CODEPOINTS} codepoints`);
  }
  const rawAttachments = envelope.attachments ?? [];
  if (!Array.isArray(rawAttachments)) throw validationError('attachments must be an array');
  if (rawAttachments.length > LIMITS.MAX_ATTACHMENTS) {
    throw validationError(`attachments exceed the ${LIMITS.MAX_ATTACHMENTS} item cap`);
  }
  const attachments = rawAttachments.map(normalizeAttachment);
  const totalBytes = attachments.reduce((sum, item) => sum + item.size, 0);
  if (totalBytes > LIMITS.MAX_ATTACHMENT_TOTAL_BYTES) {
    throw validationError(`attachments exceed ${LIMITS.MAX_ATTACHMENT_TOTAL_BYTES} total bytes`);
  }
  const replyTo = normalizeReplyTo(envelope.replyTo);
  if (envelope.text === '' && attachments.length === 0) {
    throw validationError('a message needs text or at least one attachment');
  }
  return { text: envelope.text, attachments, replyTo };
}

/**
 * Compose the Host-facing text. A completed reference is quoted as plain user data;
 * it is never promoted to an instruction and stays within the Host text cap.
 */
export function composeHostText(text, replyTo = null) {
  const body = typeof text === 'string' ? text : '';
  const quoted = typeof replyTo?.content === 'string' && replyTo.content !== '' ? `> ${replyTo.content}` : '';
  if (quoted === '') return body;
  const composed = body === '' ? quoted : `${quoted}\n\n${body}`;
  return Array.from(composed).slice(0, HOST_TEXT_MAX_CODEPOINTS).join('');
}

/**
 * Build the HostPort.submit payload for one inbound message. The shape has no
 * `role`/`instructions` field: reference and attachment content can only reach the
 * Host as user data.
 */
export function buildHostSubmission({ sessionId, requestId, text, attachments = [], replyTo = null, mode = 'followup' }) {
  requireId(sessionId, 'sessionId');
  requireId(requestId, 'requestId');
  if (mode !== 'followup' && mode !== 'inject' && mode !== 'steer') {
    throw validationError("mode must be one of followup|inject|steer");
  }
  return {
    sessionId,
    mode,
    text: composeHostText(text, replyTo),
    attachments,
    requestId,
  };
}