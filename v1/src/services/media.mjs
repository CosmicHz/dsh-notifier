// Inbound media admission (T12; W26 "媒体与引用只定义输入，没有资源归属").
//
// MediaService owns the download: an inbound attachment URL is fetched through the
// shared NetworkPort (never relaxed to private networks), bounded by size and
// cancellable, then admitted into the Host attachment store. A remote URL is never
// handed to the Host as if it were an attachment, and the Host's id is the only
// handle returned. Untransferred bytes never outlive this call — there is no temp
// file to leak — and after admission the Host owns the attachment lifetime.
import { DomainError, cancelled, unsupported, validationError } from '../domain/errors.mjs';
import { LIMITS } from '../domain/limits.mjs';

export const INBOUND_MEDIA_MAX_BYTES = LIMITS.MAX_ATTACHMENT_BYTES;
const DEFAULT_TIMEOUT_MS = LIMITS.NETWORK_TIMEOUT_MS;

export function hostSupportsAttachments(host) {
  return host !== null && host !== undefined && typeof host.saveAttachment === 'function';
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || value === '') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function requireId(value, name) {
  if (typeof value !== 'string' || value.length < 1 || value.length > LIMITS.MAX_ID_LENGTH) {
    throw validationError(`${name} must be an id string`);
  }
  return value;
}

function tooLarge(maxBytes) {
  return new DomainError('VALIDATION', `attachment exceeds ${maxBytes} bytes`, { reason: 'TOO_LARGE', maxBytes });
}

/**
 * Download one inbound attachment and admit it into the Host store.
 * @param {object} input {host, network, sessionId, requestId, attachment:{url,name?,mime?,size?},
 *   signal?, maxBytes?, timeoutMs?}
 * @returns {Promise<{id:string,name:string,mime:string,size:number}>}
 */
export async function admitInboundAttachment({
  host,
  network,
  sessionId,
  requestId,
  attachment,
  signal = null,
  maxBytes = INBOUND_MEDIA_MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  requireId(sessionId, 'sessionId');
  requireId(requestId, 'requestId');
  if (attachment === null || typeof attachment !== 'object') throw validationError('attachment is required');
  if (!isHttpUrl(attachment.url)) throw validationError('attachment url must be an http(s) URL');
  if (!hostSupportsAttachments(host)) {
    throw unsupported('host has no attachment store; a remote URL is never handed over as an attachment');
  }
  if (typeof attachment.size === 'number' && attachment.size > maxBytes) throw tooLarge(maxBytes);
  if (signal?.aborted) throw cancelled('attachment download cancelled');

  let response;
  try {
    response = await network.request({
      url: attachment.url,
      method: 'GET',
      headers: {},
      timeoutMs,
      maxBytes,
      allowPrivateNetwork: false, // inbound attachments never relax the network policy
      signal,
    });
  } catch (error) {
    if (signal?.aborted || error?.code === 'CANCELLED') throw cancelled('attachment download cancelled');
    if (error instanceof DomainError) throw error;
    throw new DomainError('NETWORK', 'attachment download failed');
  }
  if (Number.isInteger(response?.status) && (response.status < 200 || response.status >= 300)) {
    throw new DomainError('NETWORK', `attachment download failed with HTTP ${response.status}`);
  }
  const bytes = response?.body instanceof Uint8Array ? response.body : new Uint8Array();
  if (bytes.byteLength === 0) throw new DomainError('NETWORK', 'attachment download returned no bytes');
  if (bytes.byteLength > maxBytes) throw tooLarge(maxBytes);

  const name = typeof attachment.name === 'string' ? attachment.name : '';
  const mime = typeof attachment.mime === 'string' && attachment.mime !== '' ? attachment.mime : 'application/octet-stream';
  let ref;
  try {
    ref = await host.saveAttachment({ sessionId, name, mime, bytes, requestId, signal });
  } catch (error) {
    if (signal?.aborted || error?.code === 'CANCELLED') throw cancelled('attachment save cancelled');
    throw error;
  }
  if (ref === null || typeof ref !== 'object' || typeof ref.id !== 'string' || ref.id === '') {
    throw new DomainError('UNSUPPORTED', 'host did not return an attachment id; the remote URL is not used as a fallback');
  }
  return {
    id: ref.id,
    name: typeof ref.name === 'string' ? ref.name : name,
    mime: typeof ref.mime === 'string' ? ref.mime : mime,
    size: Number.isInteger(ref.size) ? ref.size : bytes.byteLength,
  };
}

/**
 * Fetch a Host-owned attachment for the outbound/return path. Only a Host id may be
 * read — never an arbitrary host path or remote URL.
 */
export async function readOutboundAttachment({ host, sessionId, attachmentId, signal = null }) {
  requireId(sessionId, 'sessionId');
  requireId(attachmentId, 'attachmentId');
  if (host === null || host === undefined || typeof host.readAttachment !== 'function') {
    throw unsupported('host has no attachment reader');
  }
  if (signal?.aborted) throw cancelled('attachment read cancelled');
  let result;
  try {
    result = await host.readAttachment({ sessionId, attachmentId, signal });
  } catch (error) {
    if (signal?.aborted || error?.code === 'CANCELLED') throw cancelled('attachment read cancelled');
    throw error;
  }
  const bytes = result?.bytes instanceof Uint8Array ? result.bytes : null;
  if (bytes === null) throw new DomainError('UNSUPPORTED', 'host returned no attachment bytes');
  return {
    name: typeof result.name === 'string' ? result.name : '',
    mime: typeof result.mime === 'string' && result.mime !== '' ? result.mime : 'application/octet-stream',
    bytes,
  };
}