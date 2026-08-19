import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { Workspace } from '../workspaces.js';
import type { CLIAdapter, CLIAdapterFactory, AdapterState } from '../adapters/types.js';
import { truncateText, type SessionEvent, type SessionEventBody } from './events.js';
import type { PersistedSession, SessionStore } from './store.js';

export type SessionState =
  | 'starting'
  | 'idle'
  | 'busy'
  | 'cancelling'
  | 'exited'
  | 'crashed'
  /** Persisted session whose process is gone (e.g. after a server restart). */
  | 'orphaned';

export type SessionSummary = Readonly<{
  id: string;
  workspaceId: string;
  workspaceName: string;
  title: string;
  state: SessionState;
  model: string | null;
  cliSessionId: string | null;
  createdAt: number;
  updatedAt: number;
  lastSeq: number;
  pid: number | null;
  live: boolean;
  /** True when the session can be brought back with resume(). */
  resumable: boolean;
  pendingInstructions: number;
  createdBy: string | null;
  exit?: { code: number | null; signal: string | null; reason: string } | null;
}>;

type Listener = (events: SessionEvent[]) => void;
type StateListener = (summary: SessionSummary) => void;

const MAX_PENDING_INSTRUCTIONS = 5;

export class SessionBusyError extends Error {
  readonly code = 'session_busy';
}
export class SessionNotRunningError extends Error {
  readonly code = 'session_not_running';
}

