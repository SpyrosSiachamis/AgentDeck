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

export type PermissionDecision = Readonly<{
  decision: 'allow' | 'deny';
  /** Shown to the model when denied, so it can adapt instead of retrying. */
  reason?: string;
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

  /**
   * True when the CLI can ask before running a tool. Adapters that cannot
   * (their approval policy is fixed at launch) report false, and the UI hides
   * the approve/deny affordance for those sessions.
   */
  readonly supportsPermissionPrompts: boolean;

  /**
   * Answer a pending `permission_request`. Only meaningful when
   * `supportsPermissionPrompts` is true.
   */
  respondToPermission(requestId: string, decision: PermissionDecision): Promise<void>;

  getStatus(): AdapterState;

  /** Terminate the process for good, escalating to SIGKILL if needed. */
  terminate(reason: string): Promise<void>;
}

export interface CLIAdapterFactory {
  readonly id: string;
  create(options: AdapterOptions): CLIAdapter;
}

/**
 * Provider-neutral permission vocabulary. Each CLI spells these differently;
 * adapters translate. Configuration and the API speak these three names, plus
 * provider-native aliases for anything a specific CLI supports uniquely.
 */
export type PermissionLevel = 'default' | 'acceptEdits' | 'full';

const PERMISSION_ALIASES: Record<string, PermissionLevel> = {
  default: 'default',
  ask: 'default',
  manual: 'default',
  plan: 'default',
  acceptedits: 'acceptEdits',
  accept_edits: 'acceptEdits',
  auto_edit: 'acceptEdits',
  autoedit: 'acceptEdits',
  auto: 'acceptEdits',
  dontask: 'acceptEdits',
  full: 'full',
  yolo: 'full',
  bypasspermissions: 'full',
};

export function normalizePermissionMode(mode: string | undefined | null): PermissionLevel {
  if (!mode) return 'acceptEdits';
  return PERMISSION_ALIASES[mode.toLowerCase().replace(/-/g, '_')] ?? 'acceptEdits';
}

/** What the UI needs to know about an installed CLI. */
export type AdapterDescriptor = Readonly<{
  id: string;
  displayName: string;
  /** Resolved command name; useful when diagnosing a missing binary. */
  command: string;
  model: string | null;
  /** False when the binary is not on PATH. */
  available: boolean;
  /**
   * True when one process serves the whole session (Claude Code). False when
   * the CLI is one-shot and continuity comes from resuming (Gemini).
   */
  persistentProcess: boolean;
  /** Whether sessions on this agent can prompt for tool approval. */
  supportsPermissionPrompts: boolean;
  /** Human-readable note shown in the picker. */
  note: string;
}>;
