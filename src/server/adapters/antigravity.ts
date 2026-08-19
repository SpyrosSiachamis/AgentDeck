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
 * Adapter for the Antigravity CLI's documented headless stream-json interface:
 *
 *   agy -p --input-format stream-json --output-format stream-json
 *
 * One long-lived process serves the whole session. Instructions are written to
 * stdin as JSON lines; structured events are read from stdout as JSON lines.
 * Terminal output is never scraped.
 */

type Json = Record<string, unknown>;

const CANCEL_RESULT_SUBTYPES = new Set(['error_during_execution', 'cancelled', 'interrupted']);

/** Tools whose invocation is also reported as a shell command lifecycle. */
const COMMAND_TOOLS = new Set([
  'run_command',
  'run_shell_command',
  'shell',
  'execute_command',
  'Bash',
  'BashOutput',
  'KillShell',
  'terminal',
  'exec',
]);

/** Native modes accepted by the Antigravity CLI. */
const AGY_NATIVE_MODES = new Set([
  'default',
  'accept-edits',
  'acceptEdits',
  'plan',
  'dangerously-skip-permissions',
  'bypassPermissions',
  'full',
]);

export class AntigravityAdapter implements CLIAdapter {
  readonly id = 'antigravity-cli';
  /**
   * The Antigravity CLI runs unattended in headless stream-json mode with
   * auto-approved permissions (--dangerously-skip-permissions).
   */
  readonly supportsPermissionPrompts = false;

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
  /** step index -> accumulated text delta for stream-json agent_response steps. */
  private readonly accumulatedTextByStep = new Map<number, string>();
  /** step index -> accumulated thinking delta for stream-json agent_response steps. */
  private readonly accumulatedThinkingByStep = new Map<number, string>();
  /** Permission requests the CLI is waiting on, keyed by its request id. */
  private readonly pendingPermissions = new Map<string, { toolName: string; input: unknown }>();
  private exitPromise: Promise<void> | null = null;
  private resolveExit: (() => void) | null = null;

