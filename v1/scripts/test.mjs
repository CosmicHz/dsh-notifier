#!/usr/bin/env node
// Explicitly enumerate test directories and run node --test over real files.
// A category with zero files fails: empty PASS is forbidden (07-ACCEPTANCE.md).
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const valid = new Set(['unit', 'integration', 'protocol']);
const requested = process.argv.slice(2);
const categories = requested.length ? requested : ['unit', 'integration', 'protocol'];

for (const c of categories) {
  if (!valid.has(c)) {
    console.error(`unknown test category: ${c} (expected unit|integration|protocol)`);
    process.exit(2);
  }
}

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
    else if (name.endsWith('.test.mjs')) out.push(full);
  }
  return out;
}

const files = [];
for (const c of categories) walk(join(root, 'test', c), files);
files.sort();

if (files.length === 0) {
  console.error(`no test files found for: ${categories.join(', ')}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root });
process.exit(result.status ?? 1);