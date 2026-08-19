import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

/**
 * Loads the real built client into a DOM, feeds it the frames the server sends,
 * and checks what the phone would actually display.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(root, 'dist/web/app.js');

function mountClient(t, hash = '') {
  assert.ok(fs.existsSync(bundle), 'run `npm run build` before the UI tests');

  const sockets = [];
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'dist/web/index.html'), 'utf8'), {
    url: `http://127.0.0.1:4823/${hash}`,
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });

  const { window } = dom;

  class FakeWebSocket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.sent = [];
      sockets.push(this);
    }
    send(data) {
      this.sent.push(JSON.parse(data));
    }
    close() {
      this.readyState = 3;
      this.onclose?.({});
    }
    receive(message) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
    open() {
      this.onopen?.({});
    }
  }
  window.WebSocket = FakeWebSocket;
  window.WebSocket.OPEN = 1;

  const fetchCalls = [];
  window.fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ session: { id: 'sess1', workspaceId: 'demo' } }),
    };
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

  window.eval(fs.readFileSync(bundle, 'utf8'));

  // The client keeps a heartbeat interval alive; without this the test process
  // would never exit. The short delay lets in-flight click handlers settle
  // before the window disappears underneath them.
  t.after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    window.close();
  });

  return { window, document: window.document, sockets, fetchCalls, socket: () => sockets.at(-1) };
}

const welcome = {
  t: 'welcome',
  identity: { login: 'owner@example.com', displayName: 'Owner', viaTailscale: true },
  workspaces: [
    { id: 'demo', name: 'Demo Repo', enabled: true, isGitRepo: true },
    { id: 'old', name: 'Archived', enabled: false, isGitRepo: false },
  ],
  sessions: [
    {
      id: 'sess1',
      workspaceId: 'demo',
      workspaceName: 'Demo Repo',
      title: 'Fix the parser',
      state: 'busy',
      model: 'claude-fable-5',
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now(),
      lastSeq: 4,
      live: true,
      resumable: false,
      pendingInstructions: 1,
    },
    {
      id: 'sess0',
      workspaceId: 'demo',
      workspaceName: 'Demo Repo',
      title: 'Yesterday',
      state: 'exited',
      model: null,
      createdAt: Date.now() - 8_000_000,
      updatedAt: Date.now() - 7_000_000,
      lastSeq: 40,
      live: false,
      resumable: true,
      pendingInstructions: 0,
    },
  ],
  limits: { maxConcurrentSessions: 4, maxInstructionChars: 32000 },
};

test('home screen lists workspaces and separates active sessions from history', (t) => {
  const ui = mountClient(t);
  ui.socket().open();
  ui.socket().receive(welcome);

  const text = ui.document.body.textContent;
  assert.match(text, /Demo Repo/);
  assert.match(text, /Archived/);
  assert.match(text, /Fix the parser/);
  assert.match(text, /Yesterday/);
  assert.match(text, /Active sessions \(1\)/);
  assert.match(text, /History/);

  // Connection state and identity are always visible.
  const pill = ui.document.querySelector('.conn');
  assert.equal(pill.getAttribute('data-state'), 'online');
  assert.match(pill.textContent, /owner@example.com/);

  // A disabled workspace cannot start a session.
  const disabled = [...ui.document.querySelectorAll('.card')].find((c) => c.textContent.includes('Archived'));
  assert.ok(disabled.classList.contains('disabled'));
});

test('connection state is reflected when the socket drops', (t) => {
  const ui = mountClient(t);
  ui.socket().open();
  ui.socket().receive(welcome);
  ui.socket().close();
  assert.equal(ui.document.querySelector('.conn').getAttribute('data-state'), 'offline');
  assert.match(ui.document.querySelector('.conn').textContent, /offline/);
});

test('session view streams deltas and reconciles them with the final message', (t) => {
  const ui = mountClient(t, '#/s/sess1');
  ui.socket().open();
  ui.socket().receive(welcome);

  // It subscribes from sequence 0 on first view.
  const subscribe = ui.socket().sent.find((m) => m.t === 'subscribe');
  assert.deepEqual(subscribe, { t: 'subscribe', sessionId: 'sess1', sinceSeq: 0 });

  const events = [
    { seq: 1, ts: Date.now(), sessionId: 'sess1', type: 'turn_started', instructionId: 'i1', text: 'Fix the parser' },
    { seq: 2, ts: Date.now(), sessionId: 'sess1', type: 'message_delta', blockId: 'msg_1:0', text: 'Look' },
    { seq: 3, ts: Date.now(), sessionId: 'sess1', type: 'message_delta', blockId: 'msg_1:0', text: 'ing…' },
  ];
  ui.socket().receive({ t: 'events', sessionId: 'sess1', events });

  const stream = ui.document.getElementById('stream');
  assert.match(stream.textContent, /Fix the parser/);
  assert.match(stream.textContent, /Looking…/);
  assert.equal(stream.querySelectorAll('.bubble.assistant.streaming').length, 1);

  // The final block replaces the streamed text rather than duplicating it.
  ui.socket().receive({
    t: 'events',
    sessionId: 'sess1',
    events: [
      {
        seq: 4,
        ts: Date.now(),
        sessionId: 'sess1',
        type: 'message',
        role: 'assistant',
        blockId: 'msg_1:0',
        text: 'Looking… done.',
      },
    ],
  });
  const bubbles = [...stream.querySelectorAll('.bubble.assistant')];
  assert.equal(bubbles.length, 1, 'the streamed bubble is reused, not duplicated');
  assert.equal(bubbles[0].textContent, 'Looking… done.');
  assert.equal(bubbles[0].classList.contains('streaming'), false);
});

test('tool and command events render as an activity feed and fill in their results', (t) => {
  const ui = mountClient(t, '#/s/sess1');
  ui.socket().open();
  ui.socket().receive(welcome);

  ui.socket().receive({
    t: 'events',
    sessionId: 'sess1',
    events: [
      { seq: 1, ts: 1, sessionId: 'sess1', type: 'tool_use', toolUseId: 't1', name: 'Read', summary: 'src/index.ts', input: { file_path: 'src/index.ts' } },
      { seq: 2, ts: 2, sessionId: 'sess1', type: 'command_started', toolUseId: 'c1', command: 'npm test', description: 'run tests' },
    ],
  });

  const stream = ui.document.getElementById('stream');
  assert.match(stream.textContent, /Read/);
  assert.match(stream.textContent, /src\/index\.ts/);
  assert.match(stream.textContent, /npm test/);

  ui.socket().receive({
    t: 'events',
    sessionId: 'sess1',
    events: [
      { seq: 3, ts: 3, sessionId: 'sess1', type: 'tool_result', toolUseId: 't1', isError: false, content: 'file body' },
      { seq: 4, ts: 4, sessionId: 'sess1', type: 'command_finished', toolUseId: 'c1', isError: true, output: '1 test failed' },
    ],
  });

  assert.match(ui.document.getElementById('tool-t1').textContent, /file body/);
  const command = ui.document.getElementById('cmd-c1');
  assert.match(command.textContent, /1 test failed/);
  assert.ok(command.classList.contains('failed'), 'a failed command is visually marked');
});

test('replayed events are de-duplicated by sequence number', (t) => {
  const ui = mountClient(t, '#/s/sess1');
  ui.socket().open();
  ui.socket().receive(welcome);

  const event = { seq: 7, ts: 1, sessionId: 'sess1', type: 'message', role: 'assistant', blockId: 'b1', text: 'only once' };
  ui.socket().receive({ t: 'events', sessionId: 'sess1', events: [event] });
  ui.socket().receive({ t: 'events', sessionId: 'sess1', events: [event] });

  const matches = [...ui.document.querySelectorAll('.bubble')].filter((b) => b.textContent === 'only once');
  assert.equal(matches.length, 1);
});

test('composer sends instructions and the stop control cancels', (t) => {
  const ui = mountClient(t, '#/s/sess1');
  ui.socket().open();
  ui.socket().receive(welcome);

  const input = ui.document.getElementById('composer-input');
  input.value = '  refactor the session manager  ';
  ui.document.querySelector('.send-btn').click();

  const instruct = ui.socket().sent.find((m) => m.t === 'instruct');
  assert.equal(instruct.sessionId, 'sess1');
  assert.equal(instruct.text, 'refactor the session manager', 'the text is trimmed before sending');
  assert.equal(input.value, '', 'the box is cleared after sending');

  ui.document.getElementById('cancel-btn').click();
  assert.ok(ui.socket().sent.some((m) => m.t === 'cancel' && m.sessionId === 'sess1'));

  // Empty input sends nothing.
  const before = ui.socket().sent.length;
  input.value = '   ';
  ui.document.querySelector('.send-btn').click();
  assert.equal(ui.socket().sent.length, before);
});

test('a stopped session offers reconnect instead of a composer', async (t) => {
  const ui = mountClient(t, '#/s/sess0');
  ui.socket().open();
  ui.socket().receive(welcome);

  assert.equal(ui.document.getElementById('composer-input'), null, 'no composer for a dead session');
  const body = ui.document.body.textContent;
  assert.match(body, /stopped/i);
  const reconnect = [...ui.document.querySelectorAll('button')].find((b) => b.textContent === 'Reconnect');
  assert.ok(reconnect, 'a reconnect control is offered');

  reconnect.click();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(
    ui.fetchCalls.some((c) => String(c.url).includes('/api/sessions/sess0/resume') && c.init.method === 'POST'),
    'reconnect calls the resume endpoint',
  );
  // Bodyless requests must not claim a JSON body: Fastify rejects those.
  const call = ui.fetchCalls.find((c) => String(c.url).includes('/resume'));
  assert.equal(call.init.body, undefined);
  assert.equal(Object.keys(call.init.headers ?? {}).length, 0, 'no content-type is claimed for an empty body');
});

test('session state updates are reflected without losing the stream', (t) => {
  const ui = mountClient(t, '#/s/sess1');
  ui.socket().open();
  ui.socket().receive(welcome);
  ui.socket().receive({
    t: 'events',
    sessionId: 'sess1',
    events: [{ seq: 1, ts: 1, sessionId: 'sess1', type: 'message', role: 'assistant', blockId: 'b', text: 'keep me' }],
  });

  ui.socket().receive({ t: 'session', session: { ...welcome.sessions[0], state: 'idle', pendingInstructions: 0 } });

  assert.match(ui.document.querySelector('.topbar .subtitle').textContent, /idle/);
  assert.match(ui.document.getElementById('stream').textContent, /keep me/, 'the transcript is not cleared');
  assert.ok(ui.document.getElementById('cancel-btn').classList.contains('hidden'), 'cancel hides when not busy');
});

test('server errors surface as a toast rather than breaking the view', (t) => {
  const ui = mountClient(t, '#/s/sess1');
  ui.socket().open();
  ui.socket().receive(welcome);
  ui.socket().receive({ t: 'error', code: 'session_busy', message: 'Too many queued instructions' });

  const toast = ui.document.querySelector('.toast');
  assert.ok(toast);
  assert.match(toast.textContent, /Too many queued instructions/);
  assert.ok(ui.document.getElementById('stream'), 'the session view is still mounted');
});
