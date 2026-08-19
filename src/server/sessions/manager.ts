import { randomBytes } from 'node:crypto';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { WorkspaceError, type WorkspaceRegistry } from '../workspaces.js';
import { createAdapterFactory } from '../adapters/registry.js';
import type { CLIAdapterFactory } from '../adapters/types.js';
import { DEFAULT_TITLE, Session, type SessionSummary } from './session.js';
import { SessionStore, type PersistedSession } from './store.js';

export class SessionLimitError extends Error {
  readonly code = 'session_limit';
}
export class SessionNotFoundError extends Error {
  readonly code = 'session_not_found';
}

export type CreateSessionInput = {
  workspaceId: string;
  title?: string;
  model?: string | null;
  permissionMode?: string | null;
  createdBy: string | null;
};

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly factory: CLIAdapterFactory;
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly globalStateListeners = new Set<(summary: SessionSummary) => void>();
  private shuttingDown = false;

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    private readonly workspaces: WorkspaceRegistry,
    private readonly store: SessionStore,
  ) {
    this.factory = createAdapterFactory(config.cliAdapter, config.cliCommand);
  }

  async init(): Promise<void> {
    await this.store.init();
    await this.restore();
    this.sweepTimer = setInterval(() => this.sweep(), 30_000);
    this.sweepTimer.unref?.();
  }

  /**
   * Rebuild session records after a restart. The CLI processes died with the
   * previous server, so restored sessions start as `orphaned`; their history is
   * intact and `resume()` can reattach to the CLI-side conversation.
   */
  private async restore(): Promise<void> {
    const persisted = await this.store.listMeta();
    let restored = 0;
    for (const meta of persisted) {
      if (Date.now() - meta.updatedAt > this.config.sessionRetentionMs) {
        await this.store.remove(meta.id).catch(() => {});
        continue;
      }
      const workspace = this.workspaces.find(meta.workspaceId);
      if (!workspace) {
        this.log.warn(
          { sessionId: meta.id, workspaceId: meta.workspaceId },
          'session references a workspace that is no longer registered; skipping',
        );
        continue;
      }
      const seqFloor = await this.store.lastSeqOnDisk(meta.id);
      this.sessions.set(meta.id, this.buildSession(meta.id, workspace, meta, undefined, seqFloor));
      restored += 1;
    }
    if (restored) this.log.info({ restored }, 'restored persisted sessions');
  }

  private buildSession(
    id: string,
    workspace: ReturnType<WorkspaceRegistry['require']>,
    restored?: PersistedSession,
    fresh?: Partial<CreateSessionInput>,
    restoredSeqFloor = 0,
  ): Session {
    const session = new Session(
      id,
      workspace,
      { config: this.config, log: this.log, store: this.store, factory: this.factory },
      {
        title: restored?.title ?? fresh?.title ?? DEFAULT_TITLE,
        createdAt: restored?.createdAt ?? Date.now(),
        createdBy: restored?.createdBy ?? fresh?.createdBy ?? null,
        model: restored?.model ?? fresh?.model ?? workspace.model ?? (this.config.cliModel || null),
        permissionMode:
          restored?.permissionMode ??
          fresh?.permissionMode ??
          workspace.permissionMode ??
          this.config.cliPermissionMode,
      },
      restored,
      restoredSeqFloor,
    );
    session.onStateChange((summary) => {
      for (const listener of this.globalStateListeners) listener(summary);
    });
    return session;
  }

  onSessionState(listener: (summary: SessionSummary) => void): () => void {
    this.globalStateListeners.add(listener);
    return () => this.globalStateListeners.delete(listener);
  }

  get liveCount(): number {
    return [...this.sessions.values()].filter((s) => s.live).length;
  }

  async create(input: CreateSessionInput): Promise<Session> {
    if (this.shuttingDown) throw new Error('server is shutting down');
    // Throws for unknown or disabled ids; a path can never reach this point.
    const workspace = this.workspaces.require(input.workspaceId);

    if (this.liveCount >= this.config.maxConcurrentSessions) {
      throw new SessionLimitError(
        `Maximum of ${this.config.maxConcurrentSessions} concurrent sessions reached. Stop one first.`,
      );
    }

    const id = randomBytes(9).toString('base64url');
    const session = this.buildSession(id, workspace, undefined, input);
    this.sessions.set(id, session);

    try {
      await session.start(false);
    } catch (err) {
      this.sessions.delete(id);
      throw err;
    }
    this.log.info(
      { sessionId: id, workspaceId: workspace.id, createdBy: input.createdBy },
      'session started',
    );
    return session;
  }

  get(id: unknown): Session {
    if (typeof id !== 'string') throw new SessionNotFoundError('session not found');
    const session = this.sessions.get(id);
    if (!session) throw new SessionNotFoundError('session not found');
    return session;
  }

  /**
   * Authorization check for every session-scoped request: the session must
   * exist and its workspace must still be registered and enabled.
   */
  requireAuthorized(id: unknown): Session {
    const session = this.get(id);
    const workspace = this.workspaces.find(session.workspace.id);
    if (!workspace || !workspace.enabled) {
      throw new WorkspaceError(
        `Workspace "${session.workspace.id}" is no longer available`,
        'workspace_disabled',
      );
    }
    return session;
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .map((s) => s.summary())
      .sort((a, b) => Number(b.live) - Number(a.live) || b.updatedAt - a.updatedAt);
  }

  async resume(id: string): Promise<Session> {
    const session = this.requireAuthorized(id);
    if (session.live) return session;
    if (this.liveCount >= this.config.maxConcurrentSessions) {
      throw new SessionLimitError(
        `Maximum of ${this.config.maxConcurrentSessions} concurrent sessions reached. Stop one first.`,
      );
    }
    await session.resume();
    this.log.info({ sessionId: id }, 'session resumed');
    return session;
  }

  async terminate(id: string, reason: string): Promise<void> {
    const session = this.get(id);
    await session.terminate(reason);
    this.log.info({ sessionId: id, reason }, 'session terminated');
  }

  async remove(id: string): Promise<void> {
    const session = this.get(id);
    await session.terminate('deleted');
    session.flushPersist();
    this.sessions.delete(id);
    await this.store.remove(id).catch(() => {});
  }

  /** Periodic housekeeping: turn timeouts, idle timeouts, dead-session eviction. */
  private sweep(): void {
    for (const [id, session] of this.sessions) {
      const summary = session.summary();

      const turnMs = session.turnRunningForMs;
      if (summary.state === 'busy' && turnMs !== null && turnMs > this.config.turnTimeoutMs) {
        this.log.warn({ sessionId: id, turnMs }, 'turn exceeded timeout; cancelling');
        void session.cancel('turn timeout').catch(() => {});
        continue;
      }

      if (session.live && session.idleForMs > this.config.sessionIdleTimeoutMs) {
        this.log.warn({ sessionId: id, idleMs: session.idleForMs }, 'session idle timeout; terminating');
        void session.terminate('idle timeout').catch(() => {});
        continue;
      }

      if (!session.live && session.idleForMs > this.config.sessionRetentionMs) {
        this.log.info({ sessionId: id }, 'evicting expired session');
        session.flushPersist();
        this.sessions.delete(id);
        void this.store.remove(id).catch(() => {});
      }
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    const live = [...this.sessions.values()].filter((s) => s.live);
    this.log.info({ sessions: live.length }, 'terminating live sessions');
    await Promise.allSettled(live.map((s) => s.terminate('server shutdown')));
    // Metadata writes must complete before the process exits, or a restored
    // session would resume from a stale sequence number.
    await Promise.allSettled(
      [...this.sessions.values()].map((session) => {
        session.flushPersist();
        return session.persistMeta();
      }),
    );
  }
}
