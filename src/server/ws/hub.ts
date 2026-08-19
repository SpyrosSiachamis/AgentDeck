import type { WebSocket } from 'ws';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { Identity } from '../auth.js';
import type { SessionManager } from '../sessions/manager.js';
import { SessionBusyError, SessionNotRunningError } from '../sessions/session.js';
import { WorkspaceError, type WorkspaceRegistry } from '../workspaces.js';
import type { SessionEvent } from '../sessions/events.js';
import { clientMessageSchema, type ServerMessage } from './protocol.js';

const MAX_INVALID_MESSAGES = 10;
const MAX_SUBSCRIPTIONS_PER_SOCKET = 8;
const REPLAY_LIMIT = 800;

/**
 * One connection from one phone. Holds per-session subscriptions and replays
 * missed events on reconnect using the sequence number the client last saw.
 */
class Connection {
  private readonly unsubscribers = new Map<string, () => void>();
  private invalidCount = 0;
  private closed = false;
  /** Coalesce bursts of deltas into one frame per tick. */
  private readonly outbox = new Map<string, SessionEvent[]>();
  private flushScheduled = false;

  constructor(
    readonly socket: WebSocket,
    readonly identity: Identity,
    private readonly deps: {
      config: Config;
      log: Logger;
      sessions: SessionManager;
      workspaces: WorkspaceRegistry;
    },
  ) {}

  send(message: ServerMessage): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch (err) {
      this.deps.log.warn({ err: (err as Error).message }, 'failed to send websocket frame');
    }
  }

  private sendError(code: string, message: string, extra?: { sessionId?: string; clientMsgId?: string }): void {
    this.send({ t: 'error', code, message, ...extra });
  }

  async handleRaw(raw: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.rejectInvalid('invalid_json', 'Message is not valid JSON');
      return;
    }
    const parsed = clientMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.rejectInvalid('invalid_message', parsed.error.issues[0]?.message ?? 'Unrecognised message');
      return;
    }
    await this.handle(parsed.data);
  }

  private rejectInvalid(code: string, message: string): void {
    this.invalidCount += 1;
    this.sendError(code, message);
    if (this.invalidCount >= MAX_INVALID_MESSAGES) {
      this.deps.log.warn({ identity: this.identity.login }, 'closing socket after repeated invalid messages');
      this.socket.close(1008, 'too many invalid messages');
    }
  }

  private async handle(msg: ReturnType<typeof clientMessageSchema.parse>): Promise<void> {
    switch (msg.t) {
      case 'ping':
        this.send({ t: 'pong', serverTime: Date.now() });
        return;

      case 'list_sessions':
        this.send({ t: 'sessions', sessions: this.deps.sessions.list() });
        return;

      case 'subscribe':
        await this.subscribe(msg.sessionId, msg.sinceSeq);
        return;

      case 'unsubscribe': {
        this.unsubscribers.get(msg.sessionId)?.();
        this.unsubscribers.delete(msg.sessionId);
        return;
      }

      case 'instruct': {
        if (msg.text.length > this.deps.config.maxInstructionChars) {
          this.sendError('instruction_too_long', `Instruction exceeds ${this.deps.config.maxInstructionChars} characters`, {
            sessionId: msg.sessionId,
            clientMsgId: msg.clientMsgId,
          });
          return;
        }
        try {
          const session = this.deps.sessions.requireAuthorized(msg.sessionId);
          const instructionId = await session.instruct(msg.text, this.identity.login);
          this.send({ t: 'ack', clientMsgId: msg.clientMsgId, sessionId: msg.sessionId, instructionId });
        } catch (err) {
          this.sendError(errorCode(err), (err as Error).message, {
            sessionId: msg.sessionId,
            clientMsgId: msg.clientMsgId,
          });
        }
        return;
      }

      case 'cancel': {
        try {
          const session = this.deps.sessions.requireAuthorized(msg.sessionId);
          await session.cancel(`cancelled by ${this.identity.login ?? 'local user'}`);
        } catch (err) {
          this.sendError(errorCode(err), (err as Error).message, { sessionId: msg.sessionId });
        }
        return;
      }
    }
  }

  private async subscribe(sessionId: string, sinceSeq: number): Promise<void> {
    let session;
    try {
      session = this.deps.sessions.requireAuthorized(sessionId);
    } catch (err) {
      this.sendError(errorCode(err), (err as Error).message, { sessionId });
      return;
    }

    if (!this.unsubscribers.has(sessionId) && this.unsubscribers.size >= MAX_SUBSCRIPTIONS_PER_SOCKET) {
      this.sendError('too_many_subscriptions', 'Too many active subscriptions on this connection', { sessionId });
      return;
    }

    this.unsubscribers.get(sessionId)?.();

    // Replay first, then attach: events produced during the await are captured
    // by the buffer below and de-duplicated by sequence number.
    const history = await session.historySince(sinceSeq, REPLAY_LIMIT);
    const buffered: SessionEvent[] = [];
    let live = false;
    const unsubscribe = session.subscribe(
      (events) => {
        if (!live) buffered.push(...events);
        else this.queue(sessionId, events);
      },
      (summary) => this.send({ t: 'session', session: summary }),
    );
    this.unsubscribers.set(sessionId, unsubscribe);

    this.send({
      t: 'subscribed',
      sessionId,
      lastSeq: session.lastSeq,
      gapSkipped: history.skipped,
    });
    if (history.events.length) this.send({ t: 'events', sessionId, events: history.events });

    const highest = history.events.at(-1)?.seq ?? sinceSeq;
    const catchUp = buffered.filter((e) => e.seq > highest);
    if (catchUp.length) this.send({ t: 'events', sessionId, events: catchUp });
    live = true;

    this.send({ t: 'session', session: session.summary() });
  }

  /** Batch outbound events so token-level deltas do not flood the socket. */
  private queue(sessionId: string, events: SessionEvent[]): void {
    const list = this.outbox.get(sessionId) ?? [];
    list.push(...events);
    this.outbox.set(sessionId, list);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setTimeout(() => {
      this.flushScheduled = false;
      for (const [id, batch] of this.outbox) {
        if (batch.length) this.send({ t: 'events', sessionId: id, events: batch });
      }
      this.outbox.clear();
    }, 40).unref?.();
  }

  close(): void {
    this.closed = true;
    for (const unsubscribe of this.unsubscribers.values()) unsubscribe();
    this.unsubscribers.clear();
  }
}

