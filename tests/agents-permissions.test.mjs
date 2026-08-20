import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHarness, collectEvents, waitFor } from './helpers.mjs';

// ---------------------------------------------------------------- agents

test('both agents are offered, and a session runs on the one that was chosen', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const res = await h.app.inject({ method: 'GET', url: '/api/agents' });
  assert.equal(res.statusCode, 200);
  const { agents, defaultAgent } = res.json();

  const ids = agents.map((a) => a.id);
  assert.deepEqual(ids.sort(), ['antigravity-cli', 'claude-code']);
  assert.equal(defaultAgent, 'claude-code');
  assert.ok(agents.every((a) => a.available), 'both fake binaries resolve on PATH');

  const claude = agents.find((a) => a.id === 'claude-code');
  const agy = agents.find((a) => a.id === 'antigravity-cli');
  assert.equal(claude.supportsPermissionPrompts, true);
  assert.equal(claude.persistentProcess, true);
  assert.equal(agy.supportsPermissionPrompts, false);
  assert.equal(agy.persistentProcess, true);
  assert.equal(agy.displayName, 'Antigravity CLI');
  // The picker needs a path, but never a filesystem path.
  assert.ok(!JSON.stringify(agents).includes(h.repo));

  const sessionAgy = await h.sessions.create({ workspaceId: 'repo', adapterId: 'antigravity-cli', createdBy: null });
  assert.equal(sessionAgy.summary().adapterId, 'antigravity-cli');
  assert.equal(sessionAgy.summary().adapterName, 'Antigravity CLI');

  const sessionClaude = await h.sessions.create({ workspaceId: 'repo', adapterId: 'claude-code', createdBy: null });
  assert.equal(sessionClaude.summary().adapterId, 'claude-code');
  assert.equal(sessionClaude.summary().adapterName, 'Claude Code');

  // Sessions on different agents coexist.
  assert.equal(h.sessions.liveCount, 2);
});

test('unknown or uninstalled agents are refused', async (t) => {
  const h = await buildHarness({ AGY_COMMAND: '/nonexistent/agy-binary' });
  t.after(() => h.close());

  for (const bad of ['nope', '../antigravity-cli', 42, {}]) {
    await assert.rejects(
      () => h.sessions.create({ workspaceId: 'repo', adapterId: bad, createdBy: null }),
      /Unknown agent/,
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }

  // An omitted or empty agent id means "use the default", not "invalid".
  const defaulted = await h.sessions.create({ workspaceId: 'repo', adapterId: '', createdBy: null });
  assert.equal(defaulted.summary().adapterId, 'claude-code');

  await assert.rejects(
    () => h.sessions.create({ workspaceId: 'repo', adapterId: 'antigravity-cli', createdBy: null }),
    /not installed/,
  );

  const res = await h.app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: { workspaceId: 'repo', adapterId: 'antigravity-cli' },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'adapter_unavailable');

  const listed = (await h.app.inject({ method: 'GET', url: '/api/agents' })).json();
  assert.equal(listed.agents.find((a) => a.id === 'antigravity-cli').available, false);
});

// ----------------------------------------------------------- permissions

test('a tool approval can be granted from the client', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const session = await h.sessions.create({ workspaceId: 'repo', createdBy: null });
  const sink = collectEvents(session);
  await waitFor(() => session.summary().state === 'idle');
  assert.equal(session.summary().supportsPermissionPrompts, true);

  await session.instruct('ASK to run something', null);
  const request = await waitFor(
    () => sink.events.find((e) => e.type === 'permission_request'),
    { label: 'permission_request' },
  );

  assert.equal(request.toolName, 'Bash');
  assert.equal(request.command, 'rm -rf ./build');
  assert.match(request.summary, /rm -rf/);

  // The pending request is part of the session summary, so a phone that
  // reconnects mid-request still sees it.
  await waitFor(() => session.summary().pendingPermissions.length === 1, { label: 'pending in summary' });
  assert.equal(session.summary().pendingPermissions[0].requestId, request.requestId);

  await session.respondToPermission(request.requestId, 'allow', 'owner@example.com');

  await waitFor(
    () => sink.events.some((e) => e.type === 'message' && String(e.text).includes('permission granted')),
    { label: 'CLI proceeded after approval' },
  );
  const resolved = sink.events.find((e) => e.type === 'permission_resolved');
  assert.equal(resolved.decision, 'allow');
  assert.equal(resolved.decidedBy, 'owner@example.com');
  assert.equal(session.summary().pendingPermissions.length, 0);
});

