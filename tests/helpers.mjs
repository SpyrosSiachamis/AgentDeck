import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../dist/server/config.js';
import { createLogger } from '../dist/server/logger.js';
import { WorkspaceRegistry } from '../dist/server/workspaces.js';
import { SessionStore } from '../dist/server/sessions/store.js';
import { SessionManager } from '../dist/server/sessions/manager.js';
import { buildServer } from '../dist/server/http.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_CLI = path.join(here, 'fake-cli.mjs');

export async function makeTempDir(prefix = 'terminal-agent-test-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** A throwaway git repo with one commit and one dirty file. */
export async function makeGitRepo(root) {
  const dir = path.join(root, 'repo');
  await fsp.mkdir(dir, { recursive: true });
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' },
      stdio: 'pipe',
    });
  git('init', '-q', '-b', 'main');
  await fsp.writeFile(path.join(dir, 'README.md'), '# hello\n');
  git('add', '.');
  git('commit', '-qm', 'initial');
  await fsp.writeFile(path.join(dir, 'README.md'), '# hello\nchanged\n');
  await fsp.writeFile(path.join(dir, 'untracked.txt'), 'new file\n');
  return dir;
}

export async function buildHarness(overrides = {}) {
  const root = await makeTempDir();
  const repo = await makeGitRepo(root);
  const other = path.join(root, 'unregistered');
  await fsp.mkdir(other, { recursive: true });
  await fsp.writeFile(path.join(other, 'secret.txt'), 'top secret\n');

  const workspacesFile = path.join(root, 'workspaces.json');
  await fsp.writeFile(
    workspacesFile,
    JSON.stringify({
      workspaces: [
        { id: 'repo', name: 'Test Repo', path: repo, enabled: true },
        { id: 'off', name: 'Disabled', path: other, enabled: false },
      ],
    }),
  );

  const config = loadConfig({
    HOST: '127.0.0.1',
    PORT: '0',
    WORKSPACES_FILE: workspacesFile,
    STATE_DIR: path.join(root, 'state'),
    LOG_LEVEL: 'silent',
    CLI_COMMAND: FAKE_CLI,
    CLI_ADAPTER: 'claude-code',
    CLI_MODEL: 'fake-model-1',
    ...overrides,
  });

  const log = createLogger({ level: 'fatal', pretty: false });
  const workspaces = await WorkspaceRegistry.load(config.workspacesFile, log);
  const store = new SessionStore(config.stateDir, log);
  const sessions = new SessionManager(config, log, workspaces, store);
  await sessions.init();
  const { app, hub } = await buildServer({ config, log, workspaces, sessions });

  return {
    root,
    repo,
    other,
    config,
    log,
    workspaces,
    store,
    sessions,
    app,
    hub,
    async listen() {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      return typeof address === 'object' && address ? address.port : 0;
    },
    async close() {
      await hub.shutdown();
      await app.close();
      await sessions.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function waitFor(predicate, { timeout = 8000, interval = 25, label = 'condition' } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let result;
      try {
        result = predicate();
      } catch (err) {
        reject(err);
        return;
      }
      if (result) {
        resolve(result);
        return;
      }
      if (Date.now() - started > timeout) {
        reject(new Error(`timed out waiting for ${label}`));
        return;
      }
      setTimeout(tick, interval);
    };
    tick();
  });
}

/** Collect every event a session emits, for assertions. */
export function collectEvents(session) {
  const events = [];
  const unsubscribe = session.subscribe((batch) => events.push(...batch));
  return { events, unsubscribe, types: () => events.map((e) => e.type) };
}
