import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Human approval for shell commands, for a CLI that cannot ask.
 *
 * Claude Code routes tool approvals to us over its control channel. The
 * Antigravity CLI has no such channel: run it headless and it either
 * auto-denies every tool (its "request-review" mode, which makes it useless) or
 * runs everything unattended with --dangerously-skip-permissions. There is no
 * third option in its protocol — `can_use_tool` does not exist in that binary.
 *
 * What it does do is execute every `run_command` as `<shell> -c "<command>"`,
 * resolving the shell name through PATH. So this broker puts its own `zsh`,
 * `bash` and `sh` at the front of the child's PATH. Each is a small Node
 * program that hands the command line to this process over a unix socket and
 * blocks until a human answers, then execs the real shell — or exits non-zero
 * with the denial, which the agent sees as a failed command and adapts to.
 *
 * The request surfaces as an ordinary `permission_request` event, so the phone,
 * the push notification, the timeout and the audit log are the same ones every
 * other agent uses.
 *
 * Scope: this gates shell commands. The CLI's file edits happen inside its own
 * process and never touch a shell, so they are not gated. See docs/SECURITY.md.
 */

export type BrokeredCommand = Readonly<{
  requestId: string;
  /** The full command line the agent wants to run. */
  command: string;
  cwd: string;
  /** Which shim caught it, for diagnostics. */
  shell: string;
}>;

export type BrokerDecision = Readonly<{ decision: 'allow' | 'deny'; reason?: string }>;

/** Shell names the CLI might pick. It uses the basename, resolved via PATH. */
const SHIMMED_SHELLS = ['zsh', 'bash', 'sh'] as const;

/** Where a real shell might live, in preference order. */
const SHELL_DIRS = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];

type Pending = {
  resolve: (decision: BrokerDecision) => void;
  socket: net.Socket;
};

export class CommandApprovalBroker {
  private server: net.Server | null = null;
  private dir: string | null = null;
  private readonly pending = new Map<string, Pending>();
  /** Live shim connections, so shutdown can let them read their answer first. */
  private readonly sockets = new Set<net.Socket>();
  private onRequest: ((request: BrokeredCommand) => void) | null = null;
  private stopped = false;

  constructor(private readonly options: { cwd: string; log?: { warn: (o: unknown, m: string) => void } }) {}

  /** Directory to prepend to the child's PATH. Null until start() has run. */
  get binDir(): string | null {
    return this.dir === null ? null : path.join(this.dir, 'bin');
  }

  handleRequest(listener: (request: BrokeredCommand) => void): void {
    this.onRequest = listener;
  }

  async start(): Promise<void> {
    if (this.server) return;

    // 0700 so no other user on the machine can reach the approval socket.
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devtunnel-approve-'));
    await fsp.chmod(root, 0o700);
    this.dir = root;
    await fsp.mkdir(path.join(root, 'bin'), { recursive: true, mode: 0o700 });

    const socketPath = path.join(root, 'sock');
    const server = net.createServer((socket) => this.handleConnection(socket));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    await fsp.chmod(socketPath, 0o600).catch(() => {});

    for (const shell of SHIMMED_SHELLS) {
      const real = resolveRealShell(shell);
      if (!real) continue;
      const shimPath = path.join(root, 'bin', shell);
      await fsp.writeFile(shimPath, shimSource(socketPath, real), { mode: 0o755 });
    }
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = '';
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = '';
      this.handleAsk(socket, line);
    });
    socket.on('error', () => socket.destroy());
  }

  private handleAsk(socket: net.Socket, line: string): void {
    let parsed: { command?: unknown; cwd?: unknown; shell?: unknown };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      // Unparseable means something other than our shim is talking; fail closed.
      respond(socket, { decision: 'deny', reason: 'Malformed approval request.' });
      return;
    }

    if (this.stopped || !this.onRequest) {
      respond(socket, { decision: 'deny', reason: 'The session is shutting down.' });
      return;
    }

    const requestId = `cmd-${randomUUID()}`;
    const request: BrokeredCommand = Object.freeze({
      requestId,
      command: typeof parsed.command === 'string' ? parsed.command : '',
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : this.options.cwd,
      shell: typeof parsed.shell === 'string' ? parsed.shell : 'sh',
    });

    // A shim that goes away (killed CLI, cancelled turn) must not leak a pending
    // approval that the phone would still be showing.
    socket.once('close', () => this.pending.delete(requestId));

    this.pending.set(requestId, {
      socket,
      resolve: (decision) => respond(socket, decision),
    });
    this.onRequest(request);
  }

  /** True when the id belonged to this broker, so callers can tell it apart. */
  resolve(requestId: string, decision: BrokerDecision): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    entry.resolve(decision);
    return true;
  }

  has(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /** Release every waiting command, so no shell is left blocked forever. */
  denyAll(reason: string): void {
    for (const requestId of [...this.pending.keys()]) {
      this.resolve(requestId, { decision: 'deny', reason });
    }
  }

  async stop(reason = 'The session ended.'): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.denyAll(reason);

    // Let every shim actually read its denial. Tearing the socket down first
    // would kill them mid-read, and a shim that cannot tell allow from crash
    // has to assume the worst — which strands a shell instead of denying it.
    await this.drainSockets();

    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    if (this.dir) {
      await fsp.rm(this.dir, { recursive: true, force: true }).catch(() => {});
      this.dir = null;
    }
  }

  private async drainSockets(timeoutMs = 2000): Promise<void> {
    if (this.sockets.size === 0) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        if (this.sockets.size === 0) finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      let settled = false;
      function finish(): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      }
      for (const socket of this.sockets) socket.once('close', done);
      done();
    });
  }
}