test('a tool approval can be denied with a reason the model sees', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const session = await h.sessions.create({ workspaceId: 'repo', createdBy: null });
  const sink = collectEvents(session);
  await waitFor(() => session.summary().state === 'idle');

  await session.instruct('ASK to run something', null);
  const request = await waitFor(() => sink.events.find((e) => e.type === 'permission_request'));

  await session.respondToPermission(request.requestId, 'deny', 'owner@example.com', 'Not on my repo');

  await waitFor(
    () => sink.events.some((e) => e.type === 'message' && String(e.text).includes('Not on my repo')),
    { label: 'the reason reached the model' },
  );
  assert.equal(sink.events.find((e) => e.type === 'permission_resolved').decision, 'deny');
});

test('an unanswered approval is denied automatically instead of hanging', async (t) => {
  const h = await buildHarness({ PERMISSION_TIMEOUT_MS: '1500' });
  t.after(() => h.close());

  const session = await h.sessions.create({ workspaceId: 'repo', createdBy: null });
  const sink = collectEvents(session);
  await waitFor(() => session.summary().state === 'idle');

  await session.instruct('ASK to run something', null);
  await waitFor(() => sink.events.some((e) => e.type === 'permission_request'));

  await waitFor(() => sink.events.some((e) => e.type === 'permission_resolved'), {
    label: 'auto-denied',
    timeout: 12000,
  });
  const resolved = sink.events.find((e) => e.type === 'permission_resolved');
  assert.equal(resolved.decision, 'deny');
  assert.equal(resolved.decidedBy, null);
  assert.match(resolved.reason, /in time/);
  assert.equal(session.summary().pendingPermissions.length, 0);
});

test('answering an unknown or stale approval is rejected', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const session = await h.sessions.create({ workspaceId: 'repo', createdBy: null });
  const sink = collectEvents(session);
  await waitFor(() => session.summary().state === 'idle');

  await assert.rejects(() => session.respondToPermission('made-up', 'allow', 'tester'), /no pending approval/);

  await session.instruct('ASK to run something', null);
  const request = await waitFor(() => sink.events.find((e) => e.type === 'permission_request'));
  await session.respondToPermission(request.requestId, 'allow', 'tester');
  // Answering the same request twice must not reach the CLI again.
  await assert.rejects(
    () => session.respondToPermission(request.requestId, 'deny', 'tester'),
    /no pending approval/,
  );

  const res = await h.app.inject({
    method: 'POST',
    url: `/api/sessions/${session.id}/permissions/${request.requestId}`,
    payload: { decision: 'allow' },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'permission_not_found');
});

