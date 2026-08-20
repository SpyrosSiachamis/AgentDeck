/**
 * Web Push wiring for the browser client.
 *
 * The constraint that shapes all of this is iOS: Safari only grants push to a
 * PWA the user has added to their Home Screen, the permission prompt must come
 * from a real tap, and both are silent failures if you get them wrong. So this
 * module reports precisely *why* notifications are unavailable rather than
 * offering a button that does nothing.
 */

export type PushAvailability =
  | 'ready'
  | 'unsupported'
  | 'needs-install'
  | 'insecure-context'
  | 'server-disabled'
  | 'denied';

export type PushStatus = {
  availability: PushAvailability;
  /** Browser-level permission, or 'default' where the API does not exist. */
  permission: NotificationPermission;
  subscribed: boolean;
  /** Devices registered with the server for this identity, and in total. */
  devices: number;
  mine: number;
  detail: string;
  /**
   * How many action buttons this platform will draw on a notification. Safari,
   * including iOS, reports 0 and silently ignores the buttons, so Approve/Deny
   * can only be offered where this is at least 2.
   */
  maxActions: number;
};

type PushConfig = { enabled: boolean; publicKey: string | null; devices: number; mine: number };

const STORAGE_KEY = 'agentdeck.push.enabled';
/** The key this used before the rename; read once so nobody has to re-opt-in. */
const LEGACY_STORAGE_KEY = 'devtunnel.push.enabled';

let registration: ServiceWorkerRegistration | null = null;
let registering: Promise<ServiceWorkerRegistration | null> | null = null;
let cachedConfig: PushConfig | null = null;

export function pushApiSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** iOS/iPadOS grant push only to a Home Screen install, never to a Safari tab. */
function isAppleMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua);
  // iPadOS 13+ reports as a Mac; a touch-capable "Mac" is really an iPad.
  const iPadOS = /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
  return iOS || iPadOS;
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone;
  if (iosStandalone === true) return true;
  return Boolean(window.matchMedia?.('(display-mode: standalone)')?.matches);
}

function permission(): NotificationPermission {
  if (typeof Notification === 'undefined') return 'default';
  return Notification.permission;
}

/** 0 on Safari/iOS: it accepts the `actions` array and draws none of it. */
function maxActions(): number {
  if (typeof Notification === 'undefined') return 0;
  return (Notification as unknown as { maxActions?: number }).maxActions ?? 0;
}

