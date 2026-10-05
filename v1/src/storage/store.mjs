// Single-file atomic store (02-DATA.md "Store与恢复").
// FIFO mutex; clone -> validate -> 0600 temp -> fsync -> rename -> dir fsync.
import { open, readFile, rename, mkdir, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError, conflict } from '../domain/errors.mjs';
import { validateState, createEmptyState } from '../domain/schema.mjs';
import { LIMITS } from '../domain/limits.mjs';

export const STATE_FILE = 'state.json';

export function statePath(dir) {
  return join(dir, STATE_FILE);
}

export class Store {
  #dir;
  #path;
  #state;
  #queue = Promise.resolve();
  #frozen = false;
  #closed = false;
  #durabilityWarnings = 0;

  constructor(dir, state) {
    this.#dir = dir;
    this.#path = statePath(dir);
    this.#state = state;
  }

  static async open(dir) {
    await mkdir(dir, { recursive: true });
    let state;
    try {
      const raw = await readFile(statePath(dir), 'utf8');
      state = JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') {
        state = createEmptyState();
      } else {
        // Never clear a corrupt/unknown store; surface it as degraded.
        throw new DomainError('STORAGE_UNAVAILABLE', `state.json is unreadable: ${err.code ?? err.message}`);
      }
    }
    assertSupportedSchema(state);
    validateState(state);
    return new Store(dir, state);
  }

  get dir() {
    return this.#dir;
  }

  get path() {
    return this.#path;
  }

  get revision() {
    return this.#state.revision;
  }

  get frozen() {
    return this.#frozen;
  }

  get durabilityWarnings() {
    return this.#durabilityWarnings;
  }

  snapshot() {
    return structuredClone(this.#state);
  }

  /** Resolve once every queued transaction has settled (errors swallowed). */
  whenIdle() {
    return this.#queue;
  }

  /**
   * Run a synchronous, IO-free mutator against a private clone and commit it.
   * The mutator must not re-enter the store or await anything.
   * @param {number|null} expectedGlobalRevision
   * @param {(draft:object)=>(unknown|void)} mutator
   * @returns {Promise<{revision:number, value:unknown}>}
   */
  transact(expectedGlobalRevision, mutator) {
    const run = async () => {
      if (this.#closed) throw new DomainError('STORAGE_UNAVAILABLE', 'store is closed');
      if (this.#frozen) {
        throw new DomainError('STORAGE_UNAVAILABLE', 'store writes are frozen after a durability failure');
      }
      if (typeof mutator !== 'function') throw new DomainError('INTERNAL', 'mutator must be a function');
      if (expectedGlobalRevision !== null && expectedGlobalRevision !== this.#state.revision) {
        throw conflict('store revision changed', {
          expected: expectedGlobalRevision,
          actual: this.#state.revision,
        });
      }
      const draft = structuredClone(this.#state);
      const value = mutator(draft);
      if (value && typeof value.then === 'function') {
        throw new DomainError('INTERNAL', 'transact mutator must be synchronous');
      }
      validateState(draft);
      const nextRevision = this.#state.revision + 1;
      draft.revision = nextRevision;
      const bytes = Buffer.byteLength(JSON.stringify(draft), 'utf8');
      if (bytes > LIMITS.MAX_STATE_BYTES) {
        throw new DomainError('CAPACITY', `state exceeds ${LIMITS.MAX_STATE_BYTES} bytes`);
      }
      await this.#writeAtomic(draft);
      this.#state = draft;
      return { revision: nextRevision, value };
    };

    const queued = this.#queue.then(run, run);
    this.#queue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  async close() {
    this.#closed = true;
    await this.#queue;
  }

  async #writeAtomic(state) {
    const json = JSON.stringify(state);
    const tmp = join(this.#dir, `.state.${cryptoId()}.tmp`);
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(json);
      await handle.sync();
    } catch (err) {
      await handle.close().catch(() => {});
      await unlink(tmp).catch(() => {});
      throw err;
    }
    await handle.close();

    try {
      await rename(tmp, this.#path);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err; // never published
    }

    try {
      const dirHandle = await open(this.#dir, 'r');
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch (err) {
      // Rename landed but directory metadata may not be durable. Freeze further
      // writes, re-read disk to reconcile, and report uncertain durability.
      this.#frozen = true;
      this.#durabilityWarnings += 1;
      await this.#reconcileAfterUncertain(json);
      throw new DomainError('STORAGE_UNAVAILABLE', 'state write durability is uncertain', {
        reason: 'DIR_FSYNC_FAILED',
        durability: 'uncertain',
      });
    }
  }

  async #reconcileAfterUncertain(expectedJson) {
    try {
      const onDisk = await readFile(this.#path, 'utf8');
      const parsed = JSON.parse(onDisk);
      validateState(parsed);
      // Publish what actually reached the disk so reads stay truthful.
      this.#state = parsed;
      if (onDisk !== expectedJson) this.#durabilityWarnings += 1;
    } catch {
      // Leave memory as-is; the next open() will surface the real error.
    }
    await cleanupTemp(this.#dir);
  }
}

async function cleanupTemp(dir) {
  try {
    for (const name of await readdir(dir)) {
      if (name.startsWith('.state.') && name.endsWith('.tmp')) {
        await unlink(join(dir, name)).catch(() => {});
      }
    }
  } catch {
    /* best effort */
  }
}

function assertSupportedSchema(state) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    throw new DomainError('STORAGE_UNAVAILABLE', 'state.json is not an object');
  }
  if (state.schemaVersion !== 1) {
    throw new DomainError('STORAGE_UNAVAILABLE', `unsupported schemaVersion: ${state.schemaVersion}`, {
      found: state.schemaVersion,
      supported: 1,
    });
  }
}

/**
 * Open a state directory. Never clears or overwrites a corrupt/unknown store.
 * @returns {Promise<{status:'ready',store:Store,error:null}|{status:'degraded',store:null,error:Error}>}
 */
export async function openStore(dir) {
  try {
    const store = await Store.open(dir);
    return { status: 'ready', store, error: null };
  } catch (err) {
    return { status: 'degraded', store: null, error: err };
  }
}

function cryptoId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}