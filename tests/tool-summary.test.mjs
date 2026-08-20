import test from 'node:test';
import assert from 'node:assert/strict';

import { summariseToolInput } from '../dist/server/adapters/summary.js';

/**
 * This string is the entire content of an approval push notification, so
 * "renders as JSON" is a real bug: it asks someone to authorise a command they
 * cannot read on a lock screen.
 */

test('the shell command is the summary, whatever the CLI calls the parameter', () => {
  // Antigravity/Gemini spells it CommandLine; Claude Code spells it command.
  assert.equal(summariseToolInput('run_command', { CommandLine: 'rm -rf build' }, 300), 'rm -rf build');
  assert.equal(summariseToolInput('Bash', { command: 'npm test' }, 300), 'npm test');
  // Casing and separators must not decide whether a human can read this.
  assert.equal(summariseToolInput('x', { command_line: 'ls -la' }, 300), 'ls -la');
  assert.equal(summariseToolInput('x', { commandLine: 'ls -la' }, 300), 'ls -la');
});

test('file and search tools name their target', () => {
  assert.equal(summariseToolInput('view_file', { AbsolutePath: '/src/app.ts' }, 300), '/src/app.ts');
  assert.equal(summariseToolInput('Read', { file_path: '/src/app.ts' }, 300), '/src/app.ts');
  assert.equal(summariseToolInput('grep_search', { Query: 'TODO' }, 300), 'TODO');
  assert.equal(summariseToolInput('Grep', { pattern: 'TODO' }, 300), 'TODO');
  assert.equal(summariseToolInput('open_browser_url', { Url: 'https://example.com' }, 300), 'https://example.com');
});

test('what will run outranks how it is described', () => {
  const summary = summariseToolInput(
    'run_command',
    { CommandLine: 'git push --force', Description: 'Pushing the branch', Cwd: '/repo' },
    300,
  );
  assert.equal(summary, 'git push --force');
});

test('an unrecognised tool reads as prose, never as raw JSON', () => {
  // The regression: no key matched, so the phone displayed a serialised object.
  const summary = summariseToolInput('manage_task', { taskId: 'abc', status: 'done', archived: true }, 300);
  assert.equal(summary.includes('{'), false, 'no JSON braces reach the notification');
  assert.equal(summary.includes('"'), false, 'no JSON quoting reaches the notification');
  assert.match(summary, /taskId: abc/);
  assert.match(summary, /status: done/);

  // Arrays are counted rather than dumped.
  const todos = summariseToolInput('TodoWrite', { todos: [1, 2, 3] }, 300);
  assert.equal(todos, 'todos: 3 items');
  assert.equal(summariseToolInput('TodoWrite', { todos: [1] }, 300), 'todos: 1 item');
});

test('summaries stay on one line and within the caller’s budget', () => {
  const multiline = summariseToolInput('Bash', { command: 'echo one\n  echo two\n\techo three' }, 300);
  assert.equal(multiline, 'echo one echo two echo three');
  assert.equal(multiline.includes('\n'), false);

  const long = summariseToolInput('Bash', { command: 'x'.repeat(5000) }, 120);
  assert.ok(long.length < 300, `expected a clipped summary, got ${long.length} chars`);
});

test('a tool with nothing describable falls back to its own name', () => {
  assert.equal(summariseToolInput('finish', {}, 300), 'finish');
  assert.equal(summariseToolInput('finish', null, 300), 'finish');
  assert.equal(summariseToolInput('finish', { nested: { a: 1 } }, 300), 'finish');
  // Empty strings must not win over a usable name.
  assert.equal(summariseToolInput('finish', { command: '   ' }, 300), 'finish');
});
