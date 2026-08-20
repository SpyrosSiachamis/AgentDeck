/**
 * Service worker for the installed PWA.
 *
 * Its only job is notifications. There is no offline cache: the app is useless
 * without its server anyway, and a stale cached bundle talking to a newer
 * protocol is a worse failure than "no connection".
 */

const NOTIFICATION_ICON = '/icons/icon-192.png';
const BADGE_ICON = '/icons/icon-192.png';

self.addEventListener('install', () => {
  // Take over straight away; there is no cache to migrate.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Present only so browsers treat the app as installable. Intentionally does not
// call respondWith, which leaves every request on the default network path.
self.addEventListener('fetch', () => {});

self.addEventListener('push', (event) => {
  event.waitUntil(showPush(event));
});

/**
 * Safari revokes push permission from a PWA that receives a push without
 * showing a notification, so every branch here ends in showNotification —
 * including the one where the payload is unreadable.
 */
async function showPush(event) {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }

  const title = (payload && payload.title) || 'DevTunnel';
  const body = (payload && payload.body) || 'Your coding agent needs you.';
  const tag = (payload && payload.tag) || 'devtunnel';
  const url = (payload && payload.url) || '/';
  const kind = payload && payload.kind;

  await self.registration.showNotification(title, {
    body,
    tag,
    // Approvals block the CLI, so a newer one must not silently replace an older.
    renotify: true,
    icon: NOTIFICATION_ICON,
    badge: BADGE_ICON,
    timestamp: (payload && payload.ts) || Date.now(),
    requireInteraction: Boolean(payload && payload.requireInteraction),
    // A tap on an approval should land on the session, not the session list.
    data: { url, kind, sessionId: payload && payload.sessionId, requestId: payload && payload.requestId },
    actions:
      kind === 'permission_request'
        ? [{ action: 'open', title: 'Review' }]
        : [],
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(openApp(url));
});

/**
 * Reuse the running app when there is one — on a phone, opening a second window
 * would drop the user into a fresh WebSocket and an empty transcript.
 */
async function openApp(url) {
  const target = new URL(url, self.location.origin);
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

  for (const client of windows) {
    if (new URL(client.url).origin !== target.origin) continue;
    // The hash route cannot be changed from here, so ask the page to navigate.
    client.postMessage({ type: 'navigate', url: target.href });
    if ('focus' in client) return client.focus();
  }
  if (self.clients.openWindow) return self.clients.openWindow(target.href);
  return undefined;
}

/**
 * Push services rotate subscriptions on their own schedule. Without this the
 * phone goes quiet and nothing tells the user why.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(resubscribe(event));
});

async function resubscribe(event) {
  try {
    const response = await fetch('/api/push/config', { credentials: 'same-origin' });
    if (!response.ok) return;
    const { push } = await response.json();
    if (!push || !push.publicKey) return;

    const subscription = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(push.publicKey),
    });

    const previous = event.oldSubscription;
    if (previous && previous.endpoint !== subscription.endpoint) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: previous.endpoint }),
      }).catch(() => {});
    }

    await fetch('/api/push/subscribe', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    });
  } catch {
    // Nothing useful to do from here; the page re-syncs on next launch.
  }
}

/** VAPID keys travel as base64url; the Push API wants raw bytes. */
function urlBase64ToUint8Array(base64) {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = self.atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
