import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHarness, collectEvents, waitFor } from './helpers.mjs';

test('session runs a turn and emits translated events', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const session = await h.sessions.create({ workspaceId: 'repo', createdBy: 'test@example.com' });
  const sink = collectEvents(session);

  await waitFor(() => sink.types().includes('session_started'), { label: 'session_started' });
  const started = sink.events.find((e) => e.type === 'session_started');
  assert.ok(started.cliSessionId, 'the CLI session id is captured for later resume');
  assert.equal(started.resumed, false);

  await session.instruct('TOOL BASH STREAM hello there', 'test@example.com');
  await waitFor(() => sink.types().includes('turn_finished'), { label: 'turn_finished' });

  const types = sink.types();
  for (const expected of [
    'turn_started',
    'message',
    'message_delta',
    'tool_use',
    'tool_result',
    'command_started',
    'command_finished',
    'turn_finished',
  ]) {
    assert.ok(types.includes(expected), `expected a ${expected} event, got ${[...new Set(types)].join(', ')}`);
  }

  const command = sink.events.find((e) => e.type === 'command_started');
  assert.equal(command.command, 'echo hi');
  const commandDone = sink.events.find((e) => e.type === 'command_finished');
  assert.equal(commandDone.isError, false);

  // Sequence numbers must be strictly increasing: reconnect relies on them.
  const seqs = sink.events.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);

  assert.equal(session.summary().state, 'idle');
  assert.equal(session.summary().workspaceId, 'repo');

  // Session survives a subscriber going away, and accepts another instruction.
  sink.unsubscribe();
  await session.instruct('second instruction', null);
  await waitFor(() => session.summary().state === 'idle' && session.lastSeq > seqs.at(-1), {
    label: 'second turn',
  });
});

test('cancel interrupts the turn but keeps the process usable', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const session = await h.sessions.create({ workspaceId: 'repo', createdBy: null });
  const sink = collectEvents(session);
  await waitFor(() => sink.types().includes('session_started'));

  await session.instruct('SLOW please take your time', null);
  await waitFor(() => session.summary().state === 'busy', { label: 'busy' });
  await waitFor(() => sink.events.some((e) => e.type === 'message' && e.text.includes('still working')), {
    label: 'streaming output',
  });

  const pidBefore = session.summary().pid;
  await session.cancel('test cancel');
  await waitFor(() => sink.types().includes('session_cancelled'), { label: 'session_cancelled' });
  await waitFor(() => session.summary().state === 'idle', { label: 'idle after cancel' });

  assert.equal(session.summary().pid, pidBefore, 'the CLI process is reused after a cancel');
  assert.equal(session.summary().pendingInstructions, 0);

  await session.instruct('after cancel', null);
  await waitFor(() => sink.events.some((e) => e.type === 'message' && e.text.includes('after cancel')), {
    label: 'post-cancel turn',
  });
});

test('terminate stops the process and the OS agrees it is gone', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const session = await h.sessions.create({ workspaceId: 'repo', createdBy: null });
  await waitFor(() => session.summary().state === 'idle');
  const pid = session.summary().pid;
  assert.ok(pid, 'a live session has a pid');

  await session.instruct('SLOW long task', null);
  await waitFor(() => session.summary().state === 'busy');

  await h.sessions.terminate(session.id, 'test');
  await waitFor(() => !session.summary().live, { label: 'session not live' });

  await waitFor(
    () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch (err) {
        return err.code === 'ESRCH';
      }
    },
    { label: 'process reaped' },
  );
});

test('a crashing CLI is detected and reported', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const session = await h.sessions.create({ workspaceId: 'repo', createdBy: null });
  const sink = collectEvents(session);
  await waitFor(() => session.summary().state === 'idle');

  await session.instruct('CRASH now', null);
  await waitFor(() => session.summary().state === 'crashed', { label: 'crashed state' });

  const error = sink.events.find((e) => e.type === 'error' && e.fatal);
  assert.ok(error, 'a fatal error event is emitted');
  assert.match(error.message, /exited unexpectedly/);

  const finished = sink.events.find((e) => e.type === 'session_finished');
  assert.equal(finished.reason, 'crashed');
  assert.equal(finished.code, 3);

  await assert.rejects(() => session.instruct('are you there?', null), /not running/);
});

