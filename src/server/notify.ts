import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { SessionManager } from './sessions/manager.js';
import type { Session } from './sessions/session.js';
import type { SessionEvent } from './sessions/events.js';
import type { PushPayload, PushService } from './push.js';
import type { SettingsStore } from './settings.js';

/**
 * Translates session events into the handful of pushes worth waking a phone
 * for. Everything else — deltas, tool output, thinking — stays on the socket.
 */

/** Guards against a pathological CLI turning the lock screen into a strobe. */
const MIN_GAP_MS = 3_000;

export type VisibilityProbe = (sessionId: string) => boolean;

export type NotifyOptions = {
  /** Session title, used as the notification's subject line. */
  title: string;
  sessionId: string;
  notifyTurnFinished: boolean;
};

/**
 * The whole notification policy, as a pure function: which events are worth a
 * buzz, and what they say. Everything else about push is plumbing around this.
 */
export function payloadForEvent(event: SessionEvent, options: NotifyOptions): PushPayload | null {
  const { title, sessionId } = options;
  const url = `/#/s/${sessionId}`;

  switch (event.type) {
    case 'permission_request': {
      const detail = event.command?.trim() || event.summary || event.toolName;
      return {
        kind: 'permission_request',
        title: `Approval needed · ${title}`,
        body: `${event.displayName || event.toolName}: ${oneLine(detail, 160)}`,
        tag: `perm-${event.requestId}`,
        url,
        sessionId,
        requestId: event.requestId,
        ts: event.ts,
        requireInteraction: true,
      };
    }

    case 'turn_finished': {
      if (!options.notifyTurnFinished) return null;
      const detail = event.result?.trim();
      return {
        kind: 'turn_finished',
        title: event.isError ? `Turn failed · ${title}` : `Done · ${title}`,
        body: detail
          ? oneLine(detail, 220)
          : event.isError
            ? 'The agent stopped with an error.'
            : 'The agent finished and is waiting for you.',
        // One tag per session: a newer result replaces the previous one.
        tag: `turn-${sessionId}`,
        url,
        sessionId,
        ts: event.ts,
      };
    }

    case 'error': {
      if (!event.fatal) return null;
      return {
        kind: 'session_failed',
        title: `Session error · ${title}`,
        body: oneLine(event.message, 220),
        tag: `error-${sessionId}`,
        url,
        sessionId,
        ts: event.ts,
      };
    }

    default:
      return null;
  }
}

export class SessionNotifier {
  private readonly lastSentAt = new Map<string, number>();
  private unsubscribe: (() => void) | null = null;
  /** Answers "is this session on screen somewhere right now?"; set by the hub. */
  private isVisible: VisibilityProbe = () => false;

  constructor(
    private readonly config: Config,
    private readonly log: Logger,
    private readonly push: PushService,
    /** Lets the settings page turn "turn finished" pushes off at runtime. */
    private readonly settings?: SettingsStore,
  ) {}

  attach(sessions: SessionManager): void {
    if (this.unsubscribe) return;
    this.unsubscribe = sessions.onSessionEvent((event, session) => {
      const payload = this.payloadFor(event, session);
      if (!payload) return;
      void this.dispatch(payload);
    });
  }

  setVisibilityProbe(probe: VisibilityProbe): void {
    this.isVisible = probe;
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private payloadFor(event: SessionEvent, session: Session): PushPayload | null {
    if (!this.push.enabled) return null;
    return payloadForEvent(event, {
      title: session.summary().title,
      sessionId: session.id,
      notifyTurnFinished: this.settings?.notifyTurnFinished() ?? this.config.push.notifyTurnFinished,
    });
  }

  private async dispatch(payload: PushPayload): Promise<void> {
    // Someone is already looking at this session, so the in-page UI has it
    // covered. An approval still buzzes: it is the one thing that blocks the CLI.
    if (
      this.config.push.suppressWhenVisible &&
      payload.kind !== 'permission_request' &&
      payload.sessionId &&
      this.isVisible(payload.sessionId)
    ) {
      return;
    }

    const now = Date.now();
    const previous = this.lastSentAt.get(payload.tag) ?? 0;
    if (now - previous < MIN_GAP_MS) return;
    this.lastSentAt.set(payload.tag, now);
    if (this.lastSentAt.size > 500) this.pruneRateLimiter(now);

    try {
      const result = await this.push.send(payload);
      if (result.sent > 0 || result.failed > 0) {
        this.log.debug({ kind: payload.kind, ...result }, 'push notification dispatched');
      }
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'push notification failed');
    }
  }

  private pruneRateLimiter(now: number): void {
    for (const [tag, at] of this.lastSentAt) {
      if (now - at > 60 * 60 * 1000) this.lastSentAt.delete(tag);
    }
  }
}

/** Notification bodies are one line on a lock screen; make that line count. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