export class Session {
  private adapter: CLIAdapter | null = null;
  private seq = 0;
  private readonly ring: SessionEvent[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly stateListeners = new Set<StateListener>();
  private state: SessionState;
  private pendingInstructions = 0;
  private cliSessionId: string | null = null;
  private model: string | null;
  private lastActivityAt = Date.now();
  private turnStartedAt: number | null = null;
  private exit: { code: number | null; signal: string | null; reason: string } | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private pendingPersist: SessionEvent[] = [];

  constructor(
    readonly id: string,
    readonly workspace: Workspace,
    private readonly deps: {
      config: Config;
      log: Logger;
      store: SessionStore;
      factory: CLIAdapterFactory;
    },
    private meta: {
      title: string;
      createdAt: number;
      createdBy: string | null;
      model: string | null;
      permissionMode: string | null;
    },
    restored?: PersistedSession,
    /** Highest sequence found in the on-disk log, which can exceed meta.lastSeq. */
    restoredSeqFloor = 0,
  ) {
    this.model = meta.model;
    this.state = restored ? 'orphaned' : 'starting';
    if (restored) {
      this.seq = Math.max(restored.lastSeq, restoredSeqFloor);
      this.cliSessionId = restored.cliSessionId;
      this.exit = restored.exit ?? null;
      this.lastActivityAt = restored.updatedAt;
    }
  }

  // ------------------------------------------------------------- lifecycle

  async start(resume = false): Promise<void> {
    if (this.adapter) throw new Error('session already has a process');
    const adapter = this.deps.factory.create({
      cwd: this.workspace.path,
      model: this.meta.model ?? this.deps.config.cliModel ?? undefined,
      permissionMode: this.meta.permissionMode ?? this.deps.config.cliPermissionMode,
      resumeCliSessionId: resume ? this.cliSessionId : null,
      limits: {
        maxEventTextChars: this.deps.config.maxEventTextChars,
        maxEventLineBytes: this.deps.config.maxEventLineBytes,
        maxSessionOutputBytes: this.deps.config.maxSessionOutputBytes,
        cancelGraceMs: this.deps.config.cancelGraceMs,
      },
    });
    this.adapter = adapter;
    this.setState('starting');

    adapter.streamEvents(
      (event) => this.record(event),
      (adapterState) => this.onAdapterState(adapterState),
    );

    try {
      await adapter.startSession();
    } catch (err) {
      this.adapter = null;
      this.setState('crashed');
      this.record({
        type: 'error',
        message: `Could not start the CLI process: ${(err as Error).message}`,
        fatal: true,
      });
      throw err;
    }
    this.persistMeta();
  }

  /** Re-attach to a dead session by replaying its CLI-side conversation. */
  async resume(): Promise<void> {
    if (this.live) return;
    this.adapter = null;
    this.exit = null;
    this.pendingInstructions = 0;
    await this.start(true);
    this.record({
      type: 'notice',
      message: this.cliSessionId
        ? 'Reattached to the existing CLI conversation.'
        : 'Started a fresh CLI process for this session.',
    });
  }

  async instruct(text: string, author: string | null): Promise<string> {
    if (!this.adapter || !this.live) throw new SessionNotRunningError('session process is not running');
    if (this.pendingInstructions >= MAX_PENDING_INSTRUCTIONS) {
      throw new SessionBusyError(`at most ${MAX_PENDING_INSTRUCTIONS} queued instructions`);
    }

    const instructionId = randomUUID();
    const { text: clipped } = truncateText(text, this.deps.config.maxInstructionChars);
    this.pendingInstructions += 1;
    this.turnStartedAt = Date.now();
    this.record({ type: 'turn_started', instructionId, text: clipped });
    if (this.meta.title === DEFAULT_TITLE) {
      this.meta.title = deriveTitle(clipped);
      this.persistMeta();
    }
    try {
      await this.adapter.sendInstruction(clipped);
    } catch (err) {
      this.pendingInstructions = Math.max(0, this.pendingInstructions - 1);
      this.record({
        type: 'error',
        message: `Instruction could not be delivered: ${(err as Error).message}`,
        fatal: false,
      });
      throw err;
    }
    this.deps.log.info({ sessionId: this.id, author, chars: clipped.length }, 'instruction sent');
    return instructionId;
  }

  async cancel(reason: string): Promise<void> {
    if (!this.adapter) throw new SessionNotRunningError('session process is not running');
    this.setState('cancelling');
    this.pendingInstructions = 0;
    await this.adapter.cancel(reason);
  }

  async terminate(reason: string): Promise<void> {
    if (!this.adapter) {
      this.setState('exited');
      this.persistMeta();
      return;
    }
    await this.adapter.terminate(reason);
    this.adapter = null;
    this.persistMeta();
  }

  // ------------------------------------------------------------- streaming

  subscribe(listener: Listener, onState?: StateListener): () => void {
    this.listeners.add(listener);
    if (onState) this.stateListeners.add(onState);
    return () => {
      this.listeners.delete(listener);
      if (onState) this.stateListeners.delete(onState);
    };
  }

  /**
   * Events still held in memory with seq > sinceSeq. `complete` means memory
   * alone can answer the request; an empty ring is only complete when the
   * session has genuinely produced nothing past `sinceSeq` — after a restart
   * the ring is empty but the on-disk log is not.
   */
  eventsSince(sinceSeq: number): { events: SessionEvent[]; complete: boolean } {
    const first = this.ring[0];
    if (!first) return { events: [], complete: this.seq <= sinceSeq };
    return { events: this.ring.filter((e) => e.seq > sinceSeq), complete: first.seq <= sinceSeq + 1 };
  }

  /** Full history including events already evicted from memory. */
  async historySince(sinceSeq: number, limit: number): Promise<{ events: SessionEvent[]; skipped: number }> {
    const inMemory = this.eventsSince(sinceSeq);
    if (inMemory.complete) return { events: inMemory.events.slice(-limit), skipped: 0 };
    this.flushPersist();
    return this.deps.store.readEvents(this.id, sinceSeq, limit);
  }

  private record(body: SessionEventBody): void {
    const event: SessionEvent = { ...body, seq: ++this.seq, ts: Date.now(), sessionId: this.id };
    this.lastActivityAt = event.ts;

    this.ring.push(event);
    if (this.ring.length > this.deps.config.maxEventsInMemory) {
      this.ring.splice(0, this.ring.length - this.deps.config.maxEventsInMemory);
    }

    this.pendingPersist.push(event);
    this.schedulePersist();

    if (body.type === 'turn_finished' || body.type === 'session_cancelled') {
      this.pendingInstructions = Math.max(0, this.pendingInstructions - 1);
      this.turnStartedAt = null;
    }
    if (body.type === 'session_started' && body.cliSessionId) {
      this.cliSessionId = body.cliSessionId;
      this.model = body.model ?? this.model;
      this.persistMeta();
    }
    if (body.type === 'session_finished') {
      this.exit = { code: body.code, signal: body.signal, reason: body.reason };
      this.persistMeta();
    }

    for (const listener of this.listeners) {
      try {
        listener([event]);
      } catch (err) {
        this.deps.log.warn({ sessionId: this.id, err: (err as Error).message }, 'event listener failed');
      }
    }
  }

  /** Batch disk writes; a chatty CLI would otherwise cause one write per token. */
  private schedulePersist(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flushPersist(), 250);
    this.flushTimer.unref?.();
  }

