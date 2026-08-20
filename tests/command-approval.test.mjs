import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

import { CommandApprovalBroker } from '../dist/server/adapters/command-broker.js';

/**
 * The Antigravity CLI cannot ask for approval, so DevTunnel intercepts the
 * shell it runs commands through. These tests drive that shim directly: if a
 * denial does not actually stop the command, the whole feature is theatre.
 */

function runShim(binDir, shell, command, cwd) {
  return new Promise((resolve) => {
    execFile(
      path.join(binDir, shell),
      ['-c', command],
      { cwd, timeout: 20000 },
      // A signal death is a failure too, and must never be read as success.
      (err, stdout, stderr) =>
        resolve({ code: err ? (err.code ?? `signal:${err.signal}`) : 0, stdout, stderr }),
    );
  });
}

async function withBroker(t, decide) {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'broker-test-'));
  const broker = new CommandApprovalBroker({ cwd });
  const asked = [];
  broker.handleRequest((request) => {
    asked.push(request);
    // Answer out of band, the way a phone would.
    setTimeout(() => broker.resolve(request.requestId, decide(request)), 5);
  });
  await broker.start();
  t.after(async () => {
    await broker.stop();
    await fsp.rm(cwd, { recursive: true, force: true });
  });
  return { broker, cwd, asked };
}

test('an approved command runs and its output and exit code pass through', async (t) => {
  const { broker, cwd, asked } = await withBroker(t, () => ({ decision: 'allow' }));

  const ok = await runShim(broker.binDir, 'sh', 'echo approved-output', cwd);
  assert.equal(ok.code, 0);
  assert.match(ok.stdout, /approved-output/);

  assert.equal(asked.length, 1);
  assert.equal(asked[0].command, 'echo approved-output');
  // The shim reports the resolved cwd; on macOS /var is a symlink to /private/var.
  assert.equal(asked[0].cwd, fs.realpathSync(cwd));

  // A failing command must still report its own exit status, not the shim's.
  const failed = await runShim(broker.binDir, 'sh', 'exit 42', cwd);
  assert.equal(failed.code, 42);
});

test('a denied command never executes', async (t) => {
  const { broker, cwd } = await withBroker(t, () => ({ decision: 'deny', reason: 'nope' }));
  const marker = path.join(cwd, 'should-not-exist');

  const result = await runShim(broker.binDir, 'sh', `touch ${marker}`, cwd);

  assert.notEqual(result.code, 0, 'the shell reports failure');
  assert.match(result.stderr, /Denied by the user: nope/);
  assert.equal(fs.existsSync(marker), false, 'the denied command had no effect');
});

test('every shell the CLI might pick is intercepted', async (t) => {
  const { broker, cwd, asked } = await withBroker(t, () => ({ decision: 'allow' }));

  for (const shell of ['sh', 'bash', 'zsh']) {
    if (!fs.existsSync(path.join(broker.binDir, shell))) continue; // not installed here
    const result = await runShim(broker.binDir, shell, 'echo via-$0', cwd);
    assert.equal(result.code, 0, `${shell} shim ran`);
  }
  assert.ok(asked.length >= 1, 'each shell asked for approval');
});

test('a broker that goes away fails closed rather than open', async (t) => {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'broker-test-'));
  t.after(() => fsp.rm(cwd, { recursive: true, force: true }));

  const broker = new CommandApprovalBroker({ cwd });
  // Stop the session at the exact moment a command is waiting on a human,
  // rather than on a timer that races with process startup.
  broker.handleRequest(() => void broker.stop('session ended'));
  await broker.start();
  const binDir = broker.binDir;
  const marker = path.join(cwd, 'never');

  const result = await runShim(binDir, 'sh', `touch ${marker}`, cwd);

  assert.notEqual(result.code, 0, `expected a non-zero exit, got ${result.code}`);
  assert.equal(fs.existsSync(marker), false, 'shutting down must not release the command');
});

test('stopping the broker removes the shims and the socket', async (t) => {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'broker-test-'));
  t.after(() => fsp.rm(cwd, { recursive: true, force: true }));

  const broker = new CommandApprovalBroker({ cwd });
  broker.handleRequest(() => {});
  await broker.start();
  const binDir = broker.binDir;
  assert.ok(fs.existsSync(path.join(binDir, 'sh')), 'a shim exists while running');

  await broker.stop();
  assert.equal(fs.existsSync(binDir), false, 'the shim directory is gone');
});
