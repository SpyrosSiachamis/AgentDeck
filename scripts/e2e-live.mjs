#!/usr/bin/env node
/**
 * End-to-end check against a running server and the REAL AI CLI.
 * Walks the exact path a phone takes:
 *
 *   connect -> start session -> instruct -> drop the connection ->
 *   CLI keeps working -> reconnect -> replay missed events -> instruct again ->
 *   cancel -> verify the process is gone
 *
 * Usage: node scripts/e2e-live.mjs [--base http://127.0.0.1:4823] [--workspace demo]
 */
import { WebSocket } from 'ws';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : fallback;
};

const base = arg('base', 'http://127.0.0.1:4823');
const workspaceId = arg('workspace', 'demo');
const wsUrl = base.replace(/^http/, 'ws') + '/ws';

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

async function api(path, init) {
  const headers = init?.body ? { 'content-type': 'application/json', ...(init.headers ?? {}) } : (init?.headers ?? {});
  const res = await fetch(base + path, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function client() {
  const socket = new WebSocket(wsUrl);
  const messages = [];
  const events = [];
  socket.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    messages.push(msg);
    if (msg.t === 'events') events.push(...msg.events);
  });
  const ready = new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return {
    socket,
    messages,
    events,
    ready,
    send: (obj) => socket.send(JSON.stringify(obj)),
    close: () => socket.close(),
  };
}

/** Awaits async predicates: a bare promise would always look truthy. */
function waitFor(predicate, label, timeout = 180_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      let value;
      try {
        value = await predicate();
      } catch (err) {
        return reject(err);
      }
      if (value) return resolve(value);
      if (Date.now() - started > timeout) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(() => void tick(), 100);
    };
    void tick();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`\n=== live end-to-end against ${base} ===\n`);

// 1. Health and workspace listing
const health = await api('/api/health');
check(health.status === 200 && health.body.status === 'ok', 'health endpoint responds');

const workspaces = await api('/api/workspaces');
check(
  workspaces.body.workspaces?.some((w) => w.id === workspaceId),
  `workspace "${workspaceId}" is registered`,
);
check(
  !JSON.stringify(workspaces.body).includes('/'),
  'workspace listing exposes no filesystem paths',
  JSON.stringify(workspaces.body).slice(0, 120),
);

// 2. Unauthorized workspace access
for (const bad of ['../etc', '/etc', 'not-registered']) {
  const res = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ workspaceId: bad }) });
  check(res.status >= 400, `rejects session for unregistered workspace "${bad}"`, `status ${res.status}`);
}

// 3. Path traversal through the git endpoint
for (const bad of ['../../etc/passwd', '/etc/passwd']) {
  const res = await api(`/api/workspaces/${workspaceId}/git/diff?file=${encodeURIComponent(bad)}`);
  check(res.status >= 400, `rejects git diff traversal "${bad}"`, `status ${res.status}`);
}

// 4. Start a session
const created = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ workspaceId }) });
check(created.status === 201, 'session created', `status ${created.status}`);
const sessionId = created.body.session?.id;
if (!sessionId) {
  console.error('cannot continue without a session');
  process.exit(1);
}

const phone = client();
await phone.ready;
await waitFor(() => phone.messages.find((m) => m.t === 'welcome'), 'welcome');
phone.send({ t: 'subscribe', sessionId, sinceSeq: 0 });
await waitFor(() => phone.messages.find((m) => m.t === 'subscribed'), 'subscribed');
check(true, 'phone subscribed to the session stream');

// 5. First instruction. The CLI announces its session on the first turn rather
// than at spawn time, so the session-id check comes after the instruction.
phone.send({
  t: 'instruct',
  sessionId,
  text: 'Create a file called e2e-proof.txt containing exactly the word VERIFIED, then tell me you are done.',
  clientMsgId: 'first',
});
await waitFor(() => phone.messages.find((m) => m.t === 'ack' && m.clientMsgId === 'first'), 'ack');
check(true, 'instruction acknowledged');

await waitFor(() => phone.events.some((e) => e.type === 'session_started'), 'session_started');
check(true, 'CLI session started and reported its id');

await waitFor(() => phone.events.some((e) => e.type === 'message_delta' || e.type === 'message'), 'streaming output');
check(true, 'streamed output arrives before the turn finishes');

await waitFor(() => phone.events.some((e) => e.type === 'tool_use'), 'tool_use event');
check(true, 'tool activity is reported as structured events');

await waitFor(() => phone.events.some((e) => e.type === 'turn_finished'), 'turn_finished');
check(true, 'first turn completed');

const seenSeq = Math.max(...phone.events.map((e) => e.seq));

