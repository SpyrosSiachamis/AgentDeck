#!/usr/bin/env node
/**
 * Stand-in for the Gemini CLI. Mirrors the real one's contract: read the prompt
 * from stdin to EOF, emit its stream-json events on stdout, then exit.
 *
 * Instruction keywords:
 *   SLOW    - keeps running until it is killed
 *   TOOL    - emits tool_use + tool_result
 *   SHELL   - emits a run_shell_command tool pair (command lifecycle)
 *   FAIL    - exits non-zero after writing to stderr, like an auth failure
 *   NORESULT- exits 0 without emitting a result event
 *   GARBAGE - writes a line that is not valid JSON
 *   DELTA   - streams the reply as delta messages
 */
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const at = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

// Resuming must preserve the conversation id, exactly like the real CLI.
const sessionId = at('--resume') ?? randomUUID();
const model = at('--model') ?? 'fake-gemini-1';

const emit = (event) =>
  process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + '\n');

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  prompt += chunk;
});

process.stdin.on('end', () => {
  void run(prompt);
});

async function run(text) {
  emit({ type: 'init', session_id: sessionId, model });
  // The real CLI echoes the prompt back as a user message.
  emit({ type: 'message', role: 'user', content: text });

  if (text.includes('GARBAGE')) process.stdout.write('not json at all\n');

  if (text.includes('TOOL')) {
    const id = `tool-${randomUUID()}`;
    emit({ type: 'tool_use', tool_name: 'read_file', tool_id: id, parameters: { absolute_path: '/tmp/example.txt' } });
    emit({ type: 'tool_result', tool_id: id, status: 'success', output: 'file contents' });
  }

  if (text.includes('SHELL')) {
    const id = `tool-${randomUUID()}`;
    emit({
      type: 'tool_use',
      tool_name: 'run_shell_command',
      tool_id: id,
      parameters: { command: 'echo hi', description: 'say hi' },
    });
    emit({ type: 'tool_result', tool_id: id, status: 'success', output: 'hi\n' });
  }

  if (text.includes('DELTA')) {
    for (const piece of ['Hel', 'lo ', 'there']) {
      emit({ type: 'message', role: 'assistant', content: piece, delta: true });
    }
  }

  if (text.includes('FAIL')) {
    process.stderr.write('This account requires setting the GOOGLE_CLOUD_PROJECT env var.\n');
    process.exit(41);
  }

  if (text.includes('SLOW')) {
    // Stay alive until killed; the parent's cancel path is what ends this.
    setInterval(() => emit({ type: 'message', role: 'assistant', content: 'still working…' }), 100);
    return;
  }

  emit({ type: 'message', role: 'assistant', content: `echo: ${text.trim()}` });

  if (text.includes('NORESULT')) process.exit(0);

  emit({
    type: 'result',
    status: 'success',
    stats: { total_tokens: 12, input_tokens: 8, output_tokens: 4, cached: 0, input: 8, duration_ms: 15, tool_calls: 0 },
  });
  process.exit(0);
}
