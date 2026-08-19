#!/usr/bin/env node
/**
 * A stand-in for the Claude Code CLI that speaks the same stream-json protocol.
 * Tests drive it through the real adapter, so the adapter's parsing, cancel and
 * crash handling are exercised without spending API calls.
 *
 * Instruction keywords:
 *   SLOW    - a long turn that only ends on interrupt
 *   TOOL    - emits tool_use + tool_result (Read)
 *   BASH    - emits tool_use + tool_result for Bash (command lifecycle)
 *   CRASH   - the process exits non-zero mid-turn
 *   FLOOD   - emits a very large amount of output
 *   GARBAGE - emits a line that is not valid JSON
 *   STREAM  - emits partial-message deltas before the final text
 *   ASK     - requests tool permission and waits for the control_response
 */
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const resumeIndex = args.indexOf('--resume');
const sessionId = resumeIndex !== -1 ? args[resumeIndex + 1] : randomUUID();
const modelIndex = args.indexOf('--model');
const model = modelIndex !== -1 ? args[modelIndex + 1] : 'fake-model-1';

let seq = 0;
let interrupted = false;
let activeTurn = null;
/** request_id -> resolver, for pending can_use_tool requests. */
const pendingPermissions = new Map();

function emit(obj) {
  process.stdout.write(JSON.stringify({ ...obj, session_id: sessionId, uuid: `u${++seq}` }) + '\n');
}

emit({ type: 'system', subtype: 'init', model, cwd: process.cwd(), tools: ['Read', 'Bash'] });

function finishTurn(subtype, result) {
  activeTurn = null;
  emit({
    type: 'result',
    subtype,
    is_error: subtype !== 'success',
    result,
    duration_ms: 12,
    num_turns: 1,
    total_cost_usd: 0.0001,
  });
}

function assistantText(text) {
  emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
}

async function runTurn(text) {
  interrupted = false;

  if (text.includes('ASK')) {
    const requestId = `req-${randomUUID()}`;
    const decision = await new Promise((resolve) => {
      pendingPermissions.set(requestId, resolve);
      emit({
        type: 'control_request',
        request_id: requestId,
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          display_name: 'Bash',
          input: { command: 'rm -rf ./build', description: 'Clean the build directory' },
          description: 'Clean the build directory',
        },
      });
    });
    if (decision.behavior === 'allow') {
      assistantText('permission granted, running the command');
    } else {
      assistantText(`permission denied: ${decision.message ?? ''}`);
    }
    finishTurn('success', 'asked and answered');
    return;
  }

  if (text.includes('GARBAGE')) process.stdout.write('this is not json\n');

  if (text.includes('STREAM')) {
    // Faithful to the real CLI: one API message whose blocks are numbered
    // (thinking = 0, text = 1) while streaming, but delivered afterwards as
    // separate single-block `assistant` events. Getting this wrong is what
    // made every reply render twice.
    const messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    emit({ type: 'stream_event', event: { type: 'message_start', message: { id: messageId, role: 'assistant', content: [] } } });
    for (const piece of ['I should ', 'greet them.']) {
      emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: piece } } });
    }
    for (const piece of ['Hel', 'lo ', 'wor', 'ld']) {
      emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: piece } } });
    }
    emit({
      type: 'assistant',
      message: { id: messageId, role: 'assistant', content: [{ type: 'thinking', thinking: 'I should greet them.' }] },
    });
    emit({
      type: 'assistant',
      message: { id: messageId, role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
    });
  }

  if (text.includes('TOOL')) {
    const id = `toolu_${randomUUID()}`;
    emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/tmp/example.txt' } }] },
    });
    emit({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: 'file contents' }] },
    });
  }

  if (text.includes('BASH')) {
    const id = `toolu_${randomUUID()}`;
    emit({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'echo hi', description: 'say hi' } }] },
    });
    emit({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: 'hi\n' }] },
    });
  }

  if (text.includes('FLOOD')) {
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 64; i++) assistantText(chunk);
  }

  if (text.includes('CRASH')) {
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'about to crash' }] } }) + '\n');
    setTimeout(() => process.exit(3), 10);
    return;
  }

  if (text.includes('SLOW')) {
    activeTurn = new Promise((resolve) => {
      const started = Date.now();
      const tick = setInterval(() => {
        if (interrupted) {
          clearInterval(tick);
          finishTurn('error_during_execution', undefined);
          resolve();
          return;
        }
        if (Date.now() - started > 60_000) {
          clearInterval(tick);
          finishTurn('success', 'slow turn finished');
          resolve();
          return;
        }
        assistantText('still working…');
      }, 100);
    });
    await activeTurn;
    return;
  }

  assistantText(`echo: ${text}`);
  finishTurn('success', `echo: ${text}`);
}

const rl = readline.createInterface({ input: process.stdin });
let queue = Promise.resolve();

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.type === 'control_response') {
    const requestId = msg.response?.request_id;
    const resolve = pendingPermissions.get(requestId);
    if (resolve) {
      pendingPermissions.delete(requestId);
      resolve(msg.response?.response ?? { behavior: 'deny' });
    }
    return;
  }

  if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
    interrupted = true;
    emit({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
    return;
  }

  if (msg.type === 'user') {
    const text = (msg.message?.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    queue = queue.then(() => runTurn(text));
  }
});

rl.on('close', () => {
  setTimeout(() => process.exit(0), 10);
});
