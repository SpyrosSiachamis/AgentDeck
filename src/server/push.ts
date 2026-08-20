import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import webpush from 'web-push';
import type { Config } from './config.js';
import type { Logger } from './logger.js';

/**
 * Web Push delivery for the installed PWA.
 *
 * The point of this app is that the phone stays in a pocket while an agent
 * works, so the two moments that need a human — an approval prompt, and a
 * finished turn — have to reach a locked screen. A WebSocket cannot do that:
 * iOS suspends the tab within seconds of backgrounding. Web Push can, but only
 * for a PWA the user added to the Home Screen (iOS 16.4+).
 *
 * Delivery goes out to Apple/Mozilla/Google push endpoints, so this is the one
 * part of the server that talks to the public internet. It carries session
 * titles and one-line tool summaries; see docs/SECURITY.md.
 */

export type PushSubscriptionInput = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
};

export type PushSubscriptionRecord = PushSubscriptionInput & {
  /** Stable id derived from the endpoint, so re-subscribing is idempotent. */
  id: string;
  identity: string | null;
  userAgent: string | null;
  createdAt: number;
  updatedAt: number;
  lastNotifiedAt: number | null;
  failureCount: number;
};

/** What the service worker receives. Keep it small: push payloads are capped. */
export type PushPayload = {
  kind: 'permission_request' | 'turn_finished' | 'session_failed' | 'test';
  title: string;
  body: string;
  /** Notifications sharing a tag replace each other instead of stacking. */
  tag: string;
  url: string;
  sessionId: string | null;
  requestId?: string;
  ts: number;
  /** Keep the notification on screen until it is acted on (desktop only). */
  requireInteraction?: boolean;
};

export class PushError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const ENDPOINT_MAX = 2048;
const KEY_MAX = 256;
/** Push services reject large payloads; ours must survive AES-GCM padding. */
const PAYLOAD_MAX_BYTES = 3000;

export class PushService {
  private readonly subscriptions = new Map<string, PushSubscriptionRecord>();
  private writeChain: Promise<void> = Promise.resolve();
  private vapid: { publicKey: string; privateKey: string } | null = null;

  private constructor(
    private readonly config: Config,
    private readonly log: Logger,
  ) {}

  static async create(config: Config, log: Logger): Promise<PushService> {
    const service = new PushService(config, log);
    if (config.push.enabled) await service.init();
    return service;
  }

  private dir(): string {
    return path.join(this.config.stateDir, 'push');
  }

  private vapidPath(): string {
    return path.join(this.dir(), 'vapid.json');
  }

  private subscriptionsPath(): string {
    return path.join(this.dir(), 'subscriptions.json');
  }

  private async init(): Promise<void> {
    await fsp.mkdir(this.dir(), { recursive: true, mode: 0o700 });
    this.vapid = await this.loadVapid();
    await this.loadSubscriptions();
    this.log.info(
      { subscriptions: this.subscriptions.size },
      'web push enabled',
    );
  }

