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

  const title = (payload && payload.title) || 'AgentDeck';
  const body = (payload && payload.body) || 'Your coding agent needs you.';
  const tag = (payload && payload.tag) || 'agentdeck';
  const url = (payload && payload.url) || '/';
  const kind = payload && payload.kind;
  const sessionId = payload && payload.sessionId;
  const requestId = payload && payload.requestId;

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
    data: { url, kind, sessionId, requestId },
    // Answer without opening the app, where the platform supports it. Safari
    // ignores this array, so the tap-through path below has to work regardless.
    actions:
      kind === 'permission_request' && sessionId && requestId
        ? [
            { action: 'allow', title: 'Approve' },
            { action: 'deny', title: 'Deny' },
          ]
        : [],
  });
}

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {};
  event.notification.close();

  if (event.action === 'allow' || event.action === 'deny') {
    event.waitUntil(decide(data, event.action));
    return;
  }

  // A plain tap opens the app. Carrying the request id lets the page scroll to
  // the card and highlight it, which is the whole answer on platforms that do
  // not render action buttons.
  event.waitUntil(openApp(data.url || '/', data.requestId));
});

/**
 * Answer an approval straight from the notification shade.
 *
 * The REST route is the same one the in-app buttons use, so the decision is
 * validated, recorded and attributed identically. Anything other than success
 * is reported back as a notification: silently swallowing a failed approval
 * would leave the agent blocked with no sign of why.
 */
async function decide(data, action) {
  if (!data.sessionId || !data.requestId) return;

  try {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(data.sessionId)}/permissions/${encodeURIComponent(data.requestId)}`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decision: action === 'allow' ? 'allow' : 'deny',
          reason: action === 'deny' ? 'Denied from the notification.' : undefined,
        }),
      },
    );

    if (response.ok) {
      await flashResult(
        action === 'allow' ? 'Approved' : 'Denied',
        action === 'allow' ? 'The command is running.' : 'The agent was told no.',
        data,
      );
      return;
    }

    // 404/409 mean it was already answered, timed out, or the session ended.
    const detail = await response.json().catch(() => ({}));
    await flashResult('Could not answer', detail.message || 'That approval is no longer waiting.', data);
  } catch {
    await flashResult('Could not answer', 'The server was unreachable. Open the app to retry.', data);
  }
}

/** A short, non-sticky follow-up so an action never fails silently. */
async function flashResult(title, body, data) {
  await self.registration.showNotification(title, {
    body,
    tag: `result-${data.requestId}`,
    icon: NOTIFICATION_ICON,
    badge: BADGE_ICON,
    requireInteraction: false,
    data: { url: data.url || '/' },
  });
}

/**
 * Reuse the running app when there is one — on a phone, opening a second window
 * would drop the user into a fresh WebSocket and an empty transcript.
 */
async function openApp(url, requestId) {
  const target = new URL(url, self.location.origin);
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

  for (const client of windows) {
    if (new URL(client.url).origin !== target.origin) continue;
    // The hash route cannot be changed from here, so ask the page to navigate.
    client.postMessage({ type: 'navigate', url: target.href, requestId });
    if ('focus' in client) return client.focus();
  }

  if (self.clients.openWindow) {
    // A cold start has no page to message. The request id rides in the query
    // string, ahead of the hash, so the existing hash router is untouched.
    if (requestId) target.search = `?perm=${encodeURIComponent(requestId)}`;
    return self.clients.openWindow(target.href);
  }
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
