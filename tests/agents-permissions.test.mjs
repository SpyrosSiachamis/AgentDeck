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
  assert.deepEqual(ids.sort(), ['claude-code', 'gemini-cli']);
  assert.equal(defaultAgent, 'claude-code');
  assert.ok(agents.every((a) => a.available), 'both fake binaries resolve on PATH');

  const claude = agents.find((a) => a.id === 'claude-code');
  const gemini = agents.find((a) => a.id === 'gemini-cli');
  assert.equal(claude.supportsPermissionPrompts, true);
  assert.equal(gemini.supportsPermissionPrompts, false);
  assert.equal(claude.persistentProcess, true);
  assert.equal(gemini.persistentProcess, false);
  // The picker needs a path, but never a filesystem path.
  assert.ok(!JSON.stringify(agents).includes(h.repo));

  const gem = await h.sessions.create({ workspaceId: 'repo', adapterId: 'gemini-cli', createdBy: null });
  assert.equal(gem.summary().adapterId, 'gemini-cli');
  assert.equal(gem.summary().adapterName, 'Gemini CLI');

  const cc = await h.sessions.create({ workspaceId: 'repo', adapterId: 'claude-code', createdBy: null });
  assert.equal(cc.summary().adapterId, 'claude-code');

  // Sessions on different agents coexist.
  assert.equal(h.sessions.liveCount, 2);
});

test('unknown or uninstalled agents are refused', async (t) => {
  const h = await buildHarness({ GEMINI_COMMAND: '/nonexistent/gemini-binary' });
  t.after(() => h.close());

  for (const bad of ['nope', '../claude-code', 42, {}]) {
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
    () => h.sessions.create({ workspaceId: 'repo', adapterId: 'gemini-cli', createdBy: null }),
    /not installed/,
  );

  const res = await h.app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: { workspaceId: 'repo', adapterId: 'gemini-cli' },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'adapter_unavailable');

  const listed = (await h.app.inject({ method: 'GET', url: '/api/agents' })).json();
  assert.equal(listed.agents.find((a) => a.id === 'gemini-cli').available, false);
});

// ---------------------------------------------------------------- gemini

test('gemini runs one process per instruction and keeps the conversation', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const session = await h.sessions.create({ workspaceId: 'repo', adapterId: 'gemini-cli', createdBy: null });
  const sink = collectEvents(session);

  // No process exists until there is something to do.
  assert.equal(session.summary().state, 'idle');
  assert.equal(session.summary().pid, null);
  assert.equal(session.summary().live, true);

  await session.instruct('TOOL SHELL DELTA hello', null);
  await waitFor(() => session.summary().state === 'busy', { label: 'busy' });
  assert.ok(session.summary().pid, 'a turn has a live process');

  await waitFor(() => sink.types().includes('turn_finished'), { label: 'turn_finished' });

  const types = sink.types();
  for (const expected of [
    'session_started',
    'message_delta',
    'message',
    'tool_use',
    'tool_result',
    'command_started',
    'command_finished',
    'turn_finished',
  ]) {
    assert.ok(types.includes(expected), `expected ${expected}, got ${[...new Set(types)].join(', ')}`);
  }

  // The prompt echo the CLI emits as a user message must not be re-rendered.
  assert.ok(
    !sink.events.some((e) => e.type === 'message' && e.role === 'user'),
    'the echoed user prompt is not forwarded as a message',
  );

  const cliSessionId = session.summary().cliSessionId;
  assert.ok(cliSessionId, 'the conversation id is captured from init');

  // Back to idle with no process, and the session is still alive.
  await waitFor(() => session.summary().state === 'idle', { label: 'idle again' });
  assert.equal(session.summary().pid, null);
  assert.equal(session.summary().live, true, 'a finished turn does not end the session');

  await session.instruct('second turn', null);
  await waitFor(
    () => sink.events.some((e) => e.type === 'message' && String(e.text).includes('second turn')),
    { label: 'second turn reply' },
  );
  assert.equal(
    session.summary().cliSessionId,
    cliSessionId,
    'the second process resumed the same conversation',
  );
});

test('gemini surfaces a failing exit with its stderr', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const session = await h.sessions.create({ workspaceId: 'repo', adapterId: 'gemini-cli', createdBy: null });
  const sink = collectEvents(session);

  await session.instruct('FAIL now', null);
  await waitFor(() => sink.events.some((e) => e.type === 'error'), { label: 'error event' });

  const error = sink.events.find((e) => e.type === 'error');
  assert.match(error.message, /exited with code 41/);
  assert.match(error.detail, /GOOGLE_CLOUD_PROJECT/, 'the operator sees why it failed');

  // A failed turn still closes out, and the session remains usable.
  await waitFor(() => sink.types().includes('turn_finished'));
  assert.equal(sink.events.find((e) => e.type === 'turn_finished').isError, true);
  await waitFor(() => session.summary().state === 'idle');
  assert.equal(session.summary().live, true);
});

test('gemini closes the turn even when the CLI emits no result event', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const session = await h.sessions.create({ workspaceId: 'repo', adapterId: 'gemini-cli', createdBy: null });
  const sink = collectEvents(session);

  await session.instruct('NORESULT please', null);
  await waitFor(() => sink.types().includes('turn_finished'), { label: 'synthesised turn_finished' });
  await waitFor(() => session.summary().pendingInstructions === 0, { label: 'turn accounted for' });
});

test('cancelling a gemini turn kills its process but keeps the session', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const session = await h.sessions.create({ workspaceId: 'repo', adapterId: 'gemini-cli', createdBy: null });
  const sink = collectEvents(session);

  await session.instruct('SLOW work', null);
  await waitFor(() => session.summary().state === 'busy');
  const pid = session.summary().pid;

  await session.cancel('test cancel');
  await waitFor(() => sink.types().includes('session_cancelled'), { label: 'session_cancelled' });
  await waitFor(() => session.summary().state === 'idle', { label: 'idle after cancel' });
  assert.equal(session.summary().live, true);

  await waitFor(
    () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (err) {
        return err.code === 'ESRCH';
      }
    },
    { label: 'gemini process reaped' },
  );

  await session.instruct('after cancel', null);
  await waitFor(
    () => sink.events.some((e) => e.type === 'message' && String(e.text).includes('after cancel')),
    { label: 'usable after cancel' },
  );
});

test('gemini sessions report that they cannot ask for approval', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const session = await h.sessions.create({ workspaceId: 'repo', adapterId: 'gemini-cli', createdBy: null });
  assert.equal(session.summary().supportsPermissionPrompts, false);
  await assert.rejects(
    () => session.respondToPermission('whatever', 'allow', 'tester'),
    /no pending approval/,
  );
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
  assert.ok(welcome.agents.some((a) => a.id === 'gemini-cli'), 'the picker is fed from the welcome frame');

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
