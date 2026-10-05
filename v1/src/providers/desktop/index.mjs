// desktop local provider (04-PROVIDERS.md, reference adapters/desktop.mjs).
// Uses the OS-native notification command: macOS osascript, Linux notify-send,
// Windows PowerShell BurntToast. Injection-safe by construction: always
// spawn(file, argsArray) and never shell:true / string template execution.
import { spawn } from 'node:child_process';
import { ProviderError, str } from '../http.mjs';
import { capabilitiesOf } from '../specs.mjs';

export const id = 'desktop';

const COMMAND_TIMEOUT_MS = 10_000;
const TITLE_MAX = 120;
const BODY_MAX = 500;
const URGENCY_OF = { timeSensitive: 'critical', active: 'normal', passive: 'low' };
const MAC_SOUND = 'Ping';

export function resolve(config = {}) {
  const raw = config.sound;
  if (raw === true) return { sound: 'always' };
  if (raw === false) return { sound: 'never' };
  return { sound: raw === 'always' || raw === 'never' ? raw : 'auto' };
}

export function validate(config = {}) {
  resolve(config);
}

function soundOn(resolved, message) {
  if (resolved?.sound === 'never') return false;
  if (resolved?.sound === 'always') return true;
  return message?.level === 'timeSensitive';
}

/** Flatten control chars: notification banners do not allow raw newlines. */
function flatten(value) {
  return str(value).replace(/[\u0000-\u001f\u007f]+/g, ' ');
}

function clampText(value, max) {
  const text = flatten(value);
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** AppleScript double-quote literal escaping (input already clamped). */
function asq(value) {
  return str(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

/** PowerShell single-quote literal escaping; the whole script is one argv. */
function psq(value) {
  return str(value).replaceAll("'", "''");
}

/**
 * Pure command builder (protocol-test core). No IO: Windows availability probing
 * is done by send() and passed in as `probe`.
 * @returns {{file:string,args:string[]}|{unsupported:string,hint?:string}}
 */
export function buildDesktopCommand(platform, resolved, message, probe = null) {
  if (message?.silent === true) return { unsupported: 'silent' };
  const title = clampText(message?.title, TITLE_MAX);
  const body = clampText(message?.content, BODY_MAX);
  const sound = soundOn(resolved, message);
  if (platform === 'darwin') {
    let script = `display notification "${asq(body)}" with title "${asq(title)}"`;
    if (sound) script += ` sound name "${MAC_SOUND}"`;
    return { file: 'osascript', args: ['-e', script] };
  }
  if (platform === 'linux') {
    return {
      file: 'notify-send',
      args: ['-a', 'dsh-notifier', '-u', URGENCY_OF[message?.level] ?? 'normal', '--', title, body],
    };
  }
  if (platform === 'win32') {
    if (probe !== true) {
      return {
        unsupported: 'burnttoast',
        hint: 'Windows 桌面通知需要 BurntToast 模块：以管理员身份运行 PowerShell 执行 Install-Module -Name BurntToast -Scope CurrentUser，或改用 bell / 浏览器通知（管理台「通知」页）',
      };
    }
    const suppress = sound ? '' : ' -SuppressSound';
    const script = `New-BurntToastNotification -Text @('${psq(title)}','${psq(body)}')${suppress}`;
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] };
  }
  return { unsupported: `平台 ${String(platform)} 无原生桌面通知支持（可用：macOS/Linux/Windows）` };
}

function runCommand(spawnImpl, file, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawnImpl(file, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      rejectPromise(new ProviderError('NETWORK_ERROR', `桌面通知命令启动失败: ${error?.message ?? String(error)}`));
      return;
    }
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* already exited */ }
      rejectPromise(new ProviderError('TIMEOUT', `桌面通知命令超时（${COMMAND_TIMEOUT_MS}ms）：${file}`));
    }, COMMAND_TIMEOUT_MS);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    child.on('error', (error) => {
      const notFound = error?.code === 'ENOENT';
      finish(rejectPromise, notFound
        ? new ProviderError('NOT_CONFIGURED', `系统缺少 ${file}——Linux 需桌面环境（libnotify），无桌面场景请改用 bell 渠道`)
        : new ProviderError('NETWORK_ERROR', `桌面通知命令执行失败: ${error?.message ?? String(error)}`));
    });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => {
      if (code === 0) finish(resolvePromise, { code });
      else finish(rejectPromise, new ProviderError('API_ERROR', `桌面通知命令退出码 ${code}${stderr !== '' ? `: ${stderr.slice(0, 200)}` : ''}`));
    });
  });
}

export async function send({ config, message, local }) {
  const resolved = resolve(config ?? {});
  const platform = typeof local?.platform === 'string' ? local.platform : process.platform;
  const spawnImpl = typeof local?.spawn === 'function' ? local.spawn : spawn;
  let probe = null;
  if (platform === 'win32') {
    probe = await runCommand(
      spawnImpl,
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'if (Get-Module -ListAvailable BurntToast) { exit 0 } else { exit 1 }'],
    ).then(() => true, () => false);
  }
  const command = buildDesktopCommand(platform, resolved, message, probe);
  if (command.unsupported === 'silent') return { status: 'accepted' };
  if (command.unsupported !== undefined) {
    throw new ProviderError('NOT_CONFIGURED', command.hint ?? command.unsupported);
  }
  await runCommand(spawnImpl, command.file, command.args);
  return { status: 'accepted' };
}

export const provider = Object.freeze({ id, capabilities: capabilitiesOf(id), resolve, validate, send });
export default provider;