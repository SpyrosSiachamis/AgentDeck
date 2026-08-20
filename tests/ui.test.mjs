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
  // Transcript replays are served from here so a test can decide what history
  // the server would hand back for /api/sessions/:id/events.
  const history = { events: [], skipped: 0 };
  window.fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    const body = String(url).includes('/events')
      ? { sessionId: 'sess1', lastSeq: history.events.at(-1)?.seq ?? 0, ...history }
      : { session: { id: 'sess1', workspaceId: 'demo' } };
    return { ok: true, status: 200, json: async () => body };
  };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  // jsdom leaves this undefined; every real browser defines it, and http on
  // loopback counts as secure. Without it the client reports the wrong reason
  // for notifications being unavailable.
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });

  window.eval(fs.readFileSync(bundle, 'utf8'));

  // The client keeps a heartbeat interval alive; without this the test process
  // would never exit. The short delay lets in-flight click handlers settle
  // before the window disappears underneath them.
  t.after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    window.close();
  });

  return { window, document: window.document, sockets, fetchCalls, history, socket: () => sockets.at(-1) };
}

const welcome = {
  t: 'welcome',
  identity: { login: 'owner@example.com', displayName: 'Owner', viaTailscale: true },
  workspaces: [
    { id: 'demo', name: 'Demo Repo', enabled: true, isGitRepo: true },
    { id: 'old', name: 'Archived', enabled: false, isGitRepo: false },
  ],
  agents: [
    {
      id: 'claude-code',
      displayName: 'Claude Code',
      command: 'claude',
      model: null,
      available: true,
      persistentProcess: true,
      supportsPermissionPrompts: true,
      note: 'One long-lived process per session.',
    },
    {
      id: 'antigravity-cli',
      displayName: 'Antigravity CLI',
      command: 'agy',
      model: null,
      available: true,
      persistentProcess: true,
      supportsPermissionPrompts: false,
      note: 'One long-lived process per session.',
    },
  ],
  defaultAgent: 'claude-code',
  sessions: [
    {
      id: 'sess1',
      workspaceId: 'demo',
      workspaceName: 'Demo Repo',
      adapterId: 'antigravity-cli',
      adapterName: 'Antigravity CLI',
      title: 'Fix the parser',
      state: 'busy',
      model: 'gemini-3.7-flash',
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now(),
      lastSeq: 4,
      live: true,
      resumable: false,
      pendingInstructions: 1,
      pendingPermissions: [],
      supportsPermissionPrompts: true,
    },
    {
      id: 'sess0',
      workspaceId: 'demo',
      workspaceName: 'Demo Repo',
      adapterId: 'antigravity-cli',
      adapterName: 'Antigravity CLI',
      title: 'Yesterday',
      state: 'exited',
      model: null,
      createdAt: Date.now() - 8_000_000,
      updatedAt: Date.now() - 7_000_000,
      lastSeq: 40,
      live: false,
      resumable: true,
      pendingInstructions: 0,
      pendingPermissions: [],
      supportsPermissionPrompts: false,
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

// --------------------------------------------------------- agents + approvals

test('picking a workspace offers the installed agents', async (t) => {
  const ui = mountClient(t);
  ui.socket().open();
  ui.socket().receive(welcome);

  const card = [...ui.document.querySelectorAll('.card')].find((c) => c.textContent.includes('Demo Repo'));
  card.click();

  const sheet = ui.document.querySelector('.sheet');
  assert.ok(sheet, 'an agent picker opens');
  assert.match(sheet.textContent, /Claude Code/);
  assert.match(sheet.textContent, /Antigravity CLI/);
  assert.match(sheet.textContent, /default/);

  const agy = [...sheet.querySelectorAll('.card')].find((c) => c.textContent.includes('Antigravity CLI'));
  agy.click();
  await new Promise((resolve) => setTimeout(resolve, 5));

  const call = ui.fetchCalls.find((c) => String(c.url) === '/api/sessions');
  assert.ok(call, 'a session is created');
  assert.deepEqual(JSON.parse(call.init.body), { workspaceId: 'demo', adapterId: 'antigravity-cli' });
  assert.equal(ui.document.querySelector('.sheet'), null, 'the sheet closes after choosing');
});

test('an uninstalled agent is never started', async (t) => {
  const ui = mountClient(t);
  ui.socket().open();
  ui.socket().receive({
    ...welcome,
    agents: [welcome.agents[0], { ...welcome.agents[1], available: false }],
  });

  const card = [...ui.document.querySelectorAll('.card')].find((c) => c.textContent.includes('Demo Repo'));
  card.click();
  await new Promise((resolve) => setTimeout(resolve, 5));

  // Only one agent is installed, so there is nothing to choose between and the
  // session starts on it directly — the missing one is never offered.
  assert.equal(ui.document.querySelector('.sheet'), null, 'no picker for a single choice');
  const call = ui.fetchCalls.find((c) => String(c.url) === '/api/sessions');
  assert.equal(JSON.parse(call.init.body).adapterId, 'claude-code');
});

test('with no agent installed nothing is started', (t) => {
  const ui = mountClient(t);
  ui.socket().open();
  ui.socket().receive({
    ...welcome,
    agents: welcome.agents.map((a) => ({ ...a, available: false })),
  });

  const card = [...ui.document.querySelectorAll('.card')].find((c) => c.textContent.includes('Demo Repo'));
  card.click();

  assert.equal(ui.fetchCalls.length, 0, 'no session is created');
  assert.match(ui.document.querySelector('.toast').textContent, /No coding agent is installed/);
});

test('a permission request renders approve and deny controls', (t) => {
  const ui = mountClient(t, '#/s/sess1');
  ui.socket().open();
  ui.socket().receive(welcome);

  ui.socket().receive({
    t: 'events',
    sessionId: 'sess1',
    events: [
      {
        seq: 1,
        ts: 1,
        sessionId: 'sess1',
        type: 'permission_request',
        requestId: 'req-1',
        toolName: 'Bash',
        displayName: 'Bash',
        summary: 'rm -rf ./build',
        command: 'rm -rf ./build',
        input: { command: 'rm -rf ./build' },
      },
    ],
  });

  const card = ui.document.getElementById('perm-req-1');
  assert.ok(card, 'an approval card is shown');
  assert.match(card.textContent, /needs your approval/);
  assert.match(card.textContent, /rm -rf \.\/build/, 'the exact command is visible');

  const buttons = [...card.querySelectorAll('button')].map((b) => b.textContent);
  assert.deepEqual(buttons, ['Deny', 'Approve']);

  const approve = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Approve');
  approve.click();

  const sent = ui.socket().sent.find((m) => m.t === 'permission');
  assert.deepEqual(sent, { t: 'permission', sessionId: 'sess1', requestId: 'req-1', decision: 'allow' });
  assert.match(card.textContent, /Sending…/, 'the controls are replaced once answered');
});

test('denying sends a deny decision and the outcome is shown when confirmed', (t) => {
  const ui = mountClient(t, '#/s/sess1');
  ui.socket().open();
  ui.socket().receive(welcome);
  ui.socket().receive({
    t: 'events',
    sessionId: 'sess1',
    events: [
      { seq: 1, ts: 1, sessionId: 'sess1', type: 'permission_request', requestId: 'req-2', toolName: 'Bash', displayName: 'Bash', summary: 'curl evil.example', command: 'curl evil.example' },
    ],
  });

  const card = ui.document.getElementById('perm-req-2');
  [...card.querySelectorAll('button')].find((b) => b.textContent === 'Deny').click();
  assert.equal(ui.socket().sent.find((m) => m.t === 'permission').decision, 'deny');

  ui.socket().receive({
    t: 'events',
    sessionId: 'sess1',
    events: [
      { seq: 2, ts: 2, sessionId: 'sess1', type: 'permission_resolved', requestId: 'req-2', decision: 'deny', decidedBy: 'owner@example.com' },
    ],
  });

  assert.ok(card.classList.contains('denied'));
  assert.match(card.textContent, /Denied by owner@example.com/);
});

test('a replayed approval that was already answered shows as resolved', (t) => {
  const ui = mountClient(t, '#/s/sess1');
  ui.socket().open();
  ui.socket().receive(welcome);

  // Exactly what a reconnecting phone receives: request then resolution.
  ui.socket().receive({
    t: 'events',
    sessionId: 'sess1',
    events: [
      { seq: 1, ts: 1, sessionId: 'sess1', type: 'permission_request', requestId: 'req-3', toolName: 'Bash', displayName: 'Bash', summary: 'ls', command: 'ls' },
      { seq: 2, ts: 2, sessionId: 'sess1', type: 'permission_resolved', requestId: 'req-3', decision: 'allow', decidedBy: 'owner@example.com' },
    ],
  });

  const card = ui.document.getElementById('perm-req-3');
  assert.ok(card.classList.contains('allowed'));
  assert.match(card.textContent, /Approved by owner@example.com/);
  assert.equal(card.querySelectorAll('button').length, 0, 'no stale buttons after a reconnect');
});

test('a shell command renders once, not as both a tool and a command', (t) => {
  const ui = mountClient(t, '#/s/sess1');
  ui.socket().open();
  ui.socket().receive(welcome);

  ui.socket().receive({
    t: 'events',
    sessionId: 'sess1',
    events: [
      { seq: 1, ts: 1, sessionId: 'sess1', type: 'tool_use', toolUseId: 'b1', name: 'Bash', summary: 'npm test', input: { command: 'npm test' } },
      { seq: 2, ts: 2, sessionId: 'sess1', type: 'command_started', toolUseId: 'b1', command: 'npm test', description: 'run tests' },
    ],
  });

  const stream = ui.document.getElementById('stream');
  assert.equal(stream.querySelectorAll('.event').length, 1, 'one entry per command, not two');
  assert.equal(ui.document.getElementById('tool-b1'), null, 'the tool node was upgraded, not duplicated');
  assert.ok(ui.document.getElementById('cmd-b1'));

  ui.socket().receive({
    t: 'events',
    sessionId: 'sess1',
    events: [
      { seq: 3, ts: 3, sessionId: 'sess1', type: 'command_finished', toolUseId: 'b1', isError: false, output: 'all tests passed' },
    ],
  });
  assert.match(ui.document.getElementById('cmd-b1').textContent, /all tests passed/);
  assert.equal(stream.querySelectorAll('.event').length, 1);
});

test('a session waiting on approval says so in the header', (t) => {
  const ui = mountClient(t, '#/s/sess1');
  ui.socket().open();
  ui.socket().receive(welcome);

  ui.socket().receive({
    t: 'session',
    session: {
      ...welcome.sessions[0],
      pendingPermissions: [{ requestId: 'req-9', toolName: 'Bash', summary: 'rm x', command: 'rm x', requestedAt: Date.now() }],
    },
  });

  assert.match(ui.document.querySelector('.topbar .subtitle').textContent, /waiting for your approval/);
  assert.ok(ui.document.querySelector('.topbar').classList.contains('awaiting-approval'));
});

test('history cards render delete button and clicking it calls DELETE endpoint', async (t) => {
  const ui = mountClient(t);
  ui.window.confirm = () => true;
  ui.socket().open();
  ui.socket().receive(welcome);

  const deleteBtn = ui.document.querySelector('.card-delete-btn');
  assert.ok(deleteBtn, 'history card has a delete button');

  deleteBtn.click();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const deleteCall = ui.fetchCalls.find((c) => c.url.includes('/api/sessions/sess0') && c.init?.method === 'DELETE');
  assert.ok(deleteCall, 'DELETE request was sent for the history session');
});

test('dead session bar renders delete button and clicking it calls DELETE endpoint', async (t) => {
  const ui = mountClient(t, '#/s/sess0');
  ui.window.confirm = () => true;
  ui.socket().open();
  ui.socket().receive(welcome);

  const deleteBtn = [...ui.document.querySelectorAll('button')].find((b) => b.textContent === 'Delete');
  assert.ok(deleteBtn, 'dead session composer bar has a Delete button');

  deleteBtn.click();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const deleteCall = ui.fetchCalls.find((c) => c.url.includes('/api/sessions/sess0') && c.init?.method === 'DELETE');
  assert.ok(deleteCall, 'DELETE request was sent for the dead session');
});

test('history section clear all button calls clear-history endpoint', async (t) => {
  const ui = mountClient(t);
  ui.window.confirm = () => true;
  ui.socket().open();
  ui.socket().receive(welcome);

  const clearBtn = ui.document.querySelector('.section-action');
  assert.ok(clearBtn, 'history section has a clear all button');
  assert.match(clearBtn.textContent, /Clear all/);

  clearBtn.click();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const clearCall = ui.fetchCalls.find((c) => c.url.includes('/api/sessions/clear-history') && c.init?.method === 'POST');
  assert.ok(clearCall, 'POST clear-history request was sent');
});

// ----------------------------------------------------------- markdown bubbles

test('user and assistant chat bubbles render rich markdown formatting', (t) => {
  const ui = mountClient(t, '#/s/sess1');
  ui.socket().open();
  ui.socket().receive(welcome);

  const userMarkdown = 'Please check `src/index.ts` and **fix the bugs**:\n- Bug 1\n- Bug 2';
  const assistantMarkdown = `### Analysis Result
Here is what I found in the file:
> Important warning note

| Function | Status |
| --- | --- |
| \`parse()\` | *Broken* |

Link: [Docs](https://example.com/docs)
`;

  ui.socket().receive({
    t: 'events',
    sessionId: 'sess1',
    events: [
      { seq: 1, ts: 1, sessionId: 'sess1', type: 'turn_started', text: userMarkdown },
      { seq: 2, ts: 2, sessionId: 'sess1', type: 'message', role: 'assistant', blockId: 'b_md_1', text: assistantMarkdown },
    ],
  });

  const userBubble = ui.document.querySelector('.bubble.user');
  assert.ok(userBubble, 'user bubble rendered');
  assert.ok(userBubble.querySelector('code'), 'user inline code rendered');
  assert.equal(userBubble.querySelector('code').textContent, 'src/index.ts');
  assert.ok(userBubble.querySelector('strong'), 'user bold rendered');
  assert.equal(userBubble.querySelector('strong').textContent, 'fix the bugs');
  assert.ok(userBubble.querySelector('ul'), 'user list rendered');
  assert.equal(userBubble.querySelectorAll('li').length, 2);

  const assistantBubble = ui.document.querySelector('.bubble.assistant');
  assert.ok(assistantBubble, 'assistant bubble rendered');
  assert.ok(assistantBubble.querySelector('h3'), 'h3 heading rendered');
  assert.equal(assistantBubble.querySelector('h3').textContent, 'Analysis Result');
  assert.ok(assistantBubble.querySelector('blockquote'), 'blockquote rendered');
  assert.match(assistantBubble.querySelector('blockquote').textContent, /Important warning note/);
  assert.ok(assistantBubble.querySelector('table'), 'table rendered');
  assert.equal(assistantBubble.querySelectorAll('th').length, 2);
  assert.equal(assistantBubble.querySelectorAll('td').length, 2);

  const link = assistantBubble.querySelector('a');
  assert.ok(link, 'link rendered');
  assert.equal(link.getAttribute('href'), 'https://example.com/docs');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
});

test('code blocks render with language indicator and copy button', async (t) => {
  const ui = mountClient(t, '#/s/sess1');
  ui.socket().open();
  ui.socket().receive(welcome);

  const codeSnippet = '```typescript\nconst message: string = "hello world";\nconsole.log(message);\n```';

  let copiedText = '';
  ui.window.navigator.clipboard = {
    writeText: async (text) => {
      copiedText = text;
    },
  };

  ui.socket().receive({
    t: 'events',
    sessionId: 'sess1',
    events: [
      { seq: 1, ts: 1, sessionId: 'sess1', type: 'message', role: 'assistant', blockId: 'b_code_1', text: codeSnippet },
    ],
  });

  const codeBlock = ui.document.querySelector('.bubble.assistant .code-block');
  assert.ok(codeBlock, 'code block container rendered');

  const langTag = codeBlock.querySelector('.code-lang');
  assert.ok(langTag, 'language tag rendered');
  assert.equal(langTag.textContent, 'typescript');

  const codeEl = codeBlock.querySelector('pre code');
  assert.ok(codeEl, 'code element rendered');
  assert.match(codeEl.textContent, /const message: string/);

  const copyBtn = codeBlock.querySelector('.code-copy-btn');
  assert.ok(copyBtn, 'copy button rendered');
  assert.equal(copyBtn.textContent, 'Copy');

  copyBtn.click();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.match(copiedText, /const message: string = "hello world";/);
  assert.equal(copyBtn.textContent, 'Copied!');
  assert.ok(copyBtn.classList.contains('copied'));
});

test('streaming deltas progressively update markdown in assistant bubble', (t) => {
  const ui = mountClient(t, '#/s/sess1');
  ui.socket().open();
  ui.socket().receive(welcome);

  ui.socket().receive({
    t: 'events',
    sessionId: 'sess1',
    events: [
      { seq: 1, ts: 1, sessionId: 'sess1', type: 'message_delta', blockId: 'b_stream_md', text: 'Here is **bold' },
    ],
  });

  const bubble = ui.document.querySelector('.bubble.assistant.streaming');
  assert.ok(bubble, 'streaming bubble mounted');
  assert.match(bubble.textContent, /Here is/);

  ui.socket().receive({
    t: 'events',
    sessionId: 'sess1',
    events: [
      { seq: 2, ts: 2, sessionId: 'sess1', type: 'message_delta', blockId: 'b_stream_md', text: ' text** and `code`' },
    ],
  });

  assert.ok(bubble.querySelector('strong'), 'progressive markdown bold element created');
  assert.equal(bubble.querySelector('strong').textContent, 'bold text');
  assert.ok(bubble.querySelector('code'), 'progressive markdown code element created');
  assert.equal(bubble.querySelector('code').textContent, 'code');

  // Final message replaces streaming
  ui.socket().receive({
    t: 'events',
    sessionId: 'sess1',
    events: [
      { seq: 3, ts: 3, sessionId: 'sess1', type: 'message', role: 'assistant', blockId: 'b_stream_md', text: 'Here is **bold text** and `code` done.' },
    ],
  });

  assert.equal(ui.document.querySelectorAll('.bubble.assistant.streaming').length, 0);
  assert.equal(bubble.classList.contains('streaming'), false);
  assert.match(bubble.textContent, /done\./);
});

test('markdown rendering sanitizes malicious scripts and XSS payloads', (t) => {
  const ui = mountClient(t, '#/s/sess1');
  ui.socket().open();
  ui.socket().receive(welcome);

  const malicious = 'Hello <script>alert("xss")</script><img src=x onerror=alert(1)> [Click](javascript:alert("evil"))';

  ui.socket().receive({
    t: 'events',
    sessionId: 'sess1',
    events: [
      { seq: 1, ts: 1, sessionId: 'sess1', type: 'turn_started', text: malicious },
      { seq: 2, ts: 2, sessionId: 'sess1', type: 'message', role: 'assistant', blockId: 'b_sec', text: malicious },
    ],
  });

  const userBubble = ui.document.querySelector('.bubble.user');
  const assistantBubble = ui.document.querySelector('.bubble.assistant');

  for (const b of [userBubble, assistantBubble]) {
    assert.equal(b.querySelectorAll('script').length, 0, 'scripts are stripped');
    const img = b.querySelector('img');
    if (img) {
      assert.equal(img.getAttribute('onerror'), null, 'inline error handlers are stripped');
    }
    const badLink = [...b.querySelectorAll('a')].find((a) => (a.getAttribute('href') || '').includes('javascript:'));
    assert.equal(badLink, undefined, 'javascript: URIs are stripped');
  }
});


// --------------------------------------------------------- notification setup

/** Waits for the sheet's async status check to render into the panel. */
async function openNotifications(document) {
  document.getElementById('notifications-btn').click();
  const sheet = document.querySelector('.sheet');
  assert.ok(sheet, 'the bell opens the notifications sheet');
  await new Promise((resolve) => setTimeout(resolve, 20));
  return sheet;
}

test('the home screen offers notification settings', async (t) => {
  const { window, document, socket } = mountClient(t);
  socket().receive(welcome);

  const sheet = await openNotifications(document);
  assert.match(sheet.textContent, /approval/i, 'the sheet says what a notification is for');

  // Nothing here may leave a phone stuck with a dead toggle.
  assert.equal(sheet.querySelector('.push-body').textContent.trim().length > 0, true);
  window.document.querySelector('.sheet').remove();
});

test('on an iPhone in Safari the sheet asks for a Home Screen install first', async (t) => {
  const { window, document, socket } = mountClient(t);
  socket().receive(welcome);

  // iOS grants push only to an installed PWA, so the sheet must say so rather
  // than showing a toggle that silently fails.
  Object.defineProperty(window.navigator, 'userAgent', {
    value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1',
    configurable: true,
  });

  const sheet = await openNotifications(document);
  assert.ok(sheet.querySelector('.push-install'), 'the install instructions are shown');
  assert.match(sheet.textContent, /Add to Home Screen/i);
  assert.equal(sheet.querySelector('.push-row'), null, 'no toggle is offered until it can work');
});

test('watching a session tells the server, so a finished turn does not double-notify', async (t) => {
  const { document, socket } = mountClient(t, '#/s/sess1');
  socket().open();
  socket().receive(welcome);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const presence = socket().sent.filter((m) => m.t === 'presence');
  assert.deepEqual(presence.at(-1), { t: 'presence', sessionId: 'sess1', visible: true });

  document.location.hash = '#/';
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(
    socket().sent.filter((m) => m.t === 'presence').at(-1),
    { t: 'presence', sessionId: 'sess1', visible: false },
  );
});

// ----------------------------------------------------------- transcript reload

const transcript = [
  { seq: 1, ts: 1, sessionId: 'sess1', type: 'turn_started', instructionId: 'i1', text: 'first question' },
  { seq: 2, ts: 2, sessionId: 'sess1', type: 'message', role: 'assistant', blockId: 'b1', text: 'first answer' },
];

test('leaving a session and returning restores the conversation', async (t) => {
  const { document, socket, history } = mountClient(t, '#/s/sess1');
  history.events = transcript;
  socket().open();
  socket().receive(welcome);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(document.getElementById('stream').textContent, /first answer/);

  // Go back to the list, then open the same session again. The old bug: the
  // client remembered the last sequence it had drawn, so the server replayed
  // nothing into the freshly-emptied stream and the chat appeared blank.
  document.location.hash = '#/';
  await new Promise((resolve) => setTimeout(resolve, 20));
  document.location.hash = '#/s/sess1';
  await new Promise((resolve) => setTimeout(resolve, 30));

  const stream = document.getElementById('stream');
  assert.match(stream.textContent, /first question/, 'the instruction is back');
  assert.match(stream.textContent, /first answer/, 'the reply is back');
  // Restored once, not twice.
  assert.equal(stream.textContent.match(/first answer/g).length, 1);
});

test('the reload control re-reads the transcript from the server', async (t) => {
  const { document, socket, fetchCalls, history } = mountClient(t, '#/s/sess1');
  history.events = transcript;
  socket().open();
  socket().receive(welcome);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const before = fetchCalls.filter((c) => String(c.url).includes('/events')).length;
  document.getElementById('header-refresh').click();
  await new Promise((resolve) => setTimeout(resolve, 30));

  const after = fetchCalls.filter((c) => String(c.url).includes('/events'));
  assert.equal(after.length, before + 1, 'refresh re-fetches the history');
  assert.match(after.at(-1).url, /since=0/, 'it reloads from the beginning');
  assert.match(document.getElementById('stream').textContent, /first answer/);
});

test('a session that ends while being watched keeps its transcript on screen', async (t) => {
  const { document, socket, history } = mountClient(t, '#/s/sess1');
  history.events = transcript;
  socket().open();
  socket().receive(welcome);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(document.getElementById('stream').textContent, /first answer/);

  // The composer is swapped for the reconnect bar, which re-renders the view.
  socket().receive({
    t: 'session',
    session: { ...welcome.sessions[0], state: 'exited', live: false, resumable: true },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.match(document.getElementById('stream').textContent, /first answer/, 'history survived the re-render');
});
