import type { SessionEventBody } from '../sessions/events.js';

export type AdapterStatus = 'starting' | 'idle' | 'busy' | 'cancelling' | 'exited' | 'crashed';

export type AdapterState = Readonly<{
  status: AdapterStatus;
  /** Identifier the CLI itself uses for the conversation, if it exposes one. */
  cliSessionId: string | null;
  pid: number | null;
  model: string | null;
  startedAt: number | null;
  lastActivityAt: number;
  exitCode: number | null;
  exitSignal: string | null;
  /** Total bytes read from the CLI's output stream. */
  bytesOut: number;
}>;

export type AdapterOptions = Readonly<{
  /** Absolute, registry-validated working directory. */
  cwd: string;
  model?: string;
  permissionMode?: string;
  /** Resume a previous CLI-side conversation instead of starting a fresh one. */
  resumeCliSessionId?: string | null;
  limits: {
    maxEventTextChars: number;
    maxEventLineBytes: number;
    maxSessionOutputBytes: number;
    cancelGraceMs: number;
  };
}>;

export type AdapterEventHandler = (event: SessionEventBody) => void;
export type AdapterStateHandler = (state: AdapterState) => void;

/**
 * Contract every CLI integration implements. Nothing outside `adapters/` knows
 * which CLI is in use, which is what makes a second provider a drop-in.
 */
export interface CLIAdapter {
  readonly id: string;

  /** Spawn the persistent CLI process. Resolves once the process is running. */
  startSession(): Promise<void>;

  /** Queue an instruction for the running process. */
  sendInstruction(text: string): Promise<void>;

  /** Register handlers for the translated event stream and state transitions. */
  streamEvents(onEvent: AdapterEventHandler, onState: AdapterStateHandler): void;

  /** Interrupt the current turn, keeping the process and its context alive. */
  cancel(reason: string): Promise<void>;

  getStatus(): AdapterState;

  /** Terminate the process for good, escalating to SIGKILL if needed. */
  terminate(reason: string): Promise<void>;
}

export interface CLIAdapterFactory {
  readonly id: string;
  create(options: AdapterOptions): CLIAdapter;
}