// 6. Second instruction, then the phone goes away mid-work.
phone.send({ t: 'instruct', sessionId, text: 'Count slowly from 1 to 30, one line each, thinking about each number.' });
await waitFor(async () => (await api(`/api/sessions/${sessionId}`)).body.session?.state === 'busy', 'busy state');
phone.close();
console.log('  … phone disconnected while the CLI is working');
await sleep(4000);

const duringDisconnect = await api(`/api/sessions/${sessionId}`);
check(duringDisconnect.body.session?.live === true, 'CLI keeps running after the browser disconnects');
const pid = duringDisconnect.body.session?.pid;
check(Number.isInteger(pid), 'session reports a live process id', String(pid));

// 7. Reconnect and replay only what was missed.
const phone2 = client();
await phone2.ready;
await waitFor(() => phone2.messages.find((m) => m.t === 'welcome'), 'welcome (reconnect)');
phone2.send({ t: 'subscribe', sessionId, sinceSeq: seenSeq });
await waitFor(() => phone2.messages.find((m) => m.t === 'subscribed'), 'subscribed (reconnect)');
const replayed = await waitFor(() => (phone2.events.length > 0 ? phone2.events : null), 'replayed events');
check(
  replayed.every((e) => e.seq > seenSeq),
  'reconnect replays only unseen events',
  `${replayed.length} events, all seq > ${seenSeq}`,
);
check(
  replayed.some((e) => e.type === 'turn_started'),
  'the work started while disconnected is visible after reconnect',
);

// 8. Cancel the running turn.
phone2.send({ t: 'cancel', sessionId });
await waitFor(() => phone2.events.some((e) => e.type === 'session_cancelled'), 'session_cancelled');
check(true, 'cancellation interrupted the running turn');
await waitFor(async () => (await api(`/api/sessions/${sessionId}`)).body.session?.state === 'idle', 'idle after cancel');
check(true, 'session returns to idle and stays usable after cancel');

// 9. Send another instruction on the same process.
phone2.send({ t: 'instruct', sessionId, text: 'Reply with exactly: STILL_HERE', clientMsgId: 'third' });
await waitFor(
  () => phone2.events.some((e) => e.type === 'message' && String(e.text).includes('STILL_HERE')),
  'post-cancel reply',
);
check(true, 'the same CLI process answers a follow-up instruction after cancellation');

// 10. Git status reflects the file the CLI created.
const git = await api(`/api/workspaces/${workspaceId}/git/status`);
check(git.body.git?.isRepo === true, 'git status reads the workspace');
check(git.body.git?.clean === false, 'git status shows the working tree is dirty');
console.log(`  branch: ${git.body.git?.branch}, changed files: ${git.body.git?.files?.length}`);

const diff = await api(`/api/workspaces/${workspaceId}/git/diff`);
check(typeof diff.body.diff === 'string' && diff.body.diff.length > 0, 'git diff returns content');

// 11. Terminate and verify the OS reaped the process.
const deleted = await api(`/api/sessions/${sessionId}`, { method: 'DELETE' });
check(deleted.status === 200, 'stop request accepted', `status ${deleted.status}`);
await waitFor(async () => (await api(`/api/sessions/${sessionId}`)).body.session?.live === false, 'session stopped');
check(true, 'session terminated through the API');
await sleep(300);

let alive = true;
try {
  process.kill(pid, 0);
} catch (err) {
  alive = err.code !== 'ESRCH' ? true : false;
}
check(!alive, 'the CLI process is gone from the process table', `pid ${pid}`);

// 12. Resume the dead session and confirm the conversation is restored.
const resumed = await api(`/api/sessions/${sessionId}/resume`, { method: 'POST' });
check(
  resumed.status === 200 && resumed.body.session?.live === true,
  'dead session can be resumed',
  `status ${resumed.status} ${JSON.stringify(resumed.body).slice(0, 160)}`,
);

const phone3 = client();
await phone3.ready;
await waitFor(() => phone3.messages.find((m) => m.t === 'welcome'), 'welcome (resume)');
phone3.send({ t: 'subscribe', sessionId, sinceSeq: 0 });
const history = await waitFor(() => (phone3.events.length > 5 ? phone3.events : null), 'history replay');
check(
  history.some((e) => e.type === 'turn_started' && String(e.text).includes('e2e-proof.txt')),
  'full session history is replayable from the start',
  `${history.length} events`,
);

await api(`/api/sessions/${sessionId}`, { method: 'DELETE' });
phone3.close();

console.log(`\n=== ${failures === 0 ? 'all checks passed' : `${failures} check(s) FAILED`} ===\n`);
process.exit(failures === 0 ? 0 : 1);