test('approvals travel over the websocket', async (t) => {
  const h = await buildHarness();
  const port = await h.listen();
  t.after(() => h.close());

  const { WebSocket } = await import('ws');
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages = [];
  const events = [];
  socket.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    messages.push(msg);
    if (msg.t === 'events') events.push(...msg.events);
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  t.after(() => socket.close());

  await waitFor(() => messages.find((m) => m.t === 'welcome'), { label: 'welcome' });
  const welcome = messages.find((m) => m.t === 'welcome');
  assert.ok(welcome.agents.some((a) => a.id === 'antigravity-cli'), 'the picker is fed from the welcome frame');

  const created = await h.app.inject({ method: 'POST', url: '/api/sessions', payload: { workspaceId: 'repo' } });
  const sessionId = created.json().session.id;
  socket.send(JSON.stringify({ t: 'subscribe', sessionId, sinceSeq: 0 }));
  await waitFor(() => messages.find((m) => m.t === 'subscribed'));

  socket.send(JSON.stringify({ t: 'instruct', sessionId, text: 'ASK to run something' }));
  const request = await waitFor(() => events.find((e) => e.type === 'permission_request'), {
    label: 'permission_request over ws',
  });

  socket.send(JSON.stringify({ t: 'permission', sessionId, requestId: request.requestId, decision: 'allow' }));
  await waitFor(() => events.some((e) => e.type === 'permission_resolved'), { label: 'resolved over ws' });
  await waitFor(
    () => events.some((e) => e.type === 'message' && String(e.text).includes('permission granted')),
    { label: 'tool ran after approval' },
  );

  // A malformed decision is rejected by schema validation.
  socket.send(JSON.stringify({ t: 'permission', sessionId, requestId: 'x', decision: 'maybe' }));
  await waitFor(() => messages.some((m) => m.t === 'error' && m.code === 'invalid_message'), {
    label: 'invalid decision rejected',
  });
});

test('workspace model for default agent is not applied to a different agent unless configured', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  // A workspace with a model for the default agent (claude-code)
  const wsWithClaude = {
    id: 'claude-ws',
    name: 'Claude WS',
    path: h.repo,
    enabled: true,
    model: 'claude-sonnet-5',
    isGitRepo: true,
  };
  h.workspaces.byId.set('claude-ws', wsWithClaude);

  // When starting claude-code in that workspace, it gets claude-sonnet-5
  const claudeSession = await h.sessions.create({ workspaceId: 'claude-ws', adapterId: 'claude-code', createdBy: null });
  assert.equal(claudeSession.summary().model, 'claude-sonnet-5');

  // When starting antigravity-cli in that workspace, it does not inherit claude-sonnet-5
  const agySession = await h.sessions.create({ workspaceId: 'claude-ws', adapterId: 'antigravity-cli', createdBy: null });
  assert.equal(agySession.summary().model, 'fake-agy-1');

  // When models is configured per-agent on the workspace, each gets its respective model
  const wsWithBoth = {
    id: 'both-ws',
    name: 'Both WS',
    path: h.repo,
    enabled: true,
    models: {
      'claude-code': 'claude-opus-4',
      'antigravity-cli': 'gemini-3.7-flash',
    },
    isGitRepo: true,
  };
  h.workspaces.byId.set('both-ws', wsWithBoth);

  const claudeBoth = await h.sessions.create({ workspaceId: 'both-ws', adapterId: 'claude-code', createdBy: null });
  assert.equal(claudeBoth.summary().model, 'claude-opus-4');

  const agyBoth = await h.sessions.create({ workspaceId: 'both-ws', adapterId: 'antigravity-cli', createdBy: null });
  assert.equal(agyBoth.summary().model, 'gemini-3.7-flash');
});

test('CLI stdout JSON errors are captured and reported in error event and exit detail', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const session = await h.sessions.create({ workspaceId: 'repo', adapterId: 'antigravity-cli', createdBy: null });
  const sink = collectEvents(session);
  await waitFor(() => sink.types().includes('session_started'));

  await session.instruct('FAIL_JSON please stop', null);
  await waitFor(() => session.summary().state === 'crashed', { label: 'crashed after stdout error' });

  const errorEvents = sink.events.filter((e) => e.type === 'error');
  assert.ok(errorEvents.length > 0, 'error events were emitted');
  assert.ok(
    errorEvents.some((e) => String(e.message).includes('invalid model selection') || String(e.detail).includes('invalid model selection')),
    'the error message from CLI stdout JSON is captured in the error events',
  );
});
