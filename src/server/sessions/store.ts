import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { SessionEvent } from './events.js';
import type { Logger } from '../logger.js';

/**
 * Persistent session metadata plus an append-only event log, so history
 * survives a browser reload, a server restart, or a crashed CLI process.
 */

export type PersistedSession = {
  id: string;
  workspaceId: string;
  title: string;
  adapterId: string;
  model: string | null;
  permissionMode: string | null;
  cliSessionId: string | null;
  state: string;
  createdAt: number;
  updatedAt: number;
  lastSeq: number;
  createdBy: string | null;
  exit?: { code: number | null; signal: string | null; reason: string } | null;
};

const SESSION_ID = /^[A-Za-z0-9_-]{6,64}$/;

export class SessionStore {
  constructor(
    private readonly root: string,
    private readonly log: Logger,
  ) {}

  async init(): Promise<void> {
    await fsp.mkdir(this.sessionsDir(), { recursive: true, mode: 0o700 });
    await fsp.chmod(this.root, 0o700).catch(() => {});
  }

  private sessionsDir(): string {
    return path.join(this.root, 'sessions');
  }

  private dir(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new Error(`invalid session id: ${sessionId.slice(0, 32)}`);
    return path.join(this.sessionsDir(), sessionId);
  }

  metaPath(sessionId: string): string {
    return path.join(this.dir(sessionId), 'meta.json');
  }

  eventsPath(sessionId: string): string {
    return path.join(this.dir(sessionId), 'events.jsonl');
  }

  async writeMeta(meta: PersistedSession): Promise<void> {
    const dir = this.dir(meta.id);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `meta.json.${process.pid}.tmp`);
    await fsp.writeFile(tmp, JSON.stringify(meta, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, this.metaPath(meta.id));
  }

  /**
   * Append events to the session log. The promise resolves once the bytes are
   * handed to the OS, so shutdown can wait for it — otherwise the final batch
   * can be lost and the log would fall behind the metadata.
   */
  async appendEvents(sessionId: string, events: SessionEvent[]): Promise<void> {
    if (events.length === 0) return;
    const file = this.eventsPath(sessionId);
    const payload = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    try {
      await fsp.appendFile(file, payload, { mode: 0o600 });
    } catch (err) {
      this.log.warn({ sessionId, err: (err as Error).message }, 'failed to append session events');
    }
  }

  async listMeta(): Promise<PersistedSession[]> {
    let entries: string[];
    try {
      entries = await fsp.readdir(this.sessionsDir());
    } catch {
      return [];
    }
    const out: PersistedSession[] = [];
    for (const entry of entries) {
      if (!SESSION_ID.test(entry)) continue;
      try {
        const raw = await fsp.readFile(this.metaPath(entry), 'utf8');
        const meta = JSON.parse(raw) as PersistedSession;
        if (meta && typeof meta.id === 'string' && meta.id === entry) out.push(meta);
      } catch (err) {
        this.log.warn({ sessionId: entry, err: (err as Error).message }, 'skipping unreadable session metadata');
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Read persisted events with seq > sinceSeq, newest-biased: at most `limit`
   * events are returned, and the caller is told whether older ones were skipped.
   */
  async readEvents(
    sessionId: string,
    sinceSeq: number,
    limit: number,
  ): Promise<{ events: SessionEvent[]; skipped: number }> {
    const file = this.eventsPath(sessionId);
    if (!fs.existsSync(file)) return { events: [], skipped: 0 };

    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const buffer: SessionEvent[] = [];
    let skipped = 0;
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        let event: SessionEvent;
        try {
          event = JSON.parse(line) as SessionEvent;
        } catch {
          continue;
        }
        if (typeof event.seq !== 'number' || event.seq <= sinceSeq) continue;
        buffer.push(event);
        if (buffer.length > limit) {
          buffer.shift();
          skipped += 1;
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }
    return { events: buffer, skipped };
  }

  /**
   * The highest sequence number actually on disk. Metadata is written
   * asynchronously and can lag behind the event log if the server dies, so
   * restoring a session trusts the log over `meta.lastSeq` — otherwise a
   * resumed session would hand out sequence numbers that are already in use.
   */
  async lastSeqOnDisk(sessionId: string): Promise<number> {
    const file = this.eventsPath(sessionId);
    let handle: fsp.FileHandle | undefined;
    try {
      handle = await fsp.open(file, 'r');
      const { size } = await handle.stat();
      if (size === 0) return 0;
      const window = Math.min(size, 128 * 1024);
      const buffer = Buffer.alloc(window);
      await handle.read(buffer, 0, window, size - window);
      const lines = buffer.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim();
        if (!line) continue;
        try {
          const seq = (JSON.parse(line) as SessionEvent).seq;
          if (typeof seq === 'number' && Number.isFinite(seq)) return seq;
        } catch {
          continue; // a torn final line: keep looking backwards
        }
      }
      return 0;
    } catch {
      return 0;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async remove(sessionId: string): Promise<void> {
    await fsp.rm(this.dir(sessionId), { recursive: true, force: true });
  }
}
