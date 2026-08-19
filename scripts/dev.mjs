#!/usr/bin/env node
/** Dev runner: rebuild on change, restart the server, keep the web bundle fresh. */
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, LOG_PRETTY: process.env.LOG_PRETTY ?? 'true', LOG_LEVEL: process.env.LOG_LEVEL ?? 'debug' };

let server = null;
let rebuilding = false;
let pending = false;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function rebuild() {
  if (rebuilding) {
    pending = true;
    return;
  }
  rebuilding = true;
  try {
    await run('npx', ['tsc', '-p', 'tsconfig.json']);
    await run('node', ['scripts/build-web.mjs']);
    restart();
  } catch (err) {
    console.error(`build failed: ${err.message}`);
  } finally {
    rebuilding = false;
    if (pending) {
      pending = false;
      void rebuild();
    }
  }
}

function restart() {
  if (server) {
    server.kill('SIGTERM');
    server = null;
  }
  server = spawn('node', ['dist/server/index.js'], { cwd: root, stdio: 'inherit', env });
}

await rebuild();

for (const dir of ['src/server', 'src/web']) {
  watch(path.join(root, dir), { recursive: true }, (_event, file) => {
    if (file && /\.(ts|css|html)$/.test(file)) void rebuild();
  });
}

process.on('SIGINT', () => {
  server?.kill('SIGTERM');
  process.exit(0);
});
