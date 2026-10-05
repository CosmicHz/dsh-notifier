// bell local provider (04-PROVIDERS.md, reference adapters/bell.mjs).
// Terminal BEL (\x07) — the headless/TUI equivalent of a notification sound.
// Zero dependencies: only a single stdout write, no sound library, no terminfo.
// The write sink is injectable for protocol tests; silent messages never ring.
import { capabilitiesOf } from '../specs.mjs';

export const id = 'bell';

export function resolve(config = {}) {
  const raw = config.count;
  let count = 1;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    count = Math.min(5, Math.max(1, Math.trunc(raw)));
  } else if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
    count = Math.min(5, Math.max(1, Math.trunc(Number(raw))));
  }
  return { count };
}

export function validate(config = {}) {
  resolve(config);
}

/**
 * Ring `count` times in one write (avoids interleaving escape sequences).
 * A closed stdout is silently ignored: a bell is a nicety, never fatal.
 */
export async function send({ config, message, local }) {
  const resolved = resolve(config ?? {});
  if (message?.silent === true) return { status: 'accepted' };
  const write = typeof local?.write === 'function' ? local.write : (chunk) => process.stdout.write(chunk);
  const ring = '\x07'.repeat(resolved.count);
  try {
    write(ring);
  } catch {
    /* stdout closed: silent */
  }
  return { status: 'accepted' };
}

export const provider = Object.freeze({ id, capabilities: capabilitiesOf(id), resolve, validate, send });
export default provider;