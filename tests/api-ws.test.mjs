import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

import { buildHarness, waitFor } from './helpers.mjs';

/** Minimal client that mirrors what the browser does, including reconnect. */
class TestClient {
  constructor(port, headers = {}) {
    this.url = `ws://127.0.0.1:${port}/ws`;
    this.headers = headers;
    this.messages = [];
    this.events = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url, { headers: this.headers });
    // The handler is attached before 'open' resolves so the welcome frame,
    // which the server sends immediately, cannot be missed.
    this.socket.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      this.messages.push(msg);
      if (msg.t === 'events') {
        const list = this.events.get(msg.sessionId) ?? [];
        list.push(...msg.events);
        this.events.set(msg.sessionId, list);
      }
    });
    await new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    return this;
  }

  send(obj) {
    this.socket.send(JSON.stringify(obj));
  }

  sendRaw(raw) {
    this.socket.send(raw);
  }

  find(predicate) {
    return this.messages.find(predicate);
  }

  eventsFor(sessionId) {
    return this.events.get(sessionId) ?? [];
  }

  close() {
    this.socket?.close();
  }
}

test('health and identity endpoints', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const health = await h.app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().status, 'ok');

  const me = await h.app.inject({ method: 'GET', url: '/api/me' });
  assert.equal(me.json().identity.viaTailscale, false);

  const withIdentity = await h.app.inject({
    method: 'GET',
    url: '/api/me',
    headers: { 'tailscale-user-login': 'Someone@example.com', 'tailscale-user-name': 'Someone' },
    remoteAddress: '127.0.0.1',
  });
  assert.equal(withIdentity.json().identity.login, 'someone@example.com');
  assert.equal(withIdentity.json().identity.viaTailscale, true);
});

test('identity allow list and required-identity mode', async (t) => {
  const h = await buildHarness({
    REQUIRE_TAILSCALE_IDENTITY: 'true',
    ALLOWED_TAILSCALE_USERS: 'owner@example.com',
  });
  t.after(() => h.close());

  const anonymous = await h.app.inject({ method: 'GET', url: '/api/workspaces' });
  assert.equal(anonymous.statusCode, 403);

  const wrongUser = await h.app.inject({
    method: 'GET',
    url: '/api/workspaces',
    headers: { 'tailscale-user-login': 'someone-else@example.com' },
  });
  assert.equal(wrongUser.statusCode, 403);

  const owner = await h.app.inject({
    method: 'GET',
    url: '/api/workspaces',
    headers: { 'tailscale-user-login': 'owner@example.com' },
  });
  assert.equal(owner.statusCode, 200);

  // Health stays reachable so a supervisor can probe it.
  assert.equal((await h.app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
});

test('workspace listing never exposes filesystem paths', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const res = await h.app.inject({ method: 'GET', url: '/api/workspaces' });
  const body = res.json();
  assert.equal(body.workspaces.length, 2);
  for (const ws of body.workspaces) {
    assert.equal(ws.path, undefined, 'the absolute path must stay server-side');
  }
  assert.ok(!JSON.stringify(body).includes(h.repo), 'no absolute path appears anywhere in the payload');
});

test('unauthorized workspace access is rejected over HTTP', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const attempts = [
    { workspaceId: 'nope' },
    { workspaceId: '../repo' },
    { workspaceId: h.other },
    { workspaceId: '/etc' },
    { workspaceId: 'off' },
  ];
  for (const payload of attempts) {
    const res = await h.app.inject({ method: 'POST', url: '/api/sessions', payload });
    assert.ok(
      res.statusCode === 403 || res.statusCode === 404 || res.statusCode === 400,
      `expected rejection for ${payload.workspaceId}, got ${res.statusCode}`,
    );
    assert.ok(!res.body.includes(h.repo));
  }
  assert.equal(h.sessions.liveCount, 0);
});

