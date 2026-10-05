#!/usr/bin/env node
// Bundle the UI client entry to dist/client.js and mirror it to package-root
// client.js for host asset discovery (05-HOST-CLI.md). React stays external.
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const entry = join(root, 'src', 'ui', 'entry.mjs');

if (!existsSync(entry)) {
  console.error('build: src/ui/entry.mjs is not implemented yet');
  process.exit(1);
}

let esbuild;
try {
  esbuild = await import('esbuild');
} catch {
  console.error('build: esbuild devDependency is required (npm install)');
  process.exit(1);
}

mkdirSync(join(root, 'dist'), { recursive: true });

await esbuild.build({
  entryPoints: [entry],
  outfile: join(root, 'dist', 'client.js'),
  bundle: true,
  format: 'iife',
  globalName: 'DshNotifierClient',
  platform: 'browser',
  target: 'es2020',
  external: ['react', 'react-dom'],
  logLevel: 'info',
});

const built = join(root, 'dist', 'client.js');
const mirror = join(root, 'client.js');
copyFileSync(built, mirror);

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
if (sha(built) !== sha(mirror)) {
  console.error('build: dist/client.js and client.js are not byte-identical');
  process.exit(1);
}
writeFileSync(join(root, 'dist', '.buildinfo.json'), JSON.stringify({ sha256: sha(built) }, null, 2));
console.log('build: dist/client.js + client.js written');