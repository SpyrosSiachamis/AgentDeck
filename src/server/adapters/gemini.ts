import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { buildChildEnv } from './env.js';
import { truncateText, type SessionEventBody } from '../sessions/events.js';
import { normalizePermissionMode } from './types.js';
import type {
  AdapterEventHandler,
  AdapterOptions,
  AdapterState,
  AdapterStateHandler,
  AdapterStatus,
  CLIAdapter,
  CLIAdapterFactory,
} from './types.js';

/**
 * Adapter for the Gemini CLI's documented non-interactive interface:
 *
 *   gemini --output-format stream-json [--resume <uuid>]   (prompt on stdin)
 *
 * Unlike Claude Code, the Gemini CLI has no streaming *input* mode: it reads
 * stdin to EOF, treats it as the single prompt, and exits when the turn ends.
 * A long-lived process is therefore impossible, so this adapter runs one
 * process per instruction and preserves the conversation with `--resume`,
 * which accepts the session UUID reported in the CLI's own `init` event.
 *
 * Consequences worth knowing, all handled here rather than leaking upwards:
 *  - Between turns the session is alive but has no process and no pid.
 *  - A normal turn ends with the process exiting; that is not a crash, so the
 *    adapter returns to `idle` instead of reporting `exited`.
 *  - Cancellation has no control channel, so it signals the process group. The
 *    conversation survives because the next instruction resumes it.
 */

type Json = Record<string, unknown>;

/** Tool names that read as shell command execution in the activity feed. */
const COMMAND_TOOLS = new Set(['run_shell_command', 'shell', 'execute_command']);

const PERMISSION_FLAG: Record<string, string> = {
  default: 'default',
  acceptEdits: 'auto_edit',
  full: 'yolo',
};

export class GeminiAdapter implements CLIAdapter {
  readonly id = 'gemini-cli';
  /**
   * The Gemini CLI fixes its approval policy with --approval-mode at launch and
   * offers no channel to ask mid-turn, so sessions cannot prompt for approval.
   */
  readonly supportsPermissionPrompts = false;

  private child: ChildProcessWithoutNullStreams | null = null;
  private onEvent: AdapterEventHandler = () => {};
  private onState: AdapterStateHandler = () => {};

  private status: AdapterStatus = 'starting';
  private cliSessionId: string | null;
  private model: string | null;
  private pid: number | null = null;
  private startedAt: number | null = null;
  private lastActivityAt = Date.now();
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private bytesOut = 0;

  private stdoutBuffer = '';
  private stderrBuffer = '';
  private outputLimitHit = false;
  /** Set while a terminate()/cancel() is deliberately killing the process. */
  private killing: 'cancel' | 'terminate' | null = null;
  private terminated = false;
  private announcedSession = false;
  private turnExit: Promise<void> | null = null;
  private resolveTurnExit: (() => void) | null = null;
  private killTimers: NodeJS.Timeout[] = [];
  /** Bumped per turn so a turn's assistant deltas share one render block. */
  private turnCounter = 0;
  /** Whether this turn already produced a `result` event. */
  private turnReported = false;
  /** Whether the CLI already explained a failure itself this turn. */
  private errorReported = false;
  private readonly commandTools = new Set<string>();

  constructor(
    private readonly command: string,
    private readonly options: AdapterOptions,
  ) {
    this.cliSessionId = options.resumeCliSessionId ?? null;
    this.model = options.model ?? null;
  }

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

  /**
   * Nothing to spawn: the CLI only runs while a turn is in flight. The session
   * still becomes usable immediately, which is what the manager cares about.
   */
  async startSession(): Promise<void> {
    if (this.terminated) throw new Error('session already terminated');
    this.startedAt = Date.now();
    this.setStatus('idle');
  }

  private buildArgs(): string[] {
    const args = ['--output-format', 'stream-json'];
    if (this.options.model) args.push('--model', this.options.model);

    // Gemini cannot ask mid-turn, so "default" would make every tool call fail.
    // Its floor is auto_edit; "full" opts into unattended shell commands.
    const level = normalizePermissionMode(this.options.permissionMode);
    const approval = PERMISSION_FLAG[level === 'default' ? 'acceptEdits' : level] ?? 'auto_edit';
    args.push('--approval-mode', approval);

    // Resuming by UUID is exact; "latest" and index numbers would race with
    // other sessions running in the same workspace.
    if (this.cliSessionId) args.push('--resume', this.cliSessionId);
    return args;
  }

