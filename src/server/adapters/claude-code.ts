import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { buildChildEnv } from './env.js';
import { truncateText, type SessionEventBody } from '../sessions/events.js';
import { normalizePermissionMode } from './types.js';
import type {
  AdapterEventHandler,
  PermissionDecision,
  AdapterOptions,
  AdapterState,
  AdapterStateHandler,
  AdapterStatus,
  CLIAdapter,
  CLIAdapterFactory,
} from './types.js';

/**
 * Adapter for the Claude Code CLI's documented headless interface:
 *
 *   claude -p --input-format stream-json --output-format stream-json --verbose
 *
 * One long-lived process serves the whole session. Instructions are written to
 * stdin as JSON lines; structured events are read from stdout as JSON lines.
 * Terminal output is never scraped.
 */

type Json = Record<string, unknown>;

const CANCEL_RESULT_SUBTYPES = new Set(['error_during_execution']);

/** Tools whose invocation is also reported as a shell command lifecycle. */
const COMMAND_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell']);

/** Values the CLI accepts directly, so provider-specific modes still work. */
const CLAUDE_NATIVE_MODES = new Set([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'manual',
  'auto',
  'dontAsk',
]);

const PERMISSION_FLAG: Record<string, string> = {
  default: 'default',
  acceptEdits: 'acceptEdits',
  full: 'bypassPermissions',
};

export class ClaudeCodeAdapter implements CLIAdapter {
  readonly id = 'claude-code';
  /** The CLI asks over its control channel, so approvals are supported. */
  readonly supportsPermissionPrompts = true;

  private child: ChildProcessWithoutNullStreams | null = null;
  private onEvent: AdapterEventHandler = () => {};
  private onState: AdapterStateHandler = () => {};

  private status: AdapterStatus = 'starting';
  private cliSessionId: string | null = null;
  private model: string | null = null;
  private pid: number | null = null;
  private startedAt: number | null = null;
  private lastActivityAt = Date.now();
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private bytesOut = 0;

  private stdoutBuffer = '';
  private stderrBuffer = '';
  private outputLimitHit = false;
  private terminating = false;
  private cancelTimer: NodeJS.Timeout | null = null;
  private controlSeq = 0;
  /** Message id announced by the most recent message_start stream event. */
  private currentMessageId: string | null = null;
  /** tool_use_id -> tool name, so tool_result can be classified. */
  private readonly toolNames = new Map<string, string>();
  /** message id -> next content block index, to match streamed deltas. */
  private readonly blockIndexByMessage = new Map<string, number>();
  /** Permission requests the CLI is waiting on, keyed by its request id. */
  private readonly pendingPermissions = new Map<string, { toolName: string; input: unknown }>();
  private lastErrorMessage: string | null = null;
  private exitPromise: Promise<void> | null = null;
  private resolveExit: (() => void) | null = null;

  constructor(
    private readonly command: string,
    private readonly options: AdapterOptions,
  ) {}

  getStatus(): AdapterState {
    return Object.freeze({
      status: this.status,
      cliSessionId: this.cliSessionId,
      pid: this.pid,
      model: this.model,
      startedAt: this.startedAt,
      lastActivityAt: this.lastActivityAt,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
      bytesOut: this.bytesOut,
    });
  }

  streamEvents(onEvent: AdapterEventHandler, onState: AdapterStateHandler): void {
    this.onEvent = onEvent;
    this.onState = onState;
  }

  private buildArgs(): string[] {
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      // Keep the session isolated from the operator's own MCP servers and
      // per-project settings, which may carry credentials.
      '--strict-mcp-config',
      '--setting-sources',
      '',
      // Route tool-permission questions to us over the control channel instead
      // of a terminal prompt nobody can answer from a phone.
      '--permission-prompt-tool',
      'stdio',
    ];
    if (this.options.model) args.push('--model', this.options.model);