  flushPersist(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingPersist.length === 0) return;
    const batch = this.pendingPersist;
    this.pendingPersist = [];
    this.deps.store.appendEvents(this.id, batch);
  }

  // ------------------------------------------------------------------ state

  private onAdapterState(adapterState: AdapterState): void {
    this.cliSessionId = adapterState.cliSessionId ?? this.cliSessionId;
    this.model = adapterState.model ?? this.model;
    switch (adapterState.status) {
      case 'starting':
        this.setState('starting');
        break;
      case 'idle':
        this.setState('idle');
        break;
      case 'busy':
        this.setState('busy');
        break;
      case 'cancelling':
        this.setState('cancelling');
        break;
      case 'exited':
        this.setState('exited');
        this.adapter = null;
        this.persistMeta();
        break;
      case 'crashed':
        this.setState('crashed');
        this.adapter = null;
        this.persistMeta();
        break;
    }
  }

  private setState(next: SessionState): void {
    if (this.state === next) return;
    this.state = next;
    this.lastActivityAt = Date.now();
    const summary = this.summary();
    for (const listener of this.stateListeners) {
      try {
        listener(summary);
      } catch {
        /* a broken subscriber must not break the session */
      }
    }
  }

  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  get live(): boolean {
    return this.state === 'starting' || this.state === 'idle' || this.state === 'busy' || this.state === 'cancelling';
  }

  get idleForMs(): number {
    return Date.now() - this.lastActivityAt;
  }

  get turnRunningForMs(): number | null {
    return this.turnStartedAt === null ? null : Date.now() - this.turnStartedAt;
  }

  get lastSeq(): number {
    return this.seq;
  }

  summary(): SessionSummary {
    return Object.freeze({
      id: this.id,
      workspaceId: this.workspace.id,
      workspaceName: this.workspace.name,
      title: this.meta.title,
      state: this.state,
      model: this.model,
      cliSessionId: this.cliSessionId,
      createdAt: this.meta.createdAt,
      updatedAt: this.lastActivityAt,
      lastSeq: this.seq,
      pid: this.adapter?.getStatus().pid ?? null,
      live: this.live,
      resumable: !this.live && this.cliSessionId !== null,
      pendingInstructions: this.pendingInstructions,
      createdBy: this.meta.createdBy,
      exit: this.exit,
    });
  }

  toPersisted(): PersistedSession {
    return {
      id: this.id,
      workspaceId: this.workspace.id,
      title: this.meta.title,
      adapterId: this.deps.factory.id,
      model: this.model,
      permissionMode: this.meta.permissionMode,
      cliSessionId: this.cliSessionId,
      state: this.state,
      createdAt: this.meta.createdAt,
      updatedAt: this.lastActivityAt,
      lastSeq: this.seq,
      createdBy: this.meta.createdBy,
      exit: this.exit,
    };
  }

  /** Returns the write promise so shutdown can wait for it; callers mid-run don't. */
  persistMeta(): Promise<void> {
    return this.deps.store.writeMeta(this.toPersisted()).catch((err: Error) => {
      this.deps.log.warn({ sessionId: this.id, err: err.message }, 'failed to persist session metadata');
    });
  }
}

export const DEFAULT_TITLE = 'New session';

export function deriveTitle(instruction: string): string {
  const firstLine = instruction.split('\n').find((l) => l.trim().length > 0) ?? DEFAULT_TITLE;
  return truncateText(firstLine.trim(), 70).text;
}