  async sendInstruction(text: string): Promise<void> {
    if (this.terminated) throw new Error('session has been terminated');
    if (this.child) throw new Error('a turn is already running');

    this.killing = null;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';

    const child = spawn(this.command, this.buildArgs(), {
      cwd: this.options.cwd,
      env: buildChildEnv(process.env, {
        extraAllow: (process.env.CLI_FORWARD_ENV ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    }) as ChildProcessWithoutNullStreams;

    this.child = child;
    this.pid = child.pid ?? null;
    this.turnExit = new Promise((resolve) => {
      this.resolveTurnExit = resolve;
    });
    this.setStatus('busy');

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer = (this.stderrBuffer + chunk).slice(-8000);
    });

    child.on('error', (err) => {
      this.emit({
        type: 'error',
        message: `Failed to start the Gemini CLI: ${err.message}`,
        detail: `command: ${this.command}`,
        fatal: true,
      });
      this.finishTurn(null, null);
    });

    child.on('exit', (code, signal) => this.finishTurn(code, signal));

    // The prompt is delivered on stdin rather than argv: it keeps long
    // instructions off the command line and out of the process table.
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(text, (err) => (err ? reject(err) : resolve()));
    });
    child.stdin.end();
  }

  /** Called exactly once per turn, whatever ended it. */
  private finishTurn(code: number | null, signal: string | null): void {
    if (!this.child) return;
    this.child = null;
    this.pid = null;
    this.exitCode = code;
    this.exitSignal = signal;
    for (const timer of this.killTimers) clearTimeout(timer);
    this.killTimers = [];

    // Anything still buffered without a trailing newline is a final event.
    const tail = this.stdoutBuffer.trim();
    this.stdoutBuffer = '';
    if (tail) this.handleLine(tail);

    const wasCancelled = this.killing === 'cancel';
    const wasTerminated = this.killing === 'terminate' || this.terminated;
    this.killing = null;

    if (wasCancelled) {
      this.emit({ type: 'session_cancelled', reason: 'interrupted by user' });
      if (!this.turnReported) this.emit({ type: 'turn_finished', isError: false });
    } else if (!wasTerminated) {
      // Gemini reports some failures (auth, quota) only on stderr, so a bad exit
      // code is surfaced — unless the CLI already explained itself in-band, in
      // which case a second error would just be noise on a small screen.
      if (code !== 0 && !this.errorReported) {
        this.emit({
          type: 'error',
          message: `Gemini CLI exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}`,
          detail: this.stderrBuffer.trim().slice(-2000) || undefined,
          fatal: false,
        });
      }
      // A turn must always be closed out, even when the CLI exits without
      // emitting a result event; otherwise the UI would wait forever.
      if (!this.turnReported) this.emit({ type: 'turn_finished', isError: code !== 0 });
    }

    this.resolveTurnExit?.();
    this.resolveTurnExit = null;

    if (wasTerminated) {
      this.setStatus('exited');
      this.emit({
        type: 'session_finished',
        reason: 'terminated',
        code,
        signal,
      });
    } else {
      // A finished process is the normal end of a turn, not the end of the
      // session: the next instruction resumes the conversation.
      this.setStatus('idle');
    }
  }

  /**
   * No control channel exists, so cancelling means killing the turn's process.
   * The conversation is preserved: the next instruction resumes by UUID.
   */
  async respondToPermission(): Promise<void> {
    throw new Error('The Gemini CLI does not support interactive tool approval.');
  }

  async cancel(reason: string): Promise<void> {
    const child = this.child;
    if (!child) {
      this.emit({ type: 'session_cancelled', reason: `${reason} (no active turn)` });
      return;
    }
    this.killing = 'cancel';
    this.setStatus('cancelling');
    this.signalTree(child, 'SIGTERM');
    const hardKill = setTimeout(() => {
      if (this.child) this.signalTree(this.child, 'SIGKILL');
    }, this.options.limits.cancelGraceMs);
    hardKill.unref?.();
    this.killTimers.push(hardKill);
    await this.turnExit;
  }

  async terminate(reason: string): Promise<void> {
    if (this.terminated) {
      await this.turnExit;
      return;
    }
    this.terminated = true;

    const child = this.child;
    if (!child) {
      this.setStatus('exited');
      this.emit({ type: 'session_finished', reason: 'terminated', code: null, signal: null });
      this.emit({ type: 'notice', message: `Session terminated (${reason}).` });
      return;
    }

    this.killing = 'terminate';
    this.signalTree(child, 'SIGTERM');
    const hardKill = setTimeout(() => {
      if (this.child) this.signalTree(this.child, 'SIGKILL');
    }, this.options.limits.cancelGraceMs);
    hardKill.unref?.();
    this.killTimers.push(hardKill);

    await this.turnExit;
    this.emit({ type: 'notice', message: `Session terminated (${reason}).` });
  }

  private signalTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    if (child.exitCode !== null) return;
    try {
      if (process.platform !== 'win32' && child.pid) {
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
    if (parsed && typeof parsed === 'object') this.translate(parsed as Json);
  }

  private translate(msg: Json): void {
    const max = this.options.limits.maxEventTextChars;

    switch (msg['type']) {
      case 'init': {
        const sessionId = typeof msg['session_id'] === 'string' ? msg['session_id'] : null;
        const model = typeof msg['model'] === 'string' ? msg['model'] : null;
        const lostConversation = sessionId !== null && this.cliSessionId !== null && sessionId !== this.cliSessionId;
        this.cliSessionId = sessionId ?? this.cliSessionId;
        this.model = model ?? this.model;
        if (!this.announcedSession) {
          this.emit({
            type: 'session_started',
            cliSessionId: this.cliSessionId,
            model: this.model,
            resumed: Boolean(this.options.resumeCliSessionId),
          });
          this.announcedSession = true;
        } else if (lostConversation) {
          // A new id mid-session means the resume did not take; say so rather
          // than silently starting a fresh conversation.
          this.emit({
            type: 'notice',
            message: 'The Gemini CLI started a new conversation instead of resuming the previous one.',
          });
        }
        this.onState(this.getStatus());
        return;
      }

      case 'message': {
        // The CLI echoes the prompt back as a user message; `turn_started`
        // already shows it, so only assistant output is forwarded.
        if (msg['role'] !== 'assistant') return;
        const content = String(msg['content'] ?? '');
        if (!content) return;
        if (msg['delta'] === true) {
          this.emit({ type: 'message_delta', blockId: this.blockId(), text: content.slice(0, 4000) });
        } else {
          const { text, truncated } = truncateText(content, max);
          this.emit({ type: 'message', role: 'assistant', blockId: this.blockId(), text, truncated });
        }
        return;
      }

      case 'tool_use': {
        const toolUseId = String(msg['tool_id'] ?? randomUUID());
        const name = String(msg['tool_name'] ?? 'tool');
        const parameters = msg['parameters'];
        this.emit({
          type: 'tool_use',
          toolUseId,
          name,
          summary: summariseParameters(name, parameters),
          input: parameters,
        });
        if (COMMAND_TOOLS.has(name) && parameters && typeof parameters === 'object') {
          const p = parameters as Json;
          const command = String(p['command'] ?? p['cmd'] ?? '');
          if (command) {
            this.emit({
              type: 'command_started',
              toolUseId,
              command: truncateText(command, 4000).text,
              description: typeof p['description'] === 'string' ? p['description'] : undefined,
            });
            this.commandTools.add(toolUseId);
          }
        }
        return;
      }

      case 'tool_result': {
        const toolUseId = String(msg['tool_id'] ?? '');
        const isError = msg['status'] === 'error';
        const errorMessage =
          msg['error'] && typeof msg['error'] === 'object'
            ? String((msg['error'] as Json)['message'] ?? '')
            : '';
        const { text, truncated } = truncateText(String(msg['output'] ?? errorMessage ?? ''), max);
        if (this.commandTools.has(toolUseId)) {
          this.commandTools.delete(toolUseId);
          this.emit({ type: 'command_finished', toolUseId, isError, output: text, truncated });
        } else {
          this.emit({ type: 'tool_result', toolUseId, isError, content: text, truncated });
        }
        return;
      }

      case 'error': {
        this.errorReported = true;
        this.emit({
          type: 'error',
          message: String(msg['message'] ?? 'The Gemini CLI reported an error'),
          // Never fatal at this level: the session's fate is decided by the
          // process exit code, and a warning must not tear it down.
          fatal: false,
        });
        return;
      }

      case 'result': {
        const isError = msg['status'] === 'error';
        const error =
          msg['error'] && typeof msg['error'] === 'object' ? (msg['error'] as Json) : null;
        if (error) {
          this.errorReported = true;
          this.emit({
            type: 'error',
            message: String(error['message'] ?? 'The turn failed'),
            fatal: false,
          });
        }
        const stats = msg['stats'] && typeof msg['stats'] === 'object' ? (msg['stats'] as Json) : null;
        this.emit({
          type: 'turn_finished',
          isError,
          durationMs: typeof stats?.['duration_ms'] === 'number' ? (stats['duration_ms'] as number) : undefined,
        });
        this.turnReported = true;
        return;
      }

      default:
        return;
    }
  }

  /** Assistant deltas within one turn share a block so they render as one bubble. */
  private blockId(): string {
    return `${this.cliSessionId ?? 'gemini'}:${this.turnCounter}`;
  }

  private touch(): void {
    this.lastActivityAt = Date.now();
  }

  private setStatus(next: AdapterStatus): void {
    if (this.status === next) return;
    if (next === 'busy') {
      this.turnCounter += 1;
      this.turnReported = false;
      this.errorReported = false;
    }
    this.status = next;
    this.touch();
    this.onState(this.getStatus());
  }

  private emit(event: SessionEventBody): void {
    this.touch();
    this.onEvent(event);
  }
}

export function summariseParameters(name: string, parameters: unknown): string {
  if (!parameters || typeof parameters !== 'object') return name;
  const p = parameters as Json;
  const pick = (key: string): string | undefined =>
    typeof p[key] === 'string' ? (p[key] as string) : undefined;

  const candidate =
    pick('command') ??
    pick('cmd') ??
    pick('file_path') ??
    pick('absolute_path') ??
    pick('path') ??
    pick('pattern') ??
    pick('query') ??
    pick('url') ??
    pick('prompt') ??
    pick('description');

  let text = candidate;
  if (text === undefined) {
    try {
      text = JSON.stringify(p) ?? name;
    } catch {
      text = name;
    }
  }
  return truncateText(text.replace(/\s+/g, ' ').trim(), 300).text;
}

export function makeGeminiFactory(command: string): CLIAdapterFactory {
  return {
    id: 'gemini-cli',
    create: (options: AdapterOptions): CLIAdapter => new GeminiAdapter(command, options),
  };
}