test('git status and diff are read-only and reject traversal', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const status = await h.app.inject({ method: 'GET', url: '/api/workspaces/repo/git/status' });
  assert.equal(status.statusCode, 200);
  const git = status.json().git;
  assert.equal(git.isRepo, true);
  assert.equal(git.branch, 'main');
  assert.equal(git.clean, false);
  assert.ok(git.files.some((f) => f.path === 'README.md' && f.unstaged));
  assert.ok(git.files.some((f) => f.path === 'untracked.txt' && f.untracked));
  assert.ok(git.stats.insertions >= 1);

  const diff = await h.app.inject({ method: 'GET', url: '/api/workspaces/repo/git/diff' });
  assert.match(diff.json().diff, /\+changed/);
  assert.match(diff.json().diff, /untracked\.txt/);

  const fileDiff = await h.app.inject({ method: 'GET', url: '/api/workspaces/repo/git/diff?file=README.md' });
  assert.match(fileDiff.json().diff, /\+changed/);

  for (const attack of ['../unregistered/secret.txt', '/etc/passwd', '../../../etc/hosts', '~/.ssh/id_rsa']) {
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/workspaces/repo/git/diff?file=${encodeURIComponent(attack)}`,
    });
    assert.ok(res.statusCode >= 400, `expected rejection for ${attack}, got ${res.statusCode}`);
    assert.ok(!res.body.includes('top secret'), 'contents outside the workspace must never be returned');
  }

  const unknownWs = await h.app.inject({ method: 'GET', url: '/api/workspaces/nope/git/status' });
  assert.equal(unknownWs.statusCode, 404);
});

test('websocket lifecycle: instruct, stream, reconnect with replay, cancel', async (t) => {
  const h = await buildHarness();
  const port = await h.listen();
  t.after(() => h.close());

  const created = await h.app.inject({ method: 'POST', url: '/api/sessions', payload: { workspaceId: 'repo' } });
  assert.equal(created.statusCode, 201);
  const sessionId = created.json().session.id;

  const client = await new TestClient(port).connect();
  await waitFor(() => client.find((m) => m.t === 'welcome'), { label: 'welcome' });
  const welcome = client.find((m) => m.t === 'welcome');
  assert.ok(welcome.workspaces.some((w) => w.id === 'repo'));
  assert.ok(welcome.sessions.some((s) => s.id === sessionId));

  client.send({ t: 'subscribe', sessionId, sinceSeq: 0 });
  await waitFor(() => client.find((m) => m.t === 'subscribed'), { label: 'subscribed' });

  client.send({ t: 'instruct', sessionId, text: 'TOOL hello from the phone', clientMsgId: 'c1' });
  await waitFor(() => client.find((m) => m.t === 'ack' && m.clientMsgId === 'c1'), { label: 'ack' });
  await waitFor(() => client.eventsFor(sessionId).some((e) => e.type === 'turn_finished'), {
    label: 'turn finished over ws',
  });

  const seenSeq = Math.max(...client.eventsFor(sessionId).map((e) => e.seq));

  // The phone goes away mid-work; the CLI must keep running.
  client.send({ t: 'instruct', sessionId, text: 'SLOW keep going without me' });
  await waitFor(() => h.sessions.get(sessionId).summary().state === 'busy');
  client.close();
  await waitFor(() => h.sessions.get(sessionId).summary().state === 'busy', { label: 'still busy after disconnect' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.sessions.get(sessionId).summary().live, true, 'the session survives a browser disconnect');

  // Reconnect and ask for everything after the last event we saw.
  const client2 = await new TestClient(port).connect();
  await waitFor(() => client2.find((m) => m.t === 'welcome'));
  client2.send({ t: 'subscribe', sessionId, sinceSeq: seenSeq });
  await waitFor(() => client2.find((m) => m.t === 'subscribed'), { label: 'resubscribed' });

  const replayed = await waitFor(
    () => (client2.eventsFor(sessionId).length > 0 ? client2.eventsFor(sessionId) : null),
    { label: 'replayed events' },
  );
  assert.ok(replayed.every((e) => e.seq > seenSeq), 'only unseen events are replayed');
  assert.ok(replayed.some((e) => e.type === 'turn_started' && e.text.includes('keep going')));

  // Cancel from the reconnected phone.
  client2.send({ t: 'cancel', sessionId });
  await waitFor(() => client2.eventsFor(sessionId).some((e) => e.type === 'session_cancelled'), {
    label: 'cancelled over ws',
  });
  await waitFor(() => h.sessions.get(sessionId).summary().state === 'idle');

  const stateMsg = client2.messages.filter((m) => m.t === 'session').at(-1);
  assert.equal(stateMsg.session.id, sessionId);
  client2.close();
});

test('websocket rejects invalid frames and unauthorized sessions', async (t) => {
  const h = await buildHarness();
  const port = await h.listen();
  t.after(() => h.close());

  const client = await new TestClient(port).connect();
  await waitFor(() => client.find((m) => m.t === 'welcome'));

  client.sendRaw('not json at all');
  await waitFor(() => client.find((m) => m.t === 'error' && m.code === 'invalid_json'), { label: 'invalid_json' });

  client.send({ t: 'nonsense' });
  await waitFor(() => client.find((m) => m.t === 'error' && m.code === 'invalid_message'), { label: 'invalid_message' });

  client.send({ t: 'instruct', sessionId: 'does-not-exist', text: 'hi' });
  await waitFor(() => client.find((m) => m.t === 'error' && m.code === 'session_not_found'), {
    label: 'session_not_found',
  });

  client.send({ t: 'subscribe', sessionId: '../../etc/passwd', sinceSeq: 0 });
  await waitFor(() => client.messages.filter((m) => m.t === 'error').length >= 4, { label: 'traversal rejected' });

  client.send({ t: 'instruct', sessionId: 'x', text: '' });
  client.send({ t: 'subscribe', sessionId: 'x', sinceSeq: -5 });
  client.send({ t: 'ping' });
  await waitFor(() => client.find((m) => m.t === 'pong'), { label: 'pong' });

  // Repeated garbage eventually closes the connection.
  const closed = new Promise((resolve) => client.socket.once('close', (code) => resolve(code)));
  for (let i = 0; i < 12; i++) client.sendRaw('{');
  const code = await closed;
  assert.equal(code, 1008);
});

test('websocket handshakes are subject to the same authorization as HTTP', async (t) => {
  const h = await buildHarness({
    REQUIRE_TAILSCALE_IDENTITY: 'true',
    ALLOWED_TAILSCALE_USERS: 'owner@example.com',
  });
  const port = await h.listen();
  t.after(() => h.close());

  // No identity header: the upgrade must be refused, not merely unauthorized later.
  await assert.rejects(
    () => new TestClient(port).connect(),
    (err) => /403|Unexpected server response/.test(String(err.message)),
    'anonymous websocket upgrade should be rejected',
  );

  await assert.rejects(
    () => new TestClient(port, { 'tailscale-user-login': 'intruder@example.com' }).connect(),
    (err) => /403|Unexpected server response/.test(String(err.message)),
    'a tailnet user outside the allow list should be rejected',
  );

  const allowed = await new TestClient(port, { 'tailscale-user-login': 'owner@example.com' }).connect();
  await waitFor(() => allowed.find((m) => m.t === 'welcome'), { label: 'welcome for allowed user' });
  const welcome = allowed.find((m) => m.t === 'welcome');
  assert.equal(welcome.identity.login, 'owner@example.com');
  assert.equal(welcome.identity.viaTailscale, true);
  allowed.close();
});

test('oversized websocket frames are rejected', async (t) => {
  const h = await buildHarness({ MAX_WS_PAYLOAD_BYTES: '8192' });
  const port = await h.listen();
  t.after(() => h.close());

  const created = await h.app.inject({ method: 'POST', url: '/api/sessions', payload: { workspaceId: 'repo' } });
  const sessionId = created.json().session.id;

  const client = await new TestClient(port).connect();
  await waitFor(() => client.find((m) => m.t === 'welcome'));

  const closed = new Promise((resolve) => client.socket.once('close', resolve));
  client.send({ t: 'instruct', sessionId, text: 'y'.repeat(20_000) });
  // ws closes the connection when a frame exceeds maxPayload.
  await closed;
  assert.equal(h.sessions.get(sessionId).summary().live, true, 'the session is unaffected');
});

test('instruction length is capped over HTTP', async (t) => {
  const h = await buildHarness({ MAX_INSTRUCTION_CHARS: '1000' });
  t.after(() => h.close());

  const created = await h.app.inject({ method: 'POST', url: '/api/sessions', payload: { workspaceId: 'repo' } });
  const sessionId = created.json().session.id;

  const res = await h.app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/instruct`,
    payload: { text: 'z'.repeat(2000) },
  });
  assert.equal(res.statusCode, 413);
});

