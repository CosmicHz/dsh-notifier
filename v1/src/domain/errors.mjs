// DomainError and the fixed error-code set (03-SERVICES-RPC.md).
export const ERROR_CODES = Object.freeze([
  'VALIDATION',
  'NOT_FOUND',
  'CONFLICT',
  // The manager returns NOT_READY for any call made before start() (18-WIRING).
  'NOT_READY',
  'FORBIDDEN',
  'EXPIRED',
  'ALREADY_HANDLED',
  'CAPACITY',
  'UNSUPPORTED',
  'STORAGE_UNAVAILABLE',
  'NETWORK',
  'TIMEOUT',
  'CANCELLED',
  'INTERNAL',
  'UNCERTAIN',
]);

const CODE_SET = new Set(ERROR_CODES);

export class DomainError extends Error {
  /**
   * @param {string} code one of ERROR_CODES
   * @param {string} message human readable, already free of secrets
   * @param {unknown} [details] redacted structured detail, or null
   */
  constructor(code, message, details = null) {
    if (!CODE_SET.has(code)) {
      throw new Error(`unknown domain error code: ${code}`);
    }
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details ?? null;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function isDomainError(value) {
  return value instanceof DomainError;
}

export function validationError(message, errors) {
  return new DomainError('VALIDATION', message, errors ? { errors } : null);
}

export function notFound(message, details = null) {
  return new DomainError('NOT_FOUND', message, details);
}

export function conflict(message, details = null) {
  return new DomainError('CONFLICT', message, details);
}

export function unsupported(message, details = null) {
  return new DomainError('UNSUPPORTED', message, details);
}

export function cancelled(message = 'operation cancelled') {
  return new DomainError('CANCELLED', message);
}

export function uncertain(message, details = null) {
  return new DomainError('UNCERTAIN', message, details);
}

export function internal(message, details = null) {
  return new DomainError('INTERNAL', message, details);
}