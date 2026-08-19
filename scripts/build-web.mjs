#!/usr/bin/env node
/** Bundles the browser client into dist/web. No CDN assets: the CSP forbids them. */
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src/web');
const out = path.join(root, 'dist/web');

const watch = process.argv.includes('--watch');

await fs.mkdir(out, { recursive: true });

async function copyStatic() {
  for (const file of ['index.html', 'styles.css']) {
    await fs.copyFile(path.join(src, file), path.join(out, file));
  }
}

await copyStatic();

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
  for (const file of ['index.html', 'styles.css']) {
    fsWatch(path.join(src, file), () => void copyStatic());
  }
  console.log('web client: watching for changes');
} else {
  await build(options);
}