function respond(socket: net.Socket, decision: BrokerDecision): void {
  try {
    socket.end(JSON.stringify(decision) + '\n');
  } catch {
    /* the shim is already gone; nothing to answer */
  }
}

function resolveRealShell(name: string): string | null {
  for (const dir of SHELL_DIRS) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * The shim, as source. It runs under the same Node binary as the server (the
 * shebang is an absolute path to it), so it needs nothing on PATH itself —
 * which matters, because PATH is exactly what this is interposing on.
 *
 * It fails closed: any error reaching the broker denies the command rather than
 * running it. A broken approval path must never become an open one.
 */
function shimSource(socketPath: string, realShell: string): string {
  const shellName = path.basename(realShell);
  return `#!${process.execPath}
'use strict';
// Generated by DevTunnel. Intercepts \`${shellName} -c "<command>"\` so a human
// can approve the command before it runs. Deleted when the session ends.
const net = require('node:net');
const { spawnSync } = require('node:child_process');

const SOCKET = ${JSON.stringify(socketPath)};
const REAL_SHELL = ${JSON.stringify(realShell)};
const argv = process.argv.slice(2);

// Reconstruct what the agent asked for. \`-c\` carries the command line; an
// interactive or script invocation has no command string to show.
const dashC = argv.indexOf('-c');
const command = dashC !== -1 && argv[dashC + 1] !== undefined
  ? String(argv[dashC + 1])
  : argv.join(' ');

function run() {
  const result = spawnSync(REAL_SHELL, argv, { stdio: 'inherit' });
  if (result.error) {
    process.stderr.write(String(result.error.message) + '\\n');
    process.exit(126);
  }
  if (result.signal) process.exit(128);
  process.exit(result.status === null ? 1 : result.status);
}

function deny(reason) {
  process.stderr.write('Denied by the user: ' + reason + '\\n');
  process.exit(1);
}

const socket = net.connect(SOCKET);
let buffer = '';
let settled = false;

socket.setEncoding('utf8');
socket.on('connect', () => {
  socket.write(JSON.stringify({ command, cwd: process.cwd(), shell: ${JSON.stringify(shellName)} }) + '\\n');
});
socket.on('data', (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf('\\n');
  if (newline === -1 || settled) return;
  settled = true;
  let decision;
  try {
    decision = JSON.parse(buffer.slice(0, newline));
  } catch {
    return deny('the approval response could not be read.');
  }
  socket.end();
  if (decision && decision.decision === 'allow') return run();
  return deny((decision && decision.reason) || 'no reason given.');
});
socket.on('error', () => {
  if (!settled) { settled = true; deny('the approval service is unreachable.'); }
});
socket.on('close', () => {
  if (!settled) { settled = true; deny('the approval service closed the connection.'); }
});
`;
}