test('a dead session can be resumed and reattaches to the CLI conversation', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const session = await h.sessions.create({ workspaceId: 'repo', createdBy: null });
  await waitFor(() => session.summary().cliSessionId, { label: 'cli session id' });
  const cliSessionId = session.summary().cliSessionId;

  await h.sessions.terminate(session.id, 'test');
  await waitFor(() => !session.summary().live);
  assert.equal(session.summary().resumable, true);

  await h.sessions.resume(session.id);
  await waitFor(() => session.summary().state === 'idle', { label: 'idle after resume' });
  assert.equal(session.summary().cliSessionId, cliSessionId, 'the CLI conversation id is preserved');

  await session.instruct('after resume', null);
  await waitFor(() => session.summary().state === 'idle' && session.summary().pendingInstructions === 0);
});

test('history survives a server restart and sessions come back as orphaned', async (t) => {
  const h = await buildHarness();
  const session = await h.sessions.create({ workspaceId: 'repo', createdBy: 'phone' });
  await waitFor(() => session.summary().state === 'idle');
  await session.instruct('remember me', null);
  await waitFor(() => session.summary().state === 'idle' && session.lastSeq > 3);
  const { id, lastSeq } = session.summary();
  session.flushPersist();

  // Simulate a backend restart against the same state directory.
  const { SessionManager } = await import('../dist/server/sessions/manager.js');
  const { SessionStore } = await import('../dist/server/sessions/store.js');
  await h.sessions.shutdown();

  const store2 = new SessionStore(h.config.stateDir, h.log);
  const manager2 = new SessionManager(h.config, h.log, h.workspaces, store2);
  await manager2.init();
  t.after(async () => {
    await manager2.shutdown();
    await h.close();
  });

  const restored = manager2.get(id);
  assert.equal(restored.summary().state, 'orphaned');
  assert.equal(restored.summary().live, false);
  assert.equal(restored.summary().resumable, true);
  assert.equal(restored.summary().createdBy, 'phone');

  const history = await restored.historySince(0, 500);
  assert.ok(history.events.length >= lastSeq - 1, 'persisted events are replayable after restart');
  assert.ok(history.events.some((e) => e.type === 'turn_started' && e.text.includes('remember me')));

  await manager2.resume(id);
  await waitFor(() => manager2.get(id).summary().state === 'idle', { label: 'resumed after restart' });
});

test('restored sessions never reuse sequence numbers already on disk', async (t) => {
  const h = await buildHarness();
  const session = await h.sessions.create({ workspaceId: 'repo', createdBy: null });
  await waitFor(() => session.summary().state === 'idle');
  await session.instruct('TOOL BASH first', null);
  await waitFor(() => session.summary().state === 'idle' && session.lastSeq > 5);
  const { id } = session.summary();
  session.flushPersist();
  await h.sessions.shutdown();

  const { SessionManager } = await import('../dist/server/sessions/manager.js');
  const { SessionStore } = await import('../dist/server/sessions/store.js');
  const fsp = await import('node:fs/promises');

  // Simulate metadata that lost the race with the event log at shutdown.
  const store = new SessionStore(h.config.stateDir, h.log);
  const metaPath = store.metaPath(id);
  const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
  const seqOnDisk = meta.lastSeq;
  assert.ok(seqOnDisk > 2, 'the log has more than a couple of events');
  await fsp.writeFile(metaPath, JSON.stringify({ ...meta, lastSeq: 2 }));

  const manager = new SessionManager(h.config, h.log, h.workspaces, store);
  await manager.init();
  t.after(async () => {
    await manager.shutdown();
    await h.close();
  });

  const restored = manager.get(id);
  assert.equal(restored.lastSeq, seqOnDisk, 'the on-disk log wins over stale metadata');

  await manager.resume(id);
  await waitFor(() => manager.get(id).summary().state === 'idle');
  await restored.instruct('second run', null);
  await waitFor(() => restored.summary().state === 'idle' && restored.summary().pendingInstructions === 0);
  restored.flushPersist();
  await new Promise((r) => setTimeout(r, 150));

  const log = await fsp.readFile(store.eventsPath(id), 'utf8');
  const seqs = log
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).seq);
  assert.equal(new Set(seqs).size, seqs.length, 'no duplicate sequence numbers in the persisted log');
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'the log stays ordered');
});

