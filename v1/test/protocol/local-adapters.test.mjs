// T24 protocol tests for the local adapters: bell (terminal BEL) and desktop
// (osascript / notify-send / PowerShell BurntToast). The command builders are
// pure, so every platform's exact argv is asserted here. Injection-safety is a
// property of argv (never shell:true), so hostile metacharacters must stay inert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import bell from '../../src/providers/bell/index.mjs';
import desktop, { buildDesktopCommand } from '../../src/providers/desktop/index.mjs';

const msg = (over = {}) => ({ title: 'Title', content: 'Body', level: 'active', ...over });

function fakeChild(code, stderrText = '') {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  process.nextTick(() => {
    if (stderrText !== '') child.stderr.emit('data', stderrText);
    child.emit('close', code);
  });
  return child;
}

function missingChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  process.nextTick(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
  return child;
}

// ---------------------------------------------------------------------------
// bell
// ---------------------------------------------------------------------------
test('bell: one BEL per ring, in a single write; count clamps to 1..5', async () => {
  const chunks = [];
  const result = await bell.send({ config: { count: 3 }, message: msg(), local: { write: (c) => chunks.push(c) } });
  assert.deepEqual(result, { status: 'accepted' });
  assert.equal(chunks.length, 1, 'rings are coalesced into one write');
  assert.equal(chunks[0], '\x07\x07\x07');
});

test('bell: resolve parses strings and clamps out-of-range values', () => {
  assert.deepEqual(bell.resolve({ count: '4' }), { count: 4 });
  assert.deepEqual(bell.resolve({ count: 0 }), { count: 1 });
  assert.deepEqual(bell.resolve({ count: 99 }), { count: 5 });
  assert.deepEqual(bell.resolve({}), { count: 1 });
});

test('bell: silent never rings and a closed stdout is not fatal', async () => {
  let wrote = null;
  await bell.send({ config: {}, message: msg({ silent: true }), local: { write: (c) => { wrote = c; } } });
  assert.equal(wrote, null, 'a silent message writes nothing');
  await assert.doesNotReject(bell.send({ config: {}, message: msg(), local: { write: () => { throw new Error('EPIPE'); } } }));
});

// ---------------------------------------------------------------------------
// desktop: pure command builders
// ---------------------------------------------------------------------------
test('desktop: macOS builds osascript, escaping quotes and sounding only when timeSensitive', () => {
  const quiet = buildDesktopCommand('darwin', { sound: 'auto' }, msg({ title: 'A "quote"', content: 'Body' }));
  assert.equal(quiet.file, 'osascript');
  assert.equal(quiet.args[0], '-e');
  assert.match(quiet.args[1], /display notification "Body" with title "A \\"quote\\""/);
  assert.doesNotMatch(quiet.args[1], /sound name/);

  const loud = buildDesktopCommand('darwin', { sound: 'auto' }, msg({ level: 'timeSensitive' }));
  assert.match(loud.args[1], /sound name "Ping"/);
});

test('desktop: linux builds notify-send argv with urgency and a -- separator', () => {
  const cmd = buildDesktopCommand('linux', { sound: 'auto' }, msg({ level: 'timeSensitive', title: 'T', content: 'C' }));
  assert.equal(cmd.file, 'notify-send');
  assert.deepEqual(cmd.args, ['-a', 'dsh-notifier', '-u', 'critical', '--', 'T', 'C']);

  const passive = buildDesktopCommand('linux', { sound: 'auto' }, msg({ level: 'passive' }));
  assert.deepEqual(passive.args, ['-a', 'dsh-notifier', '-u', 'low', '--', 'Title', 'Body']);
});

test('desktop: windows needs BurntToast and builds a single -Command argv', () => {
  const missing = buildDesktopCommand('win32', { sound: 'auto' }, msg(), false);
  assert.equal(missing.unsupported, 'burnttoast');
  assert.match(missing.hint, /BurntToast/);

  const cmd = buildDesktopCommand('win32', { sound: 'auto' }, msg({ title: "O'Brien", content: 'C' }), true);
  assert.equal(cmd.file, 'powershell.exe');
  assert.deepEqual(cmd.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.match(cmd.args[3], /New-BurntToastNotification -Text @\('O''Brien','C'\)/);
  assert.match(cmd.args[3], /-SuppressSound/, 'active level defaults to no sound on Windows');
});

test('desktop: hostile metacharacters stay inert because the command is always argv', () => {
  const cmd = buildDesktopCommand('linux', { sound: 'auto' }, msg({ title: '; rm -rf /', content: '$(whoami) `id`' }));
  assert.deepEqual(cmd.args, ['-a', 'dsh-notifier', '-u', 'normal', '--', '; rm -rf /', '$(whoami) `id`']);
});

test('desktop: silent short-circuits and an unsupported platform fails closed', () => {
  assert.deepEqual(buildDesktopCommand('darwin', { sound: 'auto' }, msg({ silent: true })), { unsupported: 'silent' });
  const other = buildDesktopCommand('freebsd', { sound: 'auto' }, msg());
  assert.match(other.unsupported, /macOS\/Linux\/Windows/);
});

// ---------------------------------------------------------------------------
// desktop: spawn outcome mapping
// ---------------------------------------------------------------------------
test('desktop: a silent message never spawns', async () => {
  let spawned = false;
  const local = { platform: 'linux', spawn: () => { spawned = true; return fakeChild(0); } };
  const result = await desktop.send({ config: {}, message: msg({ silent: true }), local });
  assert.deepEqual(result, { status: 'accepted' });
  assert.equal(spawned, false);
});

test('desktop: a successful command resolves to accepted', async () => {
  const result = await desktop.send({ config: {}, message: msg(), local: { platform: 'linux', spawn: () => fakeChild(0) } });
  assert.deepEqual(result, { status: 'accepted' });
});

test('desktop: non-zero exit is API_ERROR; a missing binary is NOT_CONFIGURED', async () => {
  await assert.rejects(desktop.send({ config: {}, message: msg(), local: { platform: 'linux', spawn: () => fakeChild(3, 'boom') } }),
    (e) => e.code === 'API_ERROR' && /退出码 3/.test(e.message) && /boom/.test(e.message));
  await assert.rejects(desktop.send({ config: {}, message: msg(), local: { platform: 'linux', spawn: () => missingChild() } }),
    (e) => e.code === 'NOT_CONFIGURED' && /缺少 notify-send/.test(e.message));
});