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

  /** Which CLI agents are offered, and which one a session gets by default. */
  CLI_ADAPTERS: z.string().default('claude-code,antigravity-cli'),
  CLI_DEFAULT_ADAPTER: z.string().default('claude-code'),

  /** Per-agent binary and model overrides. */
  CLAUDE_COMMAND: z.string().default(''),
  CLAUDE_MODEL: z.string().default(''),
  AGY_COMMAND: z.string().default(''),
  AGY_MODEL: z.string().default(''),
  ANTIGRAVITY_COMMAND: z.string().default(''),
  ANTIGRAVITY_MODEL: z.string().default(''),

  /** Applied to the default agent when the per-agent variables are unset. */
  CLI_COMMAND: z.string().default(''),
  CLI_MODEL: z.string().default(''),

  /**
   * Provider-neutral permission level: default (ask, unusable headless),
   * acceptEdits, or full. Provider-native names are accepted as aliases.
   */
  CLI_PERMISSION_MODE: z.string().default('default'),

  MAX_CONCURRENT_SESSIONS: int(4, 1, 32),
  /** Kill a session that has been idle (no instruction, no output) for this long. */
  SESSION_IDLE_TIMEOUT_MS: int(6 * 60 * 60 * 1000, 60_000, 7 * 24 * 60 * 60 * 1000),
  /** Cancel a single turn that runs longer than this. */
  TURN_TIMEOUT_MS: int(30 * 60 * 1000, 10_000, 12 * 60 * 60 * 1000),
  /** How long a finished/dead session is retained before it is swept from memory. */
  SESSION_RETENTION_MS: int(24 * 60 * 60 * 1000, 60_000, 30 * 24 * 60 * 60 * 1000),
  /** Auto-deny a tool approval nobody answers, so a turn cannot hang forever. */
  PERMISSION_TIMEOUT_MS: int(15 * 60 * 1000, 1_000, 24 * 60 * 60 * 1000),
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

  /**
   * Web Push. The PWA on a phone is only useful if it can wake you up, so this
   * is on by default; a VAPID key pair is generated into STATE_DIR on first run
   * unless one is supplied here.
   */
  PUSH_ENABLED: bool(true),
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  /** VAPID "sub" claim. Push services require a mailto: or https: URL. */
  VAPID_SUBJECT: z.string().default('mailto:terminal-agent@localhost'),
  /** How long a push service should hold an undelivered notification. */
  PUSH_TTL_SECONDS: int(30 * 60, 0, 7 * 24 * 60 * 60),
  /** Consecutive delivery failures before a subscription is dropped. */
  PUSH_MAX_FAILURES: int(5, 1, 100),
  /** Skip the push when the session is already on screen in an open client. */
  PUSH_SUPPRESS_WHEN_VISIBLE: bool(true),
  /** Notify when a turn ends, not just when an approval is needed. */
  PUSH_NOTIFY_TURN_FINISHED: bool(true),
  MAX_PUSH_SUBSCRIPTIONS: int(20, 1, 200),
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
  adapters: string[];
  defaultAdapter: string;
  adapterCommands: Record<string, string>;
  adapterModels: Record<string, string>;
  cliPermissionMode: string;
  maxConcurrentSessions: number;
  sessionIdleTimeoutMs: number;
  turnTimeoutMs: number;
  sessionRetentionMs: number;
  permissionTimeoutMs: number;
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
  push: Readonly<{
    enabled: boolean;
    publicKey: string;
    privateKey: string;
    subject: string;
    ttlSeconds: number;
    maxFailures: number;
    suppressWhenVisible: boolean;
    notifyTurnFinished: boolean;
    maxSubscriptions: number;
  }>;
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

  const adapters = parsed.CLI_ADAPTERS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const defaultAdapter = adapters.includes(parsed.CLI_DEFAULT_ADAPTER)
    ? parsed.CLI_DEFAULT_ADAPTER
    : (adapters[0] ?? 'antigravity-cli');

  // The generic CLI_COMMAND/CLI_MODEL apply to the default agent, so a
  // single-agent setup needs no per-agent variables.
  const adapterCommands: Record<string, string> = {};
  const adapterModels: Record<string, string> = {};
  if (parsed.CLI_COMMAND) adapterCommands[defaultAdapter] = parsed.CLI_COMMAND;
  if (parsed.CLI_MODEL) adapterModels[defaultAdapter] = parsed.CLI_MODEL;
  if (parsed.CLAUDE_COMMAND) adapterCommands['claude-code'] = parsed.CLAUDE_COMMAND;
  if (parsed.CLAUDE_MODEL) adapterModels['claude-code'] = parsed.CLAUDE_MODEL;
  const agyCmd = parsed.AGY_COMMAND || parsed.ANTIGRAVITY_COMMAND;
  const agyModel = parsed.AGY_MODEL || parsed.ANTIGRAVITY_MODEL;
  if (agyCmd) adapterCommands['antigravity-cli'] = agyCmd;
  if (agyModel) adapterModels['antigravity-cli'] = agyModel;

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
    adapters,
    defaultAdapter,
    adapterCommands,
    adapterModels,
    cliPermissionMode: parsed.CLI_PERMISSION_MODE,
    maxConcurrentSessions: parsed.MAX_CONCURRENT_SESSIONS,
    sessionIdleTimeoutMs: parsed.SESSION_IDLE_TIMEOUT_MS,
    turnTimeoutMs: parsed.TURN_TIMEOUT_MS,
    sessionRetentionMs: parsed.SESSION_RETENTION_MS,
    permissionTimeoutMs: parsed.PERMISSION_TIMEOUT_MS,
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
    push: Object.freeze({
      enabled: parsed.PUSH_ENABLED,
      publicKey: parsed.VAPID_PUBLIC_KEY.trim(),
      privateKey: parsed.VAPID_PRIVATE_KEY.trim(),
      subject: parsed.VAPID_SUBJECT.trim() || 'mailto:terminal-agent@localhost',
      ttlSeconds: parsed.PUSH_TTL_SECONDS,
      maxFailures: parsed.PUSH_MAX_FAILURES,
      suppressWhenVisible: parsed.PUSH_SUPPRESS_WHEN_VISIBLE,
      notifyTurnFinished: parsed.PUSH_NOTIFY_TURN_FINISHED,
      maxSubscriptions: parsed.MAX_PUSH_SUBSCRIPTIONS,
    }),
  });
}
