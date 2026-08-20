import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { buildHarness } from './helpers.mjs';
import { SettingsStore } from '../dist/server/settings.js';
import { parseModelList } from '../dist/server/adapters/registry.js';
import { createLogger } from '../dist/server/logger.js';

const silent = createLogger({ level: 'silent', pretty: false });

test('settings start empty and report what each field falls back to', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const res = await h.app.inject({ method: 'GET', url: '/api/settings' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.settings.models, {});
  // The UI labels the empty state with these, so they must be the real defaults.
  assert.equal(body.defaults.models['claude-code'], 'fake-model-1');
  assert.equal(body.defaults.notifications.turnFinished, true);
});

test('a default model is stored and used by the next session', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const saved = await h.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { models: { 'claude-code': 'claude-opus-5' } },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().settings.models['claude-code'], 'claude-opus-5');

  const session = await h.sessions.create({ workspaceId: 'repo', adapterId: 'claude-code', createdBy: null });
  assert.equal(session.summary().model, 'claude-opus-5', 'the preference beat the environment default');

  // Clearing it hands the choice back to the environment.
  await h.app.inject({ method: 'PUT', url: '/api/settings', payload: { models: { 'claude-code': '' } } });
  const after = await h.sessions.create({ workspaceId: 'repo', adapterId: 'claude-code', createdBy: null });
  assert.equal(after.summary().model, 'fake-model-1');
});

test('a workspace that pins a model still wins over the preference', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  await fsp.writeFile(
    h.config.workspacesFile,
    JSON.stringify({
      workspaces: [{ id: 'repo', name: 'Test Repo', path: h.repo, enabled: true, models: { 'claude-code': 'pinned-model' } }],
    }),
  );
  const reloaded = await buildHarness({ WORKSPACES_FILE: h.config.workspacesFile });
  t.after(() => reloaded.close());

  await reloaded.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { models: { 'claude-code': 'preference-model' } },
  });
  const session = await reloaded.sessions.create({ workspaceId: 'repo', adapterId: 'claude-code', createdBy: null });
  assert.equal(session.summary().model, 'pinned-model', 'the more specific setting wins');
});

test('nonsense is refused rather than handed to a CLI', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  // A model id becomes an argv element; keep it to a boring character set.
  const bad = await h.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { models: { 'claude-code': 'model; rm -rf /' } },
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'invalid_settings');

  const unknownAgent = await h.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { models: { 'not-an-agent': 'x' } },
  });
  assert.equal(unknownAgent.statusCode, 400);

  const unknownField = await h.app.inject({
    method: 'PUT',
    url: '/api/settings',
    payload: { somethingElse: true },
  });
  assert.equal(unknownField.statusCode, 400);

  assert.deepEqual((await h.app.inject({ method: 'GET', url: '/api/settings' })).json().settings.models, {});
});

test('the turn-finished notification can be turned off, and survives a restart', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  assert.equal(h.settings.notifyTurnFinished(), true, 'defaults to the environment');

  await h.app.inject({ method: 'PUT', url: '/api/settings', payload: { notifications: { turnFinished: false } } });
  assert.equal(h.settings.notifyTurnFinished(), false);

  const reloaded = new SettingsStore(h.config, silent);
  await reloaded.init();
  assert.equal(reloaded.notifyTurnFinished(), false, 'the choice is on disk');

  const stored = JSON.parse(await fsp.readFile(path.join(h.config.stateDir, 'settings.json'), 'utf8'));
  assert.equal(stored.notifications.turnFinished, false);
});

test('a corrupt settings file falls back to the environment instead of failing', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  await fsp.writeFile(path.join(h.config.stateDir, 'settings.json'), '{ not json');
  const store = new SettingsStore(h.config, silent);
  await store.init();
  assert.deepEqual(store.get().models, {});
  assert.equal(store.notifyTurnFinished(), true);
});

test('settings changes reach the other devices over the socket', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const seen = [];
  h.hub.broadcastSettings = (settings) => seen.push(settings);
  await h.app.inject({ method: 'PUT', url: '/api/settings', payload: { notifications: { turnFinished: false } } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].notifications.turnFinished, false);
});

// -------------------------------------------------------------- model listing

test('a CLI model list is parsed, and its chatter ignored', () => {
  const models = parseModelList(
    [
      'Fetching available models...',
      'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
      'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
      '',
      'gemini-3.7-flash-high\tduplicate is dropped',
      'has spaces\tnot a usable id',
    ].join('\n'),
  );

  assert.deepEqual(models, [
    { id: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
  ]);
});

test('an agent that cannot list its models says so', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const res = await h.app.inject({ method: 'GET', url: '/api/agents/claude-code/models' });
  assert.equal(res.statusCode, 404);
  assert.match(res.json().message, /cannot list its models/);
});
