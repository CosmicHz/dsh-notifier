// Login manager (B03; 18-WIRING.md 链2, 20-HOST-PROTOCOL-MAP.md 登录, W17/W18).
//
// A login session is process state, not store state: the QR text and the SDK
// handle live only in memory with a deadline and an AbortController. Nothing but
// the resulting credentials is persisted, and only through the Account service in
// one transaction. A stale/late result is rejected (the account revision it was
// started against no longer matches) so it can never overwrite newer credentials.
//
// One session per account: starting a new one cancels the old. After a restart the
// previous loginId is gone, so status/cancel answer EXPIRED and the UI restarts.
import { randomUUID } from 'node:crypto';
import { DomainError, notFound, unsupported, validationError } from '../domain/errors.mjs';
import { LIMITS } from '../domain/limits.mjs';
import { commit } from '../storage/store.mjs';
import { patchAccount } from '../services/accounts.mjs';

export const LOGIN_STATUSES = Object.freeze(['pending', 'succeeded', 'expired', 'cancelled', 'failed']);

function nowOf(ctx) {
  return Number.isInteger(ctx?.now) ? ctx.now : Date.now();
}

/**
 * @param {object} options
 * @param {import('../storage/store.mjs').Store} options.store
 * @param {(account:object)=>({capabilities?:object,begin:Function})} [options.resolveDriver]
 * @param {()=>number} [options.now]
 * @param {()=>string} [options.newId]
 * @param {number} [options.maxMs] hard ceiling for one login session
 */