export class WebSocketHub {
  private readonly connections = new Set<Connection>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: {
      config: Config;
      log: Logger;
      sessions: SessionManager;
      workspaces: WorkspaceRegistry;
    },
  ) {
    // Session-level state changes are broadcast to everyone, so the session list
    // on the phone stays correct even without an active subscription.
    deps.sessions.onSessionState((summary) => {
      for (const connection of this.connections) connection.send({ t: 'session', session: summary });
    });

    this.heartbeat = setInterval(() => {
      for (const connection of this.connections) {
        if (connection.socket.readyState === connection.socket.OPEN) connection.socket.ping();
      }
    }, 30_000);
    this.heartbeat.unref?.();
  }

  handleConnection(socket: WebSocket, identity: Identity): void {
    const connection = new Connection(socket, identity, this.deps);
    this.connections.add(connection);
    this.deps.log.info({ identity: identity.login, connections: this.connections.size }, 'websocket connected');

    connection.send({
      t: 'welcome',
      identity: {
        login: identity.login,
        displayName: identity.displayName,
        viaTailscale: identity.viaTailscale,
      },
      workspaces: this.deps.workspaces.listPublic(),
      sessions: this.deps.sessions.list(),
      limits: {
        maxConcurrentSessions: this.deps.config.maxConcurrentSessions,
        maxInstructionChars: this.deps.config.maxInstructionChars,
      },
      serverTime: Date.now(),
    });

    socket.on('message', (data: Buffer | string, isBinary?: boolean) => {
      if (isBinary) {
        connection.send({ t: 'error', code: 'binary_unsupported', message: 'Binary frames are not accepted' });
        return;
      }
      const raw = typeof data === 'string' ? data : data.toString('utf8');
      if (raw.length > this.deps.config.maxWsPayloadBytes) {
        connection.send({ t: 'error', code: 'payload_too_large', message: 'Message too large' });
        return;
      }
      void connection.handleRaw(raw).catch((err: Error) => {
        this.deps.log.error({ err: err.message }, 'unhandled websocket message error');
        connection.send({ t: 'error', code: 'internal_error', message: 'Internal error handling message' });
      });
    });

    socket.on('close', () => {
      connection.close();
      this.connections.delete(connection);
      this.deps.log.info({ connections: this.connections.size }, 'websocket disconnected');
    });

    socket.on('error', (err: Error) => {
      this.deps.log.warn({ err: err.message }, 'websocket error');
    });
  }

  broadcastSessions(): void {
    const sessions = this.deps.sessions.list();
    for (const connection of this.connections) connection.send({ t: 'sessions', sessions });
  }

  async shutdown(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const connection of this.connections) {
      connection.close();
      try {
        connection.socket.close(1001, 'server shutting down');
      } catch {
        /* ignore */
      }
    }
    this.connections.clear();
  }
}

function errorCode(err: unknown): string {
  if (err instanceof WorkspaceError) return err.code;
  if (err instanceof SessionBusyError) return err.code;
  if (err instanceof SessionNotRunningError) return err.code;
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? code : 'error';
}
