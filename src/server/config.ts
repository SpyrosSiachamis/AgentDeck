import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(v)));

const int = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int().min(min).max(max));

const envSchema = z.object({
  /** Bind address. Must stay on loopback unless ALLOW_NON_LOOPBACK_BIND is set. */
  HOST: z.string().default('127.0.0.1'),
  PORT: int(4823, 0, 65535),
  ALLOW_NON_LOOPBACK_BIND: bool(false),

  /** Path to the workspace registry file. Only workspaces listed there are reachable. */
  WORKSPACES_FILE: z.string().default('workspaces.json'),
  /** Directory for persistent session metadata and event logs. */
  STATE_DIR: z.string().default('.data'),

  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: bool(false),

  /** Reject requests that arrive without a Tailscale identity header. */
  REQUIRE_TAILSCALE_IDENTITY: bool(false),
  /** Comma-separated list of allowed Tailscale logins. Empty = allow any tailnet user. */
  ALLOWED_TAILSCALE_USERS: z.string().default(''),

  /** CLI adapter selection and behaviour. */
  CLI_ADAPTER: z.string().default('claude-code'),
  CLI_COMMAND: z.string().default('claude'),
  CLI_MODEL: z.string().default(''),
  CLI_PERMISSION_MODE: z
    .enum(['default', 'acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'])
    .default('acceptEdits'),

  MAX_CONCURRENT_SESSIONS: int(4, 1, 32),
  /** Kill a session that has been idle (no instruction, no output) for this long. */
  SESSION_IDLE_TIMEOUT_MS: int(6 * 60 * 60 * 1000, 60_000, 7 * 24 * 60 * 60 * 1000),
  /** Cancel a single turn that runs longer than this. */
  TURN_TIMEOUT_MS: int(30 * 60 * 1000, 10_000, 12 * 60 * 60 * 1000),
  /** How long a finished/dead session is retained before it is swept from memory. */
  SESSION_RETENTION_MS: int(24 * 60 * 60 * 1000, 60_000, 30 * 24 * 60 * 60 * 1000),
  /** Grace period between interrupt -> SIGTERM -> SIGKILL. */
  CANCEL_GRACE_MS: int(8_000, 500, 120_000),
  SHUTDOWN_GRACE_MS: int(5_000, 500, 60_000),

  /** Hard caps that protect the server from a runaway CLI process. */
  MAX_INSTRUCTION_CHARS: int(32_000, 100, 500_000),
  MAX_EVENT_TEXT_CHARS: int(20_000, 200, 500_000),
  MAX_EVENT_LINE_BYTES: int(4 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024),
  MAX_SESSION_OUTPUT_BYTES: int(64 * 1024 * 1024, 1024 * 1024, 2 * 1024 * 1024 * 1024),
  MAX_EVENTS_IN_MEMORY: int(1500, 50, 50_000),
  MAX_WS_PAYLOAD_BYTES: int(256 * 1024, 4096, 8 * 1024 * 1024),

  GIT_TIMEOUT_MS: int(10_000, 500, 120_000),
  MAX_GIT_DIFF_BYTES: int(1024 * 1024, 4096, 32 * 1024 * 1024),
});

export type Config = Readonly<{
  host: string;
  port: number;
  allowNonLoopbackBind: boolean;
  workspacesFile: string;
  stateDir: string;
  logLevel: string;
  logPretty: boolean;
  requireTailscaleIdentity: boolean;
  allowedTailscaleUsers: string[];
  cliAdapter: string;
  cliCommand: string;
  cliModel: string;
  cliPermissionMode: string;
  maxConcurrentSessions: number;
  sessionIdleTimeoutMs: number;
  turnTimeoutMs: number;
  sessionRetentionMs: number;
  cancelGraceMs: number;
  shutdownGraceMs: number;
  maxInstructionChars: number;
  maxEventTextChars: number;
  maxEventLineBytes: number;
  maxSessionOutputBytes: number;
  maxEventsInMemory: number;
  maxWsPayloadBytes: number;
  gitTimeoutMs: number;
  maxGitDiffBytes: number;
}>;

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host);
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse(env);

  if (!isLoopbackHost(parsed.HOST) && !parsed.ALLOW_NON_LOOPBACK_BIND) {
    throw new Error(
      `Refusing to bind to non-loopback host "${parsed.HOST}". This application is designed to be ` +
        `reached only through the Tailscale Serve proxy. Set ALLOW_NON_LOOPBACK_BIND=true only if ` +
        `you fully understand that Tailscale identity headers become spoofable.`,
    );
  }

  return Object.freeze({
    host: parsed.HOST,
    port: parsed.PORT,
    allowNonLoopbackBind: parsed.ALLOW_NON_LOOPBACK_BIND,
    workspacesFile: path.resolve(expandHome(parsed.WORKSPACES_FILE)),
    stateDir: path.resolve(expandHome(parsed.STATE_DIR)),
    logLevel: parsed.LOG_LEVEL,
    logPretty: parsed.LOG_PRETTY,
    requireTailscaleIdentity: parsed.REQUIRE_TAILSCALE_IDENTITY,
    allowedTailscaleUsers: parsed.ALLOWED_TAILSCALE_USERS.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    cliAdapter: parsed.CLI_ADAPTER,
    cliCommand: parsed.CLI_COMMAND,
    cliModel: parsed.CLI_MODEL,
    cliPermissionMode: parsed.CLI_PERMISSION_MODE,
    maxConcurrentSessions: parsed.MAX_CONCURRENT_SESSIONS,
    sessionIdleTimeoutMs: parsed.SESSION_IDLE_TIMEOUT_MS,
    turnTimeoutMs: parsed.TURN_TIMEOUT_MS,
    sessionRetentionMs: parsed.SESSION_RETENTION_MS,
    cancelGraceMs: parsed.CANCEL_GRACE_MS,
    shutdownGraceMs: parsed.SHUTDOWN_GRACE_MS,
    maxInstructionChars: parsed.MAX_INSTRUCTION_CHARS,
    maxEventTextChars: parsed.MAX_EVENT_TEXT_CHARS,
    maxEventLineBytes: parsed.MAX_EVENT_LINE_BYTES,
    maxSessionOutputBytes: parsed.MAX_SESSION_OUTPUT_BYTES,
    maxEventsInMemory: parsed.MAX_EVENTS_IN_MEMORY,
    maxWsPayloadBytes: parsed.MAX_WS_PAYLOAD_BYTES,
    gitTimeoutMs: parsed.GIT_TIMEOUT_MS,
    maxGitDiffBytes: parsed.MAX_GIT_DIFF_BYTES,
  });
}