  constructor(
    private readonly command: string,
    private readonly options: AdapterOptions,
  ) {
    if (options.resumeCliSessionId) {
      this.cliSessionId = options.resumeCliSessionId;
    }
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

  private buildArgs(): string[] {
    const args = [
      '-p=',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
    ];
    if (this.options.model) args.push('--model', this.options.model);

    const requested = this.options.permissionMode ?? 'default';
    const normalized = normalizePermissionMode(requested);

    if (requested === 'plan') {
      args.push('--mode', 'plan', '--dangerously-skip-permissions');
    } else if (normalized === 'acceptEdits' || requested === 'accept-edits' || requested === 'auto_edit') {
      args.push('--mode', 'accept-edits', '--dangerously-skip-permissions');
    } else {
      args.push('--dangerously-skip-permissions');
    }

    if (this.options.resumeCliSessionId) {
      args.push('--conversation', this.options.resumeCliSessionId);
    }
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
          detail: this.stderrBuffer.slice(-2000) || undefined,
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

    // A spawn failure surfaces asynchronously; give it a tick so missing binary fails fast.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    if (this.status === 'crashed') throw new Error('CLI process failed to start');
    this.setStatus('idle');
  }

  async sendInstruction(text: string): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.killed) {
      throw new Error('CLI process is not running');
    }
    const payload = {
      event: 'user',
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
   * turn but keeps the conversation alive. If the process does not settle, escalate to signals.
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

    // Closing stdin is the CLI's standard shutdown path.
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
    const event = typeof msg['event'] === 'string' ? (msg['event'] as string) : '';
    const type = typeof msg['type'] === 'string' ? (msg['type'] as string) : '';

    if (event === 'init') {
      this.translateInit(msg);
      return;
    }
    if (event === 'step_update') {
      this.translateStepUpdate(msg);
      return;
    }
    if (event === 'result') {
      this.translateResult(msg);
      return;
    }

    switch (type) {
      case 'system':
      case 'init':
        this.translateInit(msg);
        return;
      case 'assistant':
        this.translateAssistant(msg);
        return;
      case 'user':
        this.translateUser(msg);
        return;
      case 'message':
        this.translateMessage(msg);
        return;
      case 'stream_event':
        this.translateStreamEvent(msg);
        return;
      case 'tool_use':
        this.translateToolUseTopLevel(msg);
        return;
      case 'tool_result':
        this.translateToolResultTopLevel(msg);
        return;
      case 'result':
        this.translateResult(msg);
        return;
      case 'control_request':
        this.translateControlRequest(msg);
        return;
      case 'error':
        this.translateError(msg);
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
    const input = req['input'] ?? req['parameters'];
    this.pendingPermissions.set(requestId, { toolName, input });

    const command =
      input && typeof input === 'object'
        ? ((input as Json)['CommandLine'] as string) ??
          ((input as Json)['command'] as string) ??
          ((input as Json)['cmd'] as string)
        : undefined;

    this.emit({
      type: 'permission_request',
      requestId,
      toolName,
      displayName: typeof req['display_name'] === 'string' ? (req['display_name'] as string) : toolName,
      summary: summariseToolInput(toolName, input, 300),
      command: typeof command === 'string' ? truncateText(command, 4000).text : undefined,
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

  private translateInit(msg: Json): void {
    if (msg['type'] === 'system' && msg['subtype'] !== 'init') return;
    const initObj = msg['init'] && typeof msg['init'] === 'object' ? (msg['init'] as Json) : null;
    const sessionId =
      (typeof msg['conversation_id'] === 'string' && msg['conversation_id']) ||
      (typeof msg['session_id'] === 'string' && msg['session_id']) ||
      (initObj && typeof initObj['conversation_id'] === 'string' && (initObj['conversation_id'] as string)) ||
      null;
    const model =
      (initObj && typeof initObj['model'] === 'string' && (initObj['model'] as string)) ||
      (typeof msg['model'] === 'string' && (msg['model'] as string)) ||
      null;
    const first = this.cliSessionId === null;
    this.cliSessionId = sessionId ?? this.cliSessionId;
    this.model = model ?? this.model;
    if (first && this.cliSessionId) {
      this.emit({
        type: 'session_started',
        cliSessionId: this.cliSessionId,
        model: this.model,
        resumed: Boolean(this.options.resumeCliSessionId),
      });
      this.onState(this.getStatus());
    }
  }

  private translateStepUpdate(msg: Json): void {
    const stepUpdate = (msg['step_update'] && typeof msg['step_update'] === 'object'
      ? msg['step_update']
      : msg) as Json;
    const stepIndex = typeof stepUpdate['step_index'] === 'number' ? (stepUpdate['step_index'] as number) : 0;
    const stepType = typeof stepUpdate['step_type'] === 'string' ? (stepUpdate['step_type'] as string) : '';
    const state = typeof stepUpdate['state'] === 'string' ? (stepUpdate['state'] as string) : '';
    const max = this.options.limits.maxEventTextChars;

    if (stepType === 'agent_response') {
      const blockId = `${this.cliSessionId ?? 'agy'}:${stepIndex}`;
      const textDelta = typeof stepUpdate['text_delta'] === 'string' ? (stepUpdate['text_delta'] as string) : '';
      if (textDelta) {
        const accumulated = (this.accumulatedTextByStep.get(stepIndex) ?? '') + textDelta;
        this.accumulatedTextByStep.set(stepIndex, accumulated);
        this.emit({ type: 'message_delta', blockId, text: textDelta.slice(0, 4000) });
      }

      const thinkDelta =
        typeof stepUpdate['thinking_delta'] === 'string'
          ? (stepUpdate['thinking_delta'] as string)
          : typeof stepUpdate['delta_raw_thinking'] === 'string'
            ? (stepUpdate['delta_raw_thinking'] as string)
            : '';
      if (thinkDelta) {
        const thinkBlockId = `${this.cliSessionId ?? 'agy'}:think:${stepIndex}`;
        const accumulated = (this.accumulatedThinkingByStep.get(stepIndex) ?? '') + thinkDelta;
        this.accumulatedThinkingByStep.set(stepIndex, accumulated);
        this.emit({ type: 'thinking_delta', blockId: thinkBlockId, text: thinkDelta.slice(0, 4000) });
      }

      if (state === 'DONE') {
        const accumulatedText = this.accumulatedTextByStep.get(stepIndex);
        const fallbackText = typeof stepUpdate['response'] === 'string' ? (stepUpdate['response'] as string) : '';
        const rawText = accumulatedText !== undefined && accumulatedText !== '' ? accumulatedText : fallbackText;
        if (rawText) {
          const { text, truncated } = truncateText(rawText, max);
          this.emit({ type: 'message', role: 'assistant', blockId, text, truncated });
        }
        this.accumulatedTextByStep.delete(stepIndex);

        const accumulatedThinking = this.accumulatedThinkingByStep.get(stepIndex);
        const fallbackThinking =
          typeof stepUpdate['thinking'] === 'string' ? (stepUpdate['thinking'] as string) : '';
        const rawThinking =
          accumulatedThinking !== undefined && accumulatedThinking !== '' ? accumulatedThinking : fallbackThinking;
        if (rawThinking) {
          const thinkBlockId = `${this.cliSessionId ?? 'agy'}:think:${stepIndex}`;
          const { text, truncated } = truncateText(rawThinking, max);
          this.emit({ type: 'thinking', blockId: thinkBlockId, text, truncated });
        }
        this.accumulatedThinkingByStep.delete(stepIndex);
      }
    } else if (stepType === 'tool') {
      const toolUseId = `${this.cliSessionId ?? 'agy'}:tool:${stepIndex}`;
      const toolInfo = (stepUpdate['tool_info'] && typeof stepUpdate['tool_info'] === 'object'
        ? stepUpdate['tool_info']
        : {}) as Json;
      const name = String(stepUpdate['tool_name'] ?? toolInfo['name'] ?? 'tool');
      const input = toolInfo['parameters'] ?? toolInfo['input'] ?? {};

      if (state === 'ACTIVE') {
        this.toolNames.set(toolUseId, name);
        this.emit({
          type: 'tool_use',
          toolUseId,
          name,
          summary: summariseToolInput(name, input, 300),
          input: compactInput(input, max),
        });
        if (COMMAND_TOOLS.has(name) && input && typeof input === 'object') {
          const command = String(
            (input as Json)['CommandLine'] ?? (input as Json)['command'] ?? (input as Json)['cmd'] ?? '',
          );
          const description = (input as Json)['Description'] ?? (input as Json)['description'];
          if (command) {
            this.emit({
              type: 'command_started',
              toolUseId,
              command: truncateText(command, 4000).text,
              description: typeof description === 'string' ? description : undefined,
            });
          }
        }
      } else if (state === 'DONE' || state === 'ERROR') {
        const storedName = this.toolNames.get(toolUseId) ?? name;
        const isError =
          state === 'ERROR' ||
          toolInfo['is_error'] === true ||
          toolInfo['status'] === 'error' ||
          Boolean(toolInfo['error']);
        const output = toolInfo['output'] ?? toolInfo['error'] ?? toolInfo['result'] ?? '';
        const { text, truncated } = truncateText(flattenContent(output), max);
        if (COMMAND_TOOLS.has(storedName)) {
          this.emit({ type: 'command_finished', toolUseId, isError, output: text, truncated });
        } else {
          this.emit({ type: 'tool_result', toolUseId, isError, content: text, truncated });
        }
        this.toolNames.delete(toolUseId);
      }
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
      } else if (blockType === 'tool_use' || blockType === 'tool_call') {
        const toolUseId = String(block['id'] ?? block['tool_id'] ?? randomUUID());
        const name = String(block['name'] ?? block['tool_name'] ?? 'tool');
        const input = block['input'] ?? block['parameters'];
        this.toolNames.set(toolUseId, name);
        this.emit({
          type: 'tool_use',
          toolUseId,
          name,
          summary: summariseToolInput(name, input, 300),
          input: compactInput(input, max),
        });
        if (COMMAND_TOOLS.has(name) && input && typeof input === 'object') {
          const command = String(
            (input as Json)['CommandLine'] ?? (input as Json)['command'] ?? (input as Json)['cmd'] ?? '',
          );
          const description = (input as Json)['Description'] ?? (input as Json)['description'];
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

  /** Top-level message event handler */
  private translateMessage(msg: Json): void {
    if (msg['role'] !== 'assistant') return;
    const content = msg['content'];
    if (typeof content === 'string') {
      const max = this.options.limits.maxEventTextChars;
      const blockId = `${this.cliSessionId ?? 'agy'}:msg`;
      if (msg['delta'] === true) {
        this.emit({ type: 'message_delta', blockId, text: content.slice(0, 4000) });
      } else {
        const { text, truncated } = truncateText(content, max);
        this.emit({ type: 'message', role: 'assistant', blockId, text, truncated });
      }
    }
  }

  /** `user` messages in the output stream carry tool results. */
  private translateUser(msg: Json): void {
    const max = this.options.limits.maxEventTextChars;
    for (const block of this.contentBlocks(msg)) {
      if (block['type'] !== 'tool_result') continue;
      const toolUseId = String(block['tool_use_id'] ?? block['tool_id'] ?? '');
      const isError = block['is_error'] === true || block['status'] === 'error';
      const { text, truncated } = truncateText(flattenContent(block['content'] ?? block['output']), max);
      const toolName = this.toolNames.get(toolUseId);
      if (toolName && COMMAND_TOOLS.has(toolName)) {
        this.emit({ type: 'command_finished', toolUseId, isError, output: text, truncated });
      } else {
        this.emit({ type: 'tool_result', toolUseId, isError, content: text, truncated });
      }
      this.toolNames.delete(toolUseId);
    }
  }

  private translateToolUseTopLevel(msg: Json): void {
    const max = this.options.limits.maxEventTextChars;
    const toolUseId = String(msg['tool_id'] ?? msg['id'] ?? randomUUID());
    const name = String(msg['tool_name'] ?? msg['name'] ?? 'tool');
    const input = msg['parameters'] ?? msg['input'];
    this.toolNames.set(toolUseId, name);
    this.emit({
      type: 'tool_use',
      toolUseId,
      name,
      summary: summariseToolInput(name, input, 300),
      input: compactInput(input, max),
    });
    if (COMMAND_TOOLS.has(name) && input && typeof input === 'object') {
      const command = String(
        (input as Json)['CommandLine'] ?? (input as Json)['command'] ?? (input as Json)['cmd'] ?? '',
      );
      const description = (input as Json)['Description'] ?? (input as Json)['description'];
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

  private translateToolResultTopLevel(msg: Json): void {
    const max = this.options.limits.maxEventTextChars;
    const toolUseId = String(msg['tool_id'] ?? msg['tool_use_id'] ?? '');
    const isError = msg['status'] === 'error' || msg['is_error'] === true;
    const { text, truncated } = truncateText(flattenContent(msg['output'] ?? msg['content'] ?? ''), max);
    const toolName = this.toolNames.get(toolUseId);
    if (toolName && COMMAND_TOOLS.has(toolName)) {
      this.emit({ type: 'command_finished', toolUseId, isError, output: text, truncated });
    } else {
      this.emit({ type: 'tool_result', toolUseId, isError, content: text, truncated });
    }
    this.toolNames.delete(toolUseId);
  }

  /** Token-level deltas so the phone sees output as it is produced. */
  private translateStreamEvent(msg: Json): void {
    const event = msg['event'];
    if (!event || typeof event !== 'object') return;
    const e = event as Json;

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

  private translateError(msg: Json): void {
    this.emit({
      type: 'error',
      message: String(msg['message'] ?? 'The Antigravity CLI reported an error'),
      fatal: false,
    });
  }

  private translateResult(msg: Json): void {
    const res = (msg['result'] && typeof msg['result'] === 'object' ? msg['result'] : msg) as Json;
    const subtype = typeof res['subtype'] === 'string' ? (res['subtype'] as string) : '';
    const status = typeof res['status'] === 'string' ? (res['status'] as string) : '';
    const isSuccess = status === 'SUCCESS' || subtype === 'success';
    const isExplicitError =
      status === 'ERROR' ||
      res['is_error'] === true ||
      Boolean(res['error']) ||
      (subtype !== '' && subtype !== 'success');

    const cancelled =
      this.status === 'cancelling' &&
      (CANCEL_RESULT_SUBTYPES.has(subtype) ||
        CANCEL_RESULT_SUBTYPES.has(status.toLowerCase()) ||
        String(res['error'] ?? '').includes('timeout waiting for response') ||
        String(res['error'] ?? '').includes('cancel') ||
        String(res['error'] ?? '').includes('interrupt'));

    if (this.cancelTimer) {
      clearTimeout(this.cancelTimer);
      this.cancelTimer = null;
    }

    if (cancelled) {
      this.emit({ type: 'session_cancelled', reason: 'interrupted by user' });
    }

    const stats = res['stats'] && typeof msg['stats'] === 'object' ? (msg['stats'] as Json) : (res['stats'] && typeof res['stats'] === 'object' ? (res['stats'] as Json) : null);
    const durationMs =
      numberOrUndefined(res['duration_ms']) ??
      (stats ? numberOrUndefined(stats['duration_ms']) : undefined) ??
      (typeof res['duration_seconds'] === 'number' ? (res['duration_seconds'] as number) * 1000 : undefined);
    const costUsd = numberOrUndefined(res['total_cost_usd']);
    const numTurns = numberOrUndefined(res['num_turns']);
    const rawResult =
      typeof res['response'] === 'string'
        ? (res['response'] as string)
        : typeof res['result'] === 'string'
          ? (res['result'] as string)
          : typeof res['error'] === 'string'
            ? (res['error'] as string)
            : undefined;
    const result = typeof rawResult === 'string' ? truncateText(rawResult, 2000).text : undefined;

    this.emit({
      type: 'turn_finished',
      isError: !cancelled && (isExplicitError || !isSuccess),
      durationMs,
      costUsd,
      numTurns,
      result,
    });

    this.blockIndexByMessage.clear();
    this.accumulatedTextByStep.clear();
    this.accumulatedThinkingByStep.clear();
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
    pick('CommandLine') ??
    pick('command') ??
    pick('cmd') ??
    pick('file_path') ??
    pick('absolute_path') ??
    pick('AbsolutePath') ??
    pick('TargetFile') ??
    pick('path') ??
    pick('pattern') ??
    pick('Pattern') ??
    pick('query') ??
    pick('Query') ??
    pick('url') ??
    pick('Url') ??
    pick('prompt') ??
    pick('Prompt') ??
    pick('description') ??
    pick('Description');

  const text = candidate ?? safeStringify(i, max);
  return truncateText(text.replace(/\s+/g, ' ').trim(), max).text;
}

export function makeAntigravityFactory(command: string): CLIAdapterFactory {
  return {
    id: 'antigravity-cli',
    create: (options: AdapterOptions): CLIAdapter => new AntigravityAdapter(command, options),
  };
}