    const requested = this.options.permissionMode ?? 'default';
    const mode = CLAUDE_NATIVE_MODES.has(requested)
      ? requested
      : (PERMISSION_FLAG[normalizePermissionMode(requested)] ?? 'default');
    // "default" is the CLI's own default and the mode in which it actually asks
    // before running a risky tool, so it is left unset rather than passed.
    if (mode !== 'default') args.push('--permission-mode', mode);
    if (this.options.resumeCliSessionId) args.push('--resume', this.options.resumeCliSessionId);
    return args;
  }

  async startSession(): Promise<void> {
    if (this.child) throw new Error('session already started');
    this.setStatus('starting');

    const child = spawn(this.command, this.buildArgs(), {
      cwd: this.options.cwd,
      env: buildChildEnv(process.env, {
        extraAllow: (process.env.CLI_FORWARD_ENV ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group: killing the group also reaps whatever the CLI spawned.
      detached: process.platform !== 'win32',
    }) as ChildProcessWithoutNullStreams;

    this.child = child;
    this.pid = child.pid ?? null;
    this.startedAt = Date.now();
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.handleStderr(chunk));

    child.stdin.on('error', (err) => {
      // EPIPE after the process is gone is expected; anything else is surfaced.
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        this.emit({ type: 'error', message: 'CLI stdin error', detail: err.message, fatal: false });
      }
    });

    child.on('error', (err) => {
      this.exitCode = null;
      this.setStatus('crashed');
      this.emit({
        type: 'error',
        message: `Failed to start CLI process: ${err.message}`,
        detail: `command: ${this.command}`,
        fatal: true,
      });
      this.emit({ type: 'session_finished', reason: 'spawn_failed', code: null, signal: null });
      this.resolveExit?.();
    });

    child.on('exit', (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
      this.pid = null;
      if (this.cancelTimer) {
        clearTimeout(this.cancelTimer);
        this.cancelTimer = null;
      }
      const clean = this.terminating || code === 0;
      this.setStatus(clean ? 'exited' : 'crashed');
      if (!clean) {
        this.emit({
          type: 'error',
          message: `CLI process exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
          detail: this.stderrBuffer.slice(-2000) || this.lastErrorMessage || undefined,
          fatal: true,
        });
      }
      this.failPendingPermissions('the CLI process ended');
      this.emit({
        type: 'session_finished',
        reason: this.terminating ? 'terminated' : clean ? 'exited' : 'crashed',
        code,
        signal,
      });
      this.resolveExit?.();
    });

    // A spawn failure surfaces asynchronously; give it a tick so obvious
    // misconfiguration (missing binary) fails fast at start time.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    if (this.status === 'crashed') throw new Error(this.lastErrorMessage || 'CLI process failed to start');
    if (this.status === 'starting') this.setStatus('idle');
  }

  async sendInstruction(text: string): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.killed) {
      throw new Error('CLI process is not running');
    }
    const payload = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
    this.setStatus('busy');
    this.touch();
    await this.write(child, JSON.stringify(payload) + '\n');
  }

  private write(child: ChildProcessWithoutNullStreams, line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      child.stdin.write(line, (err) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * Cancellation is cooperative first: the CLI's control channel interrupts the
   * turn but keeps the conversation alive, so the user can send a follow-up.
   * If the process does not settle, escalate to signals.
   */
  async cancel(reason: string): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    if (this.status !== 'busy' && this.status !== 'cancelling') {
      this.emit({ type: 'session_cancelled', reason: `${reason} (no active turn)` });
      return;
    }
    this.setStatus('cancelling');

    const requestId = `ta-int-${++this.controlSeq}`;
    try {
      await this.write(
        child,
        JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } }) + '\n',
      );
    } catch (err) {
      this.emit({
        type: 'error',
        message: `Interrupt could not be delivered: ${(err as Error).message}`,
        fatal: false,
      });
    }

    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    this.cancelTimer = setTimeout(() => {
      if (this.status === 'cancelling' && this.child) {
        this.emit({
          type: 'notice',
          message: 'CLI did not honour the interrupt in time; terminating the process.',
        });
        void this.terminate('cancel_escalation');
      }
    }, this.options.limits.cancelGraceMs);
    this.cancelTimer.unref?.();
  }

  async terminate(reason: string): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (this.terminating) {
      await this.exitPromise;
      return;
    }
    this.terminating = true;
    if (this.cancelTimer) {
      clearTimeout(this.cancelTimer);
      this.cancelTimer = null;
    }

    // Closing stdin is the CLI's documented shutdown path.
    try {
      child.stdin.end();
    } catch {
      /* already closed */
    }

    const killAfter = setTimeout(() => this.signalTree(child, 'SIGTERM'), Math.min(1500, this.options.limits.cancelGraceMs));
    killAfter.unref?.();
    const hardKill = setTimeout(() => this.signalTree(child, 'SIGKILL'), this.options.limits.cancelGraceMs);
    hardKill.unref?.();

    await this.exitPromise;
    clearTimeout(killAfter);
    clearTimeout(hardKill);
    this.emit({ type: 'notice', message: `Session terminated (${reason}).` });
  }

  private signalTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    if (child.exitCode !== null) return;
    try {
      if (process.platform !== 'win32' && child.pid) {
        // Negative pid targets the process group, reaping CLI-spawned children.
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }

  // ---------------------------------------------------------------- streaming

  private handleStderr(chunk: string): void {
    this.stderrBuffer = (this.stderrBuffer + chunk).slice(-8000);
  }

  private handleStdout(chunk: string): void {
    this.bytesOut += Buffer.byteLength(chunk);
    this.touch();

    if (this.bytesOut > this.options.limits.maxSessionOutputBytes && !this.outputLimitHit) {
      this.outputLimitHit = true;
      this.emit({
        type: 'error',
        message: 'Session exceeded its maximum output size and was terminated.',
        detail: `${this.bytesOut} bytes > ${this.options.limits.maxSessionOutputBytes}`,
        fatal: true,
      });
      void this.terminate('output_limit');
      return;
    }

    this.stdoutBuffer += chunk;

    // A single absurdly long line means the stream is not what we expect; drop
    // the buffer rather than growing it without bound.
    if (this.stdoutBuffer.length > this.options.limits.maxEventLineBytes) {
      this.stdoutBuffer = '';
      this.emit({
        type: 'error',
        message: 'Discarded an oversized line from the CLI output stream.',
        fatal: false,
      });
      return;
    }

    let index: number;
    while ((index = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line) this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emit({
        type: 'error',
        message: 'Unparseable line from CLI output stream',
        detail: line.slice(0, 500),
        fatal: false,
      });
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    this.translate(parsed as Json);
  }

  private translate(msg: Json): void {
    const type = typeof msg['type'] === 'string' ? (msg['type'] as string) : '';

    switch (type) {
      case 'system':
        this.translateSystem(msg);
        return;
      case 'assistant':
        this.translateAssistant(msg);
        return;
      case 'user':
        this.translateUser(msg);
        return;
      case 'stream_event':
        this.translateStreamEvent(msg);
        return;
      case 'result':
        this.translateResult(msg);
        return;
      case 'control_request':
        this.translateControlRequest(msg);
        return;
      case 'control_response':
      case 'rate_limit_event':
        return; // protocol chatter, not user-visible
      default:
        return;
    }
  }

  /**
   * The CLI asks permission by sending us a control_request; the turn blocks
   * until we answer, so every request must end in exactly one response.
   */
  private translateControlRequest(msg: Json): void {
    const request = msg['request'];
    const requestId = typeof msg['request_id'] === 'string' ? msg['request_id'] : null;
    if (!requestId || !request || typeof request !== 'object') return;
    const req = request as Json;
    if (req['subtype'] !== 'can_use_tool') return;

    const toolName = String(req['tool_name'] ?? 'tool');
    const input = req['input'];
    this.pendingPermissions.set(requestId, { toolName, input });

    const command =
      input && typeof input === 'object' && typeof (input as Json)['command'] === 'string'
        ? ((input as Json)['command'] as string)
        : undefined;

    this.emit({
      type: 'permission_request',
      requestId,
      toolName,
      displayName: typeof req['display_name'] === 'string' ? (req['display_name'] as string) : toolName,
      summary: summariseToolInput(toolName, input, 300),
      command: command ? truncateText(command, 4000).text : undefined,
      input: compactInput(input, this.options.limits.maxEventTextChars),
    });
  }

  async respondToPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) throw new Error('no such pending permission request');
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.pendingPermissions.delete(requestId);
      throw new Error('CLI process is not running');
    }

    const response =
      decision.decision === 'allow'
        ? { behavior: 'allow', updatedInput: pending.input }
        : { behavior: 'deny', message: decision.reason || 'Denied by the user.' };

    await this.write(
      child,
      JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response },
      }) + '\n',
    );
    this.pendingPermissions.delete(requestId);
  }

  /** Deny anything still outstanding so the CLI is never left waiting. */
  private failPendingPermissions(reason: string): void {
    for (const requestId of [...this.pendingPermissions.keys()]) {
      this.pendingPermissions.delete(requestId);
      this.emit({
        type: 'permission_resolved',
        requestId,
        decision: 'deny',
        decidedBy: null,
        reason,
      });
    }
  }

  private translateSystem(msg: Json): void {
    if (msg['subtype'] !== 'init') return;
    const sessionId = typeof msg['session_id'] === 'string' ? msg['session_id'] : null;
    const model = typeof msg['model'] === 'string' ? msg['model'] : null;
    const first = this.cliSessionId === null;
    this.cliSessionId = sessionId ?? this.cliSessionId;
    this.model = model ?? this.model;
    if (first) {
      this.emit({
        type: 'session_started',
        cliSessionId: this.cliSessionId,
        model: this.model,
        resumed: Boolean(this.options.resumeCliSessionId),
      });
      this.onState(this.getStatus());
    }
  }

  private contentBlocks(msg: Json): Json[] {
    const message = msg['message'];
    if (!message || typeof message !== 'object') return [];
    const content = (message as Json)['content'];
    return Array.isArray(content) ? (content.filter((c) => c && typeof c === 'object') as Json[]) : [];
  }

  private translateAssistant(msg: Json): void {
    const max = this.options.limits.maxEventTextChars;
    const message = (msg['message'] ?? {}) as Json;
    const messageId = typeof message['id'] === 'string' ? message['id'] : String(msg['uuid'] ?? 'msg');

    // The CLI splits one API message into several `assistant` events, each
    // carrying a single content block, so a block's position inside the event
    // is always 0. Streaming deltas, however, are numbered by their true index
    // within the message. Counting blocks per message id recovers that index —
    // without it the streamed text and the final text get different block ids
    // and the UI renders the same reply twice.
    let index = (this.blockIndexByMessage.get(messageId) ?? 0) - 1;
    for (const block of this.contentBlocks(msg)) {
      index += 1;
      this.blockIndexByMessage.set(messageId, index + 1);
      const blockType = block['type'];
      if (blockType === 'text') {
        const { text, truncated } = truncateText(String(block['text'] ?? ''), max);
        if (!text) continue;
        this.emit({ type: 'message', role: 'assistant', blockId: `${messageId}:${index}`, text, truncated });
      } else if (blockType === 'thinking') {
        const { text, truncated } = truncateText(String(block['thinking'] ?? ''), max);
        if (!text) continue;
        this.emit({ type: 'thinking', blockId: `${messageId}:${index}`, text, truncated });
      } else if (blockType === 'tool_use') {
        const toolUseId = String(block['id'] ?? randomUUID());
        const name = String(block['name'] ?? 'tool');
        const input = block['input'];
        this.toolNames.set(toolUseId, name);
        this.emit({
          type: 'tool_use',
          toolUseId,
          name,
          summary: summariseToolInput(name, input, 300),
          input: compactInput(input, max),
        });
        if (COMMAND_TOOLS.has(name) && input && typeof input === 'object') {
          const command = String((input as Json)['command'] ?? '');
          const description = (input as Json)['description'];
          if (command) {
            this.emit({
              type: 'command_started',
              toolUseId,
              command: truncateText(command, 4000).text,
              description: typeof description === 'string' ? description : undefined,
            });
          }
        }
      }
    }
  }

  /** `user` messages in the output stream carry tool results. */
  private translateUser(msg: Json): void {
    const max = this.options.limits.maxEventTextChars;
    for (const block of this.contentBlocks(msg)) {
      if (block['type'] !== 'tool_result') continue;
      const toolUseId = String(block['tool_use_id'] ?? '');
      const isError = block['is_error'] === true;
      const { text, truncated } = truncateText(flattenContent(block['content']), max);
      const toolName = this.toolNames.get(toolUseId);
      if (toolName && COMMAND_TOOLS.has(toolName)) {
        this.emit({ type: 'command_finished', toolUseId, isError, output: text, truncated });
      } else {
        this.emit({ type: 'tool_result', toolUseId, isError, content: text, truncated });
      }
      this.toolNames.delete(toolUseId);
    }
  }

  /** Token-level deltas so the phone sees output as it is produced. */
  private translateStreamEvent(msg: Json): void {
    const event = msg['event'];
    if (!event || typeof event !== 'object') return;
    const e = event as Json;

    // Deltas carry no message id of their own, so remember the one announced by
    // message_start; block ids must match those of the final assistant message
    // for the UI to replace streamed text with the finished block.
    if (e['type'] === 'message_start') {
      const message = e['message'];
      if (message && typeof message === 'object' && typeof (message as Json)['id'] === 'string') {
        this.currentMessageId = (message as Json)['id'] as string;
      }
      return;
    }
    if (e['type'] !== 'content_block_delta') return;

    const delta = e['delta'];
    if (!delta || typeof delta !== 'object') return;
    const d = delta as Json;
    const index = typeof e['index'] === 'number' ? e['index'] : 0;
    const blockId = `${this.currentMessageId ?? String(msg['session_id'] ?? 'blk')}:${index}`;

    if (d['type'] === 'text_delta' && typeof d['text'] === 'string' && d['text']) {
      this.emit({ type: 'message_delta', blockId, text: d['text'].slice(0, 4000) });
    } else if (d['type'] === 'thinking_delta' && typeof d['thinking'] === 'string' && d['thinking']) {
      this.emit({ type: 'thinking_delta', blockId, text: d['thinking'].slice(0, 4000) });
    }
  }

  private translateResult(msg: Json): void {
    const subtype = typeof msg['subtype'] === 'string' ? msg['subtype'] : '';
    const cancelled = this.status === 'cancelling' && CANCEL_RESULT_SUBTYPES.has(subtype);

    if (this.cancelTimer) {
      clearTimeout(this.cancelTimer);
      this.cancelTimer = null;
    }

    if (cancelled) {
      this.emit({ type: 'session_cancelled', reason: 'interrupted by user' });
    }

    const isError = msg['is_error'] === true || (subtype !== 'success' && !cancelled);
    if (isError) {
      const errorMsg =
        (typeof msg['error'] === 'string' && msg['error']) ||
        (typeof msg['result'] === 'string' && msg['result']) ||
        'The Claude CLI reported an error';
      this.lastErrorMessage = errorMsg;
      this.emit({
        type: 'error',
        message: errorMsg,
        fatal: false,
      });
    }

    const result = typeof msg['result'] === 'string' ? truncateText(msg['result'], 2000).text : undefined;
    this.emit({
      type: 'turn_finished',
      isError,
      durationMs: numberOrUndefined(msg['duration_ms']),
      costUsd: numberOrUndefined(msg['total_cost_usd']),
      numTurns: numberOrUndefined(msg['num_turns']),
      result,
    });

    this.blockIndexByMessage.clear();
    this.failPendingPermissions('the turn ended before the request was answered');
    if (this.status !== 'exited' && this.status !== 'crashed') this.setStatus('idle');
  }

  private touch(): void {
    this.lastActivityAt = Date.now();
  }

  private setStatus(next: AdapterStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.touch();
    this.onState(this.getStatus());
  }

  private emit(event: SessionEventBody): void {
    this.touch();
    this.onEvent(event);
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Tool results arrive either as a string or as content blocks. */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : safeStringify(content);
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (block && typeof block === 'object') {
        const b = block as Json;
        if (typeof b['text'] === 'string') return b['text'];
        if (b['type'] === 'image') return '[image]';
        return safeStringify(b);
      }
      return '';
    })
    .join('\n');
}

function safeStringify(value: unknown, max = 4000): string {
  try {
    const out = JSON.stringify(value);
    return out === undefined ? '' : out.slice(0, max);
  } catch {
    return '[unserialisable]';
  }
}

/** Keep tool input small enough to stream to a phone. */
function compactInput(input: unknown, max: number): unknown {
  if (input == null || typeof input !== 'object') return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Json)) {
    out[key] = typeof value === 'string' ? truncateText(value, Math.min(max, 4000)).text : value;
  }
  return out;
}

/** A one-line, human-readable description for the activity feed. */
export function summariseToolInput(name: string, input: unknown, max: number): string {
  if (!input || typeof input !== 'object') return name;
  const i = input as Json;
  const pick = (key: string): string | undefined =>
    typeof i[key] === 'string' ? (i[key] as string) : undefined;

  const candidate =
    pick('command') ??
    pick('file_path') ??
    pick('path') ??
    pick('pattern') ??
    pick('query') ??
    pick('url') ??
    pick('prompt') ??
    pick('description');

  const text = candidate ?? safeStringify(i, max);
  return truncateText(text.replace(/\s+/g, ' ').trim(), max).text;
}

export function makeClaudeCodeFactory(command: string): CLIAdapterFactory {
  return {
    id: 'claude-code',
    create: (options: AdapterOptions): CLIAdapter => new ClaudeCodeAdapter(command, options),
  };
}
