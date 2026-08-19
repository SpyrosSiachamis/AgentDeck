import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fsp from 'node:fs/promises';

import { WorkspaceRegistry, WorkspaceError } from '../dist/server/workspaces.js';
import { buildChildEnv } from '../dist/server/adapters/env.js';
import { createLogger } from '../dist/server/logger.js';
import { buildHarness, makeTempDir } from './helpers.mjs';

const log = createLogger({ level: 'fatal', pretty: false });

test('registry rejects unknown, disabled and path-shaped workspace ids', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  assert.equal(h.workspaces.require('repo').id, 'repo');

  for (const bad of [
    'nope',
    '../repo',
    '/etc',
    '/Users/someone/other-repo',
    '..',
    'repo/../off',
    './repo',
    '',
    null,
    undefined,
    42,
    { id: 'repo' },
  ]) {
    assert.throws(
      () => h.workspaces.require(bad),
      (err) => err instanceof WorkspaceError && err.code === 'unknown_workspace',
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }

  assert.throws(
    () => h.workspaces.require('off'),
    (err) => err instanceof WorkspaceError && err.code === 'workspace_disabled',
  );
});

test('resolveInside blocks traversal, absolute paths and escaping symlinks', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());
  const ws = h.workspaces.require('repo');

  assert.equal(h.workspaces.resolveInside(ws, 'README.md'), path.join(ws.path, 'README.md'));
  assert.equal(h.workspaces.resolveInside(ws, 'nested/new-file.txt'), path.join(ws.path, 'nested/new-file.txt'));

  const attacks = [
    '../unregistered/secret.txt',
    '../../etc/passwd',
    '/etc/passwd',
    '~/.ssh/id_rsa',
    'a/../../../etc/hosts',
    './../../',
    'x\0.txt',
  ];
  for (const attack of attacks) {
    assert.throws(() => h.workspaces.resolveInside(ws, attack), WorkspaceError, `expected rejection for ${attack}`);
  }

  // A symlink inside the workspace pointing outside must also be rejected.
  await fsp.symlink(h.other, path.join(ws.path, 'escape-link'));
  assert.throws(() => h.workspaces.resolveInside(ws, 'escape-link/secret.txt'), WorkspaceError);
});

test('registry refuses protected directories and relative paths', async () => {
  const root = await makeTempDir();
  const file = path.join(root, 'workspaces.json');

  await fsp.writeFile(file, JSON.stringify({ workspaces: [{ id: 'home', name: 'Home', path: '~' }] }));
  await assert.rejects(WorkspaceRegistry.load(file, log), /protected directory/);

  await fsp.writeFile(file, JSON.stringify({ workspaces: [{ id: 'rel', name: 'Rel', path: 'relative/path' }] }));
  await assert.rejects(WorkspaceRegistry.load(file, log), /absolute path/);

  await fsp.writeFile(file, JSON.stringify({ workspaces: [{ id: 'Bad Id', name: 'x', path: root }] }));
  await assert.rejects(WorkspaceRegistry.load(file, log), /invalid/i);

  await fsp.writeFile(
    file,
    JSON.stringify({ workspaces: [{ id: 'a', name: 'x', path: root }, { id: 'a', name: 'y', path: root }] }),
  );
  await assert.rejects(WorkspaceRegistry.load(file, log), /Duplicate/);
});

test('child environment excludes secrets and keeps what the CLI needs', () => {
  const env = buildChildEnv({
    PATH: '/usr/bin',
    HOME: '/Users/test',
    ANTHROPIC_API_KEY: 'sk-ant-should-not-leak',
    AWS_SECRET_ACCESS_KEY: 'aws-should-not-leak',
    GITHUB_TOKEN: 'ghp_should_not_leak',
    DATABASE_PASSWORD: 'hunter2',
    MY_PRIVATE_KEY: 'rsa',
    STRIPE_SECRET: 'sk_live',
    ANTIGRAVITY_CONFIG: 'ok',
    AGY_TELEMETRY: '0',
    RANDOM_APP_VAR: 'not forwarded',
  });

  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/Users/test');
  assert.equal(env.ANTIGRAVITY_CONFIG, 'ok');
  assert.equal(env.AGY_TELEMETRY, '0');

  for (const leaked of [
    'ANTHROPIC_API_KEY',
    'AWS_SECRET_ACCESS_KEY',
    'GITHUB_TOKEN',
    'DATABASE_PASSWORD',
    'MY_PRIVATE_KEY',
    'STRIPE_SECRET',
    'RANDOM_APP_VAR',
  ]) {
    assert.equal(env[leaked], undefined, `${leaked} must not reach the CLI process`);
  }

  // Explicit opt-in is the only way through.
  const opted = buildChildEnv({ ANTHROPIC_API_KEY: 'sk-ant' }, { extraAllow: ['ANTHROPIC_API_KEY'] });
  assert.equal(opted.ANTHROPIC_API_KEY, 'sk-ant');
});