  /**
   * Keys come from the environment when supplied, otherwise from a file that is
   * generated once. Rotating them invalidates every existing subscription, so
   * the generated pair is deliberately sticky.
   */
  private async loadVapid(): Promise<{ publicKey: string; privateKey: string }> {
    if (this.config.push.publicKey && this.config.push.privateKey) {
      return { publicKey: this.config.push.publicKey, privateKey: this.config.push.privateKey };
    }
    try {
      const raw = await fsp.readFile(this.vapidPath(), 'utf8');
      const parsed = JSON.parse(raw) as { publicKey?: unknown; privateKey?: unknown };
      if (typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string') {
        return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
      }
      this.log.warn('stored VAPID key file is malformed; generating a new pair');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const generated = webpush.generateVAPIDKeys();
    await fsp.writeFile(this.vapidPath(), JSON.stringify(generated, null, 2), { mode: 0o600 });
    this.log.info('generated a VAPID key pair for web push');
    return generated;
  }

  private async loadSubscriptions(): Promise<void> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.subscriptionsPath(), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as { subscriptions?: PushSubscriptionRecord[] };
      for (const record of parsed.subscriptions ?? []) {
        if (typeof record?.endpoint === 'string' && record.keys?.p256dh && record.keys?.auth) {
          this.subscriptions.set(record.id ?? endpointId(record.endpoint), record);
        }
      }
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'could not read push subscriptions; starting empty');
    }
  }

  /** Serialised so concurrent subscribe/prune calls cannot interleave writes. */
  private persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      const payload = JSON.stringify({ subscriptions: [...this.subscriptions.values()] }, null, 2);
      const tmp = `${this.subscriptionsPath()}.tmp`;
      await fsp.writeFile(tmp, payload, { mode: 0o600 });
      await fsp.rename(tmp, this.subscriptionsPath());
    });
    return this.writeChain.catch((err: Error) => {
      this.log.warn({ err: err.message }, 'failed to persist push subscriptions');
    });
  }

  get enabled(): boolean {
    return this.config.push.enabled && this.vapid !== null;
  }

  get publicKey(): string | null {
    return this.vapid?.publicKey ?? null;
  }

  get count(): number {
    return this.subscriptions.size;
  }

  /** Endpoints are secrets in their own right, so only counts leave the server. */
  summary(identity: string | null): { enabled: boolean; publicKey: string | null; devices: number; mine: number } {
    let mine = 0;
    for (const record of this.subscriptions.values()) {
      if (identity && record.identity === identity) mine += 1;
    }
    return { enabled: this.enabled, publicKey: this.publicKey, devices: this.subscriptions.size, mine };
  }

  /**
   * Awaits the write: a 201 from the subscribe route has to mean the device is
   * actually registered, not that it will be shortly.
   */
  async add(
    input: PushSubscriptionInput,
    meta: { identity: string | null; userAgent: string | null },
  ): Promise<PushSubscriptionRecord> {
    if (!this.enabled) throw new PushError('Web push is disabled on this server', 'push_disabled', 409);
    validateSubscription(input);

    const id = endpointId(input.endpoint);
    const existing = this.subscriptions.get(id);
    const now = Date.now();
    const record: PushSubscriptionRecord = {
      id,
      endpoint: input.endpoint,
      keys: { p256dh: input.keys.p256dh, auth: input.keys.auth },
      expirationTime: input.expirationTime ?? null,
      identity: meta.identity,
      userAgent: meta.userAgent ? meta.userAgent.slice(0, 200) : null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastNotifiedAt: existing?.lastNotifiedAt ?? null,
      failureCount: 0,
    };

    if (!existing && this.subscriptions.size >= this.config.push.maxSubscriptions) {
      // Evict the stalest device rather than refusing a phone the user just set up.
      const oldest = [...this.subscriptions.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (oldest) this.subscriptions.delete(oldest.id);
    }

    this.subscriptions.set(id, record);
    await this.persist();
    this.log.info({ identity: meta.identity, devices: this.subscriptions.size }, 'push subscription registered');
    return record;
  }

  async remove(endpoint: string): Promise<boolean> {
    if (typeof endpoint !== 'string' || endpoint.length === 0) return false;
    const removed = this.subscriptions.delete(endpointId(endpoint));
    if (removed) {
      await this.persist();
      this.log.info({ devices: this.subscriptions.size }, 'push subscription removed');
    }
    return removed;
  }

  /**
   * Fan a payload out to every registered device. Failures never propagate: a
   * dead phone must not be able to break a session's event pipeline.
   */
  async send(payload: PushPayload): Promise<{ sent: number; failed: number; pruned: number }> {
    if (!this.enabled || this.subscriptions.size === 0) return { sent: 0, failed: 0, pruned: 0 };

    const body = encodePayload(payload);
    const options = {
      TTL: this.config.push.ttlSeconds,
      urgency: payload.kind === 'permission_request' ? ('high' as const) : ('normal' as const),
      vapidDetails: {
        subject: this.config.push.subject,
        publicKey: this.vapid!.publicKey,
        privateKey: this.vapid!.privateKey,
      },
    };

    let sent = 0;
    let failed = 0;
    let pruned = 0;
    let dirty = false;

    await Promise.all(
      [...this.subscriptions.values()].map(async (record) => {
        try {
          await webpush.sendNotification(
            { endpoint: record.endpoint, keys: record.keys },
            body,
            options,
          );
          sent += 1;
          record.lastNotifiedAt = Date.now();
          if (record.failureCount !== 0) dirty = true;
          record.failureCount = 0;
        } catch (err) {
          failed += 1;
          const status = (err as { statusCode?: number }).statusCode ?? 0;
          // 404/410 mean the browser threw the subscription away for good.
          const gone = status === 404 || status === 410;
          record.failureCount += 1;
          dirty = true;
          if (gone || record.failureCount >= this.config.push.maxFailures) {
            this.subscriptions.delete(record.id);
            pruned += 1;
            this.log.info({ status, endpoint: hostOf(record.endpoint) }, 'dropped a dead push subscription');
          } else {
            this.log.warn(
              { status, err: (err as Error).message, endpoint: hostOf(record.endpoint) },
              'push delivery failed',
            );
          }
        }
      }),
    );

    if (sent > 0 || dirty) void this.persist();
    return { sent, failed, pruned };
  }
}

function endpointId(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('base64url').slice(0, 22);
}

/** Only the push service host is ever logged; the endpoint path is a capability. */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'unknown';
  }
}

function validateSubscription(input: PushSubscriptionInput): void {
  if (typeof input?.endpoint !== 'string' || input.endpoint.length === 0 || input.endpoint.length > ENDPOINT_MAX) {
    throw new PushError('Subscription endpoint is missing or too long', 'invalid_subscription');
  }
  let url: URL;
  try {
    url = new URL(input.endpoint);
  } catch {
    throw new PushError('Subscription endpoint is not a URL', 'invalid_subscription');
  }
  if (url.protocol !== 'https:') {
    throw new PushError('Subscription endpoint must be https', 'invalid_subscription');
  }
  for (const key of ['p256dh', 'auth'] as const) {
    const value = input.keys?.[key];
    if (typeof value !== 'string' || value.length === 0 || value.length > KEY_MAX) {
      throw new PushError(`Subscription key "${key}" is missing or malformed`, 'invalid_subscription');
    }
  }
}

/** Trim the body until the JSON fits inside the push service's payload limit. */
function encodePayload(payload: PushPayload): string {
  let candidate = { ...payload };
  let json = JSON.stringify(candidate);
  while (Buffer.byteLength(json) > PAYLOAD_MAX_BYTES && candidate.body.length > 16) {
    const keep = Math.max(16, Math.floor(candidate.body.length / 2));
    candidate = { ...candidate, body: `${candidate.body.slice(0, keep)}…` };
    json = JSON.stringify(candidate);
  }
  return json;
}
