#!/usr/bin/env node
// Static consistency gate. Incremental: validates whatever exists in src/,
// and cross-checks it against the frozen spec when the relevant module lands.
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const specDir = resolve(root, '..', 'docs', 'developer', 'v1-flash-v3', 'spec');
const problems = [];

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.mjs') || name.endsWith('.js')) out.push(full);
  }
  return out;
}

const srcFiles = walk(join(root, 'src'), []);

// 1. Every source file must parse.
for (const file of srcFiles) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) problems.push(`syntax: ${relative(root, file)}: ${r.stderr.trim()}`);
}

// 2. No legacy/reference runtime imports.
const forbidden = /(\.\.\/){2,}src\b|reference\/|legacy[-\w]*\.mjs/;
for (const file of srcFiles) {
  const text = readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (forbidden.test(line) && /\bimport\b|\brequire\s*\(/.test(line)) {
      problems.push(`legacy import: ${relative(root, file)}: ${line.trim()}`);
    }
  }
}

async function exists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

const specChannels = JSON.parse(readFileSync(join(specDir, 'CHANNELS.json'), 'utf8'));
if (specChannels.length !== 29) problems.push(`spec CHANNELS.json must have 29 entries, got ${specChannels.length}`);

// 3. Descriptor list must match the frozen channel set once implemented.
const descriptorsPath = join(root, 'src', 'domain', 'descriptors.mjs');
if (await exists(descriptorsPath)) {
  const mod = await import(descriptorsPath);
  const list = (mod.channelDescriptors ?? mod.descriptors ?? [])();
  const ids = list.map((c) => c.id).sort();
  const expected = specChannels.map((c) => c.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify(expected)) {
    problems.push(`descriptors channel ids differ from spec: ${ids.join(',')}`);
  }
}

// 4. RPC router must expose exactly the frozen method set once implemented.
const routerPath = join(root, 'src', 'rpc', 'router.mjs');
if (await exists(routerPath)) {
  const spec = JSON.parse(readFileSync(join(specDir, 'RPC-METHODS.json'), 'utf8'));
  const expected = new Set(spec.methods.map((m) => m.name));
  const mod = await import(routerPath);
  if (typeof mod.methodNames === 'function') {
    for (const name of mod.methodNames()) {
      if (!expected.has(name)) problems.push(`rpc method not in spec: ${name}`);
    }
  }
}

// 5. Locale parity once strings exist.
const stringsPath = join(root, 'src', 'ui', 'strings.mjs');
if (await exists(stringsPath)) {
  const mod = await import(stringsPath);
  const dict = mod.default ?? mod.strings;
  if (dict?.zh && dict?.en) {
    const zh = Object.keys(dict.zh).sort().join('|');
    const en = Object.keys(dict.en).sort().join('|');
    if (zh !== en) problems.push('locale key mismatch between zh and en');
  }
}

if (problems.length) {
  console.error('CHECK FAILED:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log(`check passed (${srcFiles.length} source files)`);