function remembered(): boolean {
  try {
    const storage = window.localStorage;
    if (!storage) return false;
    if (storage.getItem(STORAGE_KEY) === '1') return true;

    // A device set up before the rename still holds a live push subscription;
    // losing this flag would show it as "off" and stop the re-sync on launch.
    if (storage.getItem(LEGACY_STORAGE_KEY) === '1') {
      storage.setItem(STORAGE_KEY, '1');
      storage.removeItem(LEGACY_STORAGE_KEY);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function remember(enabled: boolean): void {
  try {
    if (enabled) window.localStorage?.setItem(STORAGE_KEY, '1');
    else window.localStorage?.removeItem(STORAGE_KEY);
    window.localStorage?.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* private browsing; the subscription still works for this session */
  }
}

async function ensureRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (registration) return registration;
  if (!pushApiSupported()) return null;
  registering ??= navigator.serviceWorker
    .register('/sw.js', { scope: '/' })
    .then(async (reg) => {
      // pushManager is only usable once a worker is actually installed.
      registration = (await navigator.serviceWorker.ready.catch(() => reg)) ?? reg;
      return registration;
    })
    .catch(() => null);
  return registering;
}

async function serverConfig(force = false): Promise<PushConfig> {
  if (cachedConfig && !force) return cachedConfig;
  const response = await fetch('/api/push/config', { credentials: 'same-origin' });
  if (!response.ok) throw new Error('Could not read the notification settings from the server');
  const body = (await response.json()) as { push: PushConfig };
  cachedConfig = body.push;
  return cachedConfig;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await ensureRegistration();
  if (!reg) return null;
  return reg.pushManager.getSubscription().catch(() => null);
}

export async function pushStatus(): Promise<PushStatus> {
  const base = { permission: permission(), subscribed: false, devices: 0, mine: 0, maxActions: maxActions() };

  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return {
      ...base,
      availability: 'insecure-context',
      detail:
        'Notifications need a secure connection. Open the app through its https://…ts.net address rather than plain http.',
    };
  }
  if (!pushApiSupported()) {
    if (isAppleMobile() && !isStandalone()) {
      return {
        ...base,
        availability: 'needs-install',
        detail: 'On iPhone and iPad, notifications work only after you add AgentDeck to your Home Screen.',
      };
    }
    return {
      ...base,
      availability: 'unsupported',
      detail: 'This browser does not support web push notifications.',
    };
  }
  if (isAppleMobile() && !isStandalone()) {
    return {
      ...base,
      availability: 'needs-install',
      detail: 'On iPhone and iPad, notifications work only after you add AgentDeck to your Home Screen.',
    };
  }

  let config: PushConfig;
  try {
    config = await serverConfig();
  } catch (err) {
    return { ...base, availability: 'server-disabled', detail: (err as Error).message };
  }
  if (!config.enabled || !config.publicKey) {
    return {
      ...base,
      availability: 'server-disabled',
      detail: 'The server has web push turned off (PUSH_ENABLED=false).',
    };
  }

  const subscription = await currentSubscription();
  const status: PushStatus = {
    availability: permission() === 'denied' ? 'denied' : 'ready',
    permission: permission(),
    subscribed: Boolean(subscription) && remembered(),
    devices: config.devices,
    mine: config.mine,
    maxActions: maxActions(),
    detail:
      permission() === 'denied'
        ? 'Notifications are blocked for this app. Re-allow them in your device settings, then try again.'
        : '',
  };
  return status;
}

/**
 * Must be called from a user gesture: Safari ignores a permission request that
 * is not attached to a tap.
 */
export async function enablePush(): Promise<PushStatus> {
  const status = await pushStatus();
  if (status.availability === 'needs-install') throw new Error(status.detail);
  if (status.availability === 'unsupported' || status.availability === 'insecure-context') {
    throw new Error(status.detail);
  }
  if (status.availability === 'server-disabled') throw new Error(status.detail);

  const granted = await Notification.requestPermission();
  if (granted !== 'granted') {
    throw new Error(
      granted === 'denied'
        ? 'Notifications were blocked. Re-allow them in your device settings for AgentDeck.'
        : 'Notification permission was dismissed.',
    );
  }

  const reg = await ensureRegistration();
  if (!reg) throw new Error('The notification service worker could not be registered.');

  const config = await serverConfig(true);
  if (!config.publicKey) throw new Error('The server has no push key configured.');

  const existing = await reg.pushManager.getSubscription();
  const subscription =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.publicKey),
    }));

  await postJson('/api/push/subscribe', subscription.toJSON());
  remember(true);
  cachedConfig = null;
  return pushStatus();
}

export async function disablePush(): Promise<PushStatus> {
  const subscription = await currentSubscription();
  if (subscription) {
    await postJson('/api/push/unsubscribe', { endpoint: subscription.endpoint }).catch(() => {});
    await subscription.unsubscribe().catch(() => {});
  }
  remember(false);
  cachedConfig = null;
  return pushStatus();
}

export async function sendTestPush(): Promise<{ sent: number; failed: number }> {
  return postJson<{ sent: number; failed: number }>('/api/push/test', {});
}

/**
 * Re-registers the worker on every launch and re-syncs the subscription the
 * server holds. A subscription can survive on the device while the server's
 * copy is gone — after clearing state, say — and the user would never know.
 */
export async function initPush(onNavigate: (url: string, requestId?: string) => void): Promise<void> {
  if (!pushApiSupported()) return;

  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; url?: string; requestId?: string } | null;
    if (data?.type === 'navigate' && typeof data.url === 'string') {
      onNavigate(data.url, typeof data.requestId === 'string' ? data.requestId : undefined);
    }
  });

  const reg = await ensureRegistration();
  if (!reg || permission() !== 'granted' || !remembered()) return;

  try {
    const config = await serverConfig(true);
    if (!config.enabled || !config.publicKey) return;
    const subscription =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.publicKey),
      }));
    await postJson('/api/push/subscribe', subscription.toJSON());
    cachedConfig = null;
  } catch {
    // Offline at launch is normal; the settings sheet can retry.
  }
}

/**
 * Clear a notification the user has already dealt with in the app, so an
 * answered approval does not sit on the lock screen.
 */
export async function dismissNotification(tag: string): Promise<void> {
  if (!pushApiSupported()) return;
  const reg = registration ?? (await ensureRegistration());
  if (!reg) return;
  const open = await reg.getNotifications({ tag }).catch(() => [] as Notification[]);
  for (const notification of open) notification.close();
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json().catch(() => ({}))) as T & { message?: string; error?: string };
  if (!response.ok) throw new Error(parsed.message || parsed.error || `Request failed (${response.status})`);
  return parsed;
}

/** VAPID keys travel as base64url; the Push API wants the raw key bytes. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = window.atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