test('there is no shell or filesystem endpoint', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  for (const url of [
    '/api/exec',
    '/api/shell',
    '/api/files',
    '/api/fs?path=/etc/passwd',
    '/api/run',
    '/api/workspaces/repo/files',
    '/api/workspaces/repo/exec',
  ]) {
    const res = await h.app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 404, `${url} must not exist`);
  }

  for (const url of ['/api/exec', '/api/workspaces/repo/exec']) {
    const res = await h.app.inject({ method: 'POST', url, payload: { command: 'id' } });
    assert.equal(res.statusCode, 404);
  }
});

test('session can be stopped via POST /api/sessions/:id/stop and retains history', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const created = await h.app.inject({ method: 'POST', url: '/api/sessions', payload: { workspaceId: 'repo' } });
  const sessionId = created.json().session.id;

  const stopRes = await h.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/stop` });
  assert.equal(stopRes.statusCode, 200);

  const getRes = await h.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
  assert.equal(getRes.statusCode, 200);
  assert.equal(getRes.json().session.live, false);
});

test('session can be deleted via DELETE /api/sessions/:id, removing memory and disk state', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const created = await h.app.inject({ method: 'POST', url: '/api/sessions', payload: { workspaceId: 'repo' } });
  const sessionId = created.json().session.id;

  const delRes = await h.app.inject({ method: 'DELETE', url: `/api/sessions/${sessionId}` });
  assert.equal(delRes.statusCode, 200);
  assert.equal(delRes.json().deleted, sessionId);

  const getRes = await h.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
  assert.equal(getRes.statusCode, 404);
});

test('history can be cleared via POST /api/sessions/clear-history', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const live = await h.sessions.create({ workspaceId: 'repo', createdBy: null });
  const stopped1 = await h.sessions.create({ workspaceId: 'repo', createdBy: null });
  await stopped1.terminate('stopped');
  const stopped2 = await h.sessions.create({ workspaceId: 'repo', createdBy: null });
  await stopped2.terminate('stopped');

  const clearRes = await h.app.inject({ method: 'POST', url: '/api/sessions/clear-history' });
  assert.equal(clearRes.statusCode, 200);
  assert.equal(clearRes.json().cleared, 2);

  const listRes = await h.app.inject({ method: 'GET', url: '/api/sessions' });
  const remaining = listRes.json().sessions;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, live.id);
});