test('concurrent session limit is enforced', async (t) => {
  const h = await buildHarness({ MAX_CONCURRENT_SESSIONS: '2' });
  t.after(() => h.close());

  await h.sessions.create({ workspaceId: 'repo', createdBy: null });
  await h.sessions.create({ workspaceId: 'repo', createdBy: null });
  await assert.rejects(() => h.sessions.create({ workspaceId: 'repo', createdBy: null }), /Maximum of 2/);

  assert.equal(h.sessions.liveCount, 2);
});

test('sessions cannot be created for unregistered or disabled workspaces', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  await assert.rejects(() => h.sessions.create({ workspaceId: 'off', createdBy: null }), /disabled/);
  await assert.rejects(() => h.sessions.create({ workspaceId: 'nope', createdBy: null }), /Unknown workspace/);
  await assert.rejects(() => h.sessions.create({ workspaceId: h.other, createdBy: null }), /Unknown workspace/);
  await assert.rejects(() => h.sessions.create({ workspaceId: '../repo', createdBy: null }), /Unknown workspace/);
  assert.equal(h.sessions.liveCount, 0);
});

test('oversized CLI output terminates the session instead of exhausting memory', async (t) => {
  const h = await buildHarness({ MAX_SESSION_OUTPUT_BYTES: String(2 * 1024 * 1024) });
  t.after(() => h.close());

  const session = await h.sessions.create({ workspaceId: 'repo', createdBy: null });
  const sink = collectEvents(session);
  await waitFor(() => session.summary().state === 'idle');

  await session.instruct('FLOOD me', null);
  await waitFor(() => sink.events.some((e) => e.type === 'error' && /maximum output size/.test(e.message)), {
    label: 'output limit error',
    timeout: 15000,
  });
  await waitFor(() => !session.summary().live, { label: 'session stopped' });
});

test('long text in a single event is truncated', async (t) => {
  const h = await buildHarness({ MAX_EVENT_TEXT_CHARS: '500' });
  t.after(() => h.close());

  const session = await h.sessions.create({ workspaceId: 'repo', createdBy: null });
  const sink = collectEvents(session);
  await waitFor(() => session.summary().state === 'idle');

  await session.instruct('x'.repeat(3000), null);
  await waitFor(() => sink.events.some((e) => e.type === 'message' && e.truncated), { label: 'truncated message' });

  const message = sink.events.find((e) => e.type === 'message' && e.truncated);
  assert.ok(message.text.length < 700, 'the stored text stays close to the configured limit');
  assert.match(message.text, /truncated \d+ characters/);
});

test('garbage on the CLI stream is reported without killing the session', async (t) => {
  const h = await buildHarness();
  t.after(() => h.close());

  const session = await h.sessions.create({ workspaceId: 'repo', createdBy: null });
  const sink = collectEvents(session);
  await waitFor(() => session.summary().state === 'idle');

  await session.instruct('GARBAGE test', null);
  await waitFor(() => sink.events.some((e) => e.type === 'error' && /Unparseable/.test(e.message)), {
    label: 'parse error event',
  });
  await waitFor(() => session.summary().state === 'idle', { label: 'still usable' });
  assert.equal(session.summary().live, true);
});
