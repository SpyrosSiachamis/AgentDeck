#!/usr/bin/env node
/** Bundles the browser client into dist/web. No CDN assets: the CSP forbids them. */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateIcons } from './generate-icons.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src/web');
const out = path.join(root, 'dist/web');

const watch = process.argv.includes('--watch');

await fs.mkdir(out, { recursive: true });

// The service worker is deliberately not bundled: it must sit at the site root
// to claim the whole scope, and it has no imports to resolve.
const STATIC_FILES = ['index.html', 'styles.css', 'sw.js', 'manifest.webmanifest'];

async function copyStatic() {
  for (const file of STATIC_FILES) {
    await fs.copyFile(path.join(src, file), path.join(out, file));
  }
}

await copyStatic();
// Home Screen and notification icons; rasterised here rather than committed.
await generateIcons(path.join(out, 'icons'));

const options = {
  entryPoints: [path.join(src, 'app.ts')],
  outfile: path.join(out, 'app.js'),
  bundle: true,
  format: 'esm',
  target: ['safari16', 'chrome110'],
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

if (watch) {
  const ctx = await (await import('esbuild')).context(options);
  await ctx.watch();
  const { watch: fsWatch } = await import('node:fs');
  for (const file of STATIC_FILES) {
    fsWatch(path.join(src, file), () => void copyStatic());
  }
  console.log('web client: watching for changes');
} else {
  await build(options);
}
