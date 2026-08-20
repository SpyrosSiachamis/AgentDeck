import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { buildHarness } from './helpers.mjs';
import { PushService } from '../dist/server/push.js';
import { payloadForEvent, SessionNotifier } from '../dist/server/notify.js';
import { createLogger } from '../dist/server/logger.js';

const silent = createLogger({ level: 'silent', pretty: false });

/** A subscription shaped exactly like one PushManager.subscribe() hands back. */
function fakeSubscription(suffix = 'abc123') {
  return {
    endpoint: `https://web.push.apple.com/${suffix}`,
    expirationTime: null,
    keys: {
      p256dh: 'BJ3xJb4YQ8lqQ0wQ3mQnZ2Yh9Xk8pB7cF1dK2sM4nT6uV8wA0bC2dE4fG6hI8jK0lM2nO4pQ6rS8tU0vW2xY4z',
      auth: 'k9Lm2Np4Qr6St8Uv0Wx2Yz',
    },
  };
}

test('the push config endpoint publishes a VAPID key and no endpoints', async (t) => {
  const harness = await buildHarness();
  t.after(() => harness.close());

  const response = await harness.app.inject({ method: 'GET', url: '/api/push/config' });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.push.enabled, true);
  assert.ok(body.push.publicKey.length > 20, 'a VAPID public key is generated on first run');
  assert.equal(body.push.devices, 0);
  // The private half must never be reachable from a browser.
  assert.equal(JSON.stringify(body).includes('privateKey'), false);
});

test('a device subscribes, is counted, and unsubscribes', async (t) => {
  const harness = await buildHarness();
  t.after(() => harness.close());

  const subscribe = await harness.app.inject({
    method: 'POST',
    url: '/api/push/subscribe',
    payload: fakeSubscription(),
  });
  assert.equal(subscribe.statusCode, 201);
  assert.equal(subscribe.json().push.devices, 1);

  // Re-subscribing the same endpoint must not create a second device.
  await harness.app.inject({ method: 'POST', url: '/api/push/subscribe', payload: fakeSubscription() });
  const config = await harness.app.inject({ method: 'GET', url: '/api/push/config' });
  assert.equal(config.json().push.devices, 1);

  const unsubscribe = await harness.app.inject({
    method: 'POST',
    url: '/api/push/unsubscribe',
    payload: { endpoint: fakeSubscription().endpoint },
  });
  assert.equal(unsubscribe.json().removed, true);
  assert.equal(unsubscribe.json().push.devices, 0);
});

test('malformed and non-https subscriptions are refused', async (t) => {
  const harness = await buildHarness();
  t.after(() => harness.close());

  const missingKeys = await harness.app.inject({
    method: 'POST',
    url: '/api/push/subscribe',
    payload: { endpoint: 'https://web.push.apple.com/x' },
  });
  assert.equal(missingKeys.statusCode, 400);

  const insecure = await harness.app.inject({
    method: 'POST',
    url: '/api/push/subscribe',
    payload: { ...fakeSubscription(), endpoint: 'http://evil.example/hook' },
  });
  assert.equal(insecure.statusCode, 400);
  assert.equal(insecure.json().error, 'invalid_subscription');

  const config = await harness.app.inject({ method: 'GET', url: '/api/push/config' });
  assert.equal(config.json().push.devices, 0);
});

test('subscriptions and the VAPID key survive a restart', async (t) => {
  const harness = await buildHarness();
  t.after(() => harness.close());

  await harness.app.inject({ method: 'POST', url: '/api/push/subscribe', payload: fakeSubscription('device-1') });
  const before = await harness.app.inject({ method: 'GET', url: '/api/push/config' });

  // A second service over the same state dir is what a server restart looks like.
  const reloaded = await PushService.create(harness.config, silent);
  assert.equal(reloaded.count, 1);
  assert.equal(reloaded.publicKey, before.json().push.publicKey);

  const stored = JSON.parse(
    await fsp.readFile(path.join(harness.config.stateDir, 'push', 'subscriptions.json'), 'utf8'),
  );
  assert.equal(stored.subscriptions.length, 1);
});

test('push can be turned off entirely', async (t) => {
  const harness = await buildHarness({ PUSH_ENABLED: 'false' });
  t.after(() => harness.close());

  const config = await harness.app.inject({ method: 'GET', url: '/api/push/config' });
  assert.equal(config.json().push.enabled, false);
  assert.equal(config.json().push.publicKey, null);

  const subscribe = await harness.app.inject({
    method: 'POST',
    url: '/api/push/subscribe',
    payload: fakeSubscription(),
  });
  assert.equal(subscribe.statusCode, 409);
  assert.equal(subscribe.json().error, 'push_disabled');

  const health = await harness.app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(health.json().push.enabled, false);
});