export function createLoginManager({
  store,
  resolveDriver,
  now = Date.now,
  newId = randomUUID,
  maxMs = LIMITS.LOGIN_TTL_MS,
} = {}) {
  const sessions = new Map(); // loginId -> internal session
  const byAccount = new Map(); // accountId -> loginId

  function view(session) {
    if (session.status === 'succeeded') {
      return { status: 'succeeded', accountId: session.accountId };
    }
    const out = { status: session.status };
    if (session.status === 'pending') {
      out.qrText = session.qrText;
      out.expiresAt = session.expiresAt;
      out.accountId = session.accountId;
    } else if (session.status === 'failed') {
      out.accountId = session.accountId;
      out.errorCode = session.errorCode;
    }
    return out;
  }

  function finish(session, status, { errorCode = null } = {}) {
    if (session.status !== 'pending') return session;
    session.status = status;
    session.errorCode = errorCode;
    session.qrText = null;
    session.cleanup();
    return session;
  }

  function makeSession(account, { qrText, expiresAt }) {
    const session = {
      id: newId(),
      accountId: account.id,
      accountRevision: account.revision,
      channelId: account.channelId,
      status: 'pending',
      qrText: qrText ?? null,
      expiresAt: Math.min(expiresAt ?? Number.POSITIVE_INFINITY, now() + maxMs),
      errorCode: null,
      controller: new AbortController(),
      timer: null,
      cleanup() {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
      },
    };
    return session;
  }

  function cancelExisting(accountId) {
    const currentId = byAccount.get(accountId);
    if (!currentId) return;
    const current = sessions.get(currentId);
    if (current && current.status === 'pending') {
      current.controller.abort();
      finish(current, 'cancelled');
    }
    byAccount.delete(accountId);
  }

  async function start(input, ctx = {}) {
    const accountId = input?.accountId;
    if (typeof accountId !== 'string' || accountId === '') throw validationError('accountId is required');
    const account = store.snapshot().accounts[accountId];
    if (!account) throw notFound('account not found');

    const driver = (ctx.driver ?? (resolveDriver ? resolveDriver(account) : null));
    if (!driver || driver.capabilities?.login !== true || typeof driver.begin !== 'function') {
      throw unsupported(`channel ${account.channelId} has no login capability`);
    }

    // A new scan replaces the old one; the old result may never commit.
    cancelExisting(accountId);

    const controller = new AbortController();
    let qrText = null;
    let expiresAt = null;
    const emitQr = (info) => {
      if (!info) return;
      if (typeof info.text === 'string') qrText = info.text;
      if (Number.isInteger(info.expiresAt)) expiresAt = info.expiresAt;
      const session = [...sessions.values()].find((s) => s.controller === controller);
      if (session && session.status === 'pending') session.qrText = qrText;
    };

    let done;
    try {
      const begun = await driver.begin({ account, signal: controller.signal, onQrCode: emitQr, now: nowOf(ctx) });
      if (begun && typeof begun.then === 'function') done = begun;
      else if (begun && typeof begun.done?.then === 'function') {
        done = begun.done;
        emitQr({ text: begun.qrText, expiresAt: begun.expiresAt });
      }
    } catch (error) {
      throw toLoginError(error, account.channelId);
    }
    if (!done) throw unsupported(`channel ${account.channelId} login driver returned no completion`);

    const session = makeSession(account, { qrText, expiresAt });
    session.controller = controller;
    sessions.set(session.id, session);
    byAccount.set(accountId, session.id);
    session.timer = setTimeout(() => {
      if (session.status !== 'pending') return;
      controller.abort();
      finish(session, 'expired');
      byAccount.delete(accountId);
    }, Math.max(0, session.expiresAt - now()));

    // Drive completion off the resolved promise; never await it here.
    Promise.resolve(done).then(
      (result) => commitResult(accountId, session, result),
      (error) => {
        if (session.status !== 'pending') return;
        finish(session, controller.signal.aborted ? 'cancelled' : 'failed', {
          errorCode: safeCode(error),
        });
        byAccount.delete(accountId);
      },
    );

    return { loginId: session.id, status: 'pending', qrText: session.qrText, expiresAt: session.expiresAt };
  }

  /**
   * Persist the credentials of a successful login. The commit is rejected unless
   * the session is still the live one AND the account revision is unchanged, so a
   * late scan can never overwrite a newer edit or a second login.
   */
  async function commitResult(accountId, session, result) {
    if (session.status !== 'pending') return;
    if (byAccount.get(accountId) !== session.id) return;
    const secretChanges = result?.secretChanges ?? [];
    if (!Array.isArray(secretChanges) || secretChanges.length === 0) {
      finish(session, 'failed', { errorCode: 'LOGIN_NO_CREDENTIALS' });
      byAccount.delete(accountId);
      return;
    }
    try {
      await commit(store, null, (draft) => patchAccount(draft, {
        id: accountId,
        expectedRevision: session.accountRevision,
        patch: {
          ...(result.config ? { config: result.config } : {}),
          enabled: true,
          controlEnabled: true,
        },
        secretChanges,
      }, { now: now() }));
      finish(session, 'succeeded');
    } catch (error) {
      finish(session, 'failed', {
        errorCode: error?.code === 'CONFLICT' ? 'LOGIN_STALE' : safeCode(error),
      });
    }
    byAccount.delete(accountId);
  }

  function status(input) {
    const loginId = input?.loginId;
    if (typeof loginId !== 'string' || loginId === '') throw validationError('loginId is required');
    const session = sessions.get(loginId);
    if (!session) {
      // A loginId from a previous boot no longer exists in memory.
      throw new DomainError('EXPIRED', 'login session expired', { code: 'LOGIN_EXPIRED' });
    }
    if (session.status === 'pending' && now() >= session.expiresAt) {
      session.controller.abort();
      finish(session, 'expired');
      byAccount.delete(session.accountId);
    }
    return view(session);
  }

  function cancel(input) {
    const loginId = input?.loginId;
    if (typeof loginId !== 'string' || loginId === '') throw validationError('loginId is required');
    const session = sessions.get(loginId);
    if (!session) throw new DomainError('EXPIRED', 'login session expired', { code: 'LOGIN_EXPIRED' });
    if (session.status === 'pending') {
      session.controller.abort();
      finish(session, 'cancelled');
      byAccount.delete(session.accountId);
    }
    return { status: 'cancelled' };
  }

  function dispose() {
    for (const session of sessions.values()) {
      if (session.status === 'pending') {
        session.controller.abort();
        finish(session, 'cancelled');
      }
    }
    byAccount.clear();
    sessions.clear();
  }

  return { start, status, cancel, dispose, get size() { return sessions.size; } };
}

function safeCode(error) {
  const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'LOGIN_FAILED';
  return code.slice(0, 64);
}

function toLoginError(error, channelId) {
  if (error instanceof DomainError) return error;
  return new DomainError('INTERNAL', `channel ${channelId} login failed: ${error?.message ?? 'unknown error'}`, {
    code: safeCode(error),
  });
}

export { safeCode as loginErrorCode };