test('the service worker, manifest and icons are served, and the CSP allows them', async (t) => {
  const harness = await buildHarness();
  t.after(() => harness.close());

  const sw = await harness.app.inject({ method: 'GET', url: '/sw.js' });
  assert.equal(sw.statusCode, 200);
  assert.match(sw.body, /addEventListener\('push'/);

  const manifest = await harness.app.inject({ method: 'GET', url: '/manifest.webmanifest' });
  assert.equal(manifest.statusCode, 200);
  assert.equal(JSON.parse(manifest.body).display, 'standalone');

  const icon = await harness.app.inject({ method: 'GET', url: '/icons/apple-touch-icon.png' });
  assert.equal(icon.statusCode, 200);

  // Without worker-src the browser refuses to register the worker at all.
  const csp = sw.headers['content-security-policy'];
  assert.match(csp, /worker-src 'self'/);
  assert.match(csp, /manifest-src 'self'/);
});

// ------------------------------------------------------------ notification policy

test('only approvals, finished turns and fatal errors become notifications', () => {
  const options = { title: 'Fix the parser', sessionId: 'sess1', notifyTurnFinished: true };
  const base = { seq: 1, ts: 1000, sessionId: 'sess1' };

  const approval = payloadForEvent(
    {
      ...base,
      type: 'permission_request',
      requestId: 'req-7',
      toolName: 'Bash',
      displayName: 'Bash',
      summary: 'run tests',
      command: 'npm test',
    },
    options,
  );
  assert.equal(approval.kind, 'permission_request');
  assert.equal(approval.tag, 'perm-req-7');
  assert.equal(approval.url, '/#/s/sess1');
  assert.equal(approval.requireInteraction, true);
  assert.match(approval.body, /npm test/);

  const done = payloadForEvent({ ...base, type: 'turn_finished', isError: false, result: 'All  green\n' }, options);
  assert.equal(done.kind, 'turn_finished');
  assert.equal(done.tag, 'turn-sess1');
  // Whitespace is flattened: a lock screen shows one line.
  assert.equal(done.body, 'All green');

  const failed = payloadForEvent({ ...base, type: 'turn_finished', isError: true }, options);
  assert.match(failed.title, /^Turn failed/);

  const fatal = payloadForEvent({ ...base, type: 'error', message: 'CLI died', fatal: true }, options);
  assert.equal(fatal.kind, 'session_failed');

  // Noise that must never reach a lock screen.
  assert.equal(payloadForEvent({ ...base, type: 'error', message: 'retrying', fatal: false }, options), null);
  assert.equal(payloadForEvent({ ...base, type: 'message_delta', blockId: 'b1', text: 'hi' }, options), null);
  assert.equal(payloadForEvent({ ...base, type: 'tool_use', toolUseId: 't1', name: 'Read', summary: 'x' }, options), null);
  assert.equal(
    payloadForEvent({ ...base, type: 'turn_finished', isError: false }, { ...options, notifyTurnFinished: false }),
    null,
  );
});

/** Captures what would have been delivered, without touching the network. */
function recordingPush() {
  const sent = [];
  return {
    sent,
    enabled: true,
    async send(payload) {
      sent.push(payload);
      return { sent: 1, failed: 0, pruned: 0 };
    },
  };
}

test('a session on screen suppresses the "done" push but never an approval', async (t) => {
  const harness = await buildHarness();
  t.after(() => harness.close());

  const push = recordingPush();
  const notifier = new SessionNotifier(harness.config, silent, push);
  notifier.attach(harness.sessions);
  notifier.setVisibilityProbe(() => true);
  t.after(() => notifier.detach());

  const session = await harness.sessions.create({ workspaceId: 'repo', createdBy: 'tester' });
  await session.instruct('please ask for approval', 'tester');

  await new Promise((resolve) => setTimeout(resolve, 400));
  const kinds = push.sent.map((p) => p.kind);
  assert.equal(kinds.includes('turn_finished'), false, 'a visible session does not buzz on completion');
});

test('a backgrounded session pushes on approval and on completion', async (t) => {
  const harness = await buildHarness();
  t.after(() => harness.close());

  const push = recordingPush();
  const notifier = new SessionNotifier(harness.config, silent, push);
  notifier.attach(harness.sessions);
  notifier.setVisibilityProbe(() => false);
  t.after(() => notifier.detach());

  const session = await harness.sessions.create({ workspaceId: 'repo', createdBy: 'tester' });
  await session.instruct('do something', 'tester');

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(push.sent.some((p) => p.kind === 'turn_finished'), 'a finished turn reaches the phone');
  for (const payload of push.sent) {
    assert.equal(payload.url.startsWith('/#/s/'), true, 'every notification deep-links to its session');
  }
});
