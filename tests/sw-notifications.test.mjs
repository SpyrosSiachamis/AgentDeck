import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

/**
 * The service worker answers approvals straight from the notification shade, so
 * a mistake here either blocks the agent silently or approves something the
 * user did not. It is plain JS with no imports, so it can be run in a sandbox
 * with a fake ServiceWorkerGlobalScope.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'dist/web/sw.js'), 'utf8');

/**
 * Objects built inside the sandbox carry that realm's prototypes, which
 * deepStrictEqual refuses to match. Re-create them in this realm first.
 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadWorker({ fetchImpl, clients = [] } = {}) {
  const listeners = new Map();
  const shown = [];
  const fetches = [];
  const posted = [];
  const opened = [];

  const self = {
    location: { origin: 'https://host.ts.net' },
    addEventListener: (type, fn) => listeners.set(type, fn),
    skipWaiting: () => {},
    registration: {
      showNotification: async (title, options) => {
        shown.push({ title, options });
      },
    },
    clients: {
      claim: async () => {},
      matchAll: async () => clients,
      openWindow: async (url) => {
        opened.push(url);
      },
    },
    atob: (b) => Buffer.from(b, 'base64').toString('binary'),
  };

  const context = vm.createContext({
    self,
    URL,
    URLSearchParams,
    Buffer,
    console,
    setTimeout,
    encodeURIComponent,
    JSON,
    Date,
    Uint8Array,
    require: () => {
      throw new Error('the worker must not require anything');
    },
    fetch: async (url, init) => {
      fetches.push({ url, init });
      return fetchImpl ? fetchImpl(url, init) : { ok: true, json: async () => ({}) };
    },
  });
  vm.runInContext(source, context);

  return {
    shown,
    fetches,
    posted,
    opened,
    push: (payload) =>
      listeners.get('push')({
        data: { json: () => payload },
        waitUntil: (p) => p,
      }),
    /** `shown` records what showNotification received; rebuild the Notification. */
    click: (shownRecord, action) => {
      const promises = [];
      listeners.get('notificationclick')({
        notification: {
          title: shownRecord.title,
          data: shownRecord.options.data,
          close: () => {},
        },
        action,
        waitUntil: (p) => promises.push(p),
      });
      return Promise.all(promises);
    },
  };
}

const approvalPayload = {
  kind: 'permission_request',
  title: 'Approval needed · Fix the parser',
  body: 'Bash: rm -rf build',
  tag: 'perm-req7',
  url: '/#/s/sess1',
  sessionId: 'sess1',
  requestId: 'req7',
  requireInteraction: true,
};

test('an approval notification offers Approve and Deny', async () => {
  const w = loadWorker();
  await w.push(approvalPayload);

  assert.equal(w.shown.length, 1);
  const actions = plain(w.shown[0].options.actions).map((a) => a.action);
  assert.deepEqual(actions, ['allow', 'deny']);
  assert.equal(w.shown[0].options.requireInteraction, true);
  assert.equal(w.shown[0].options.data.requestId, 'req7');
});

test('a finished-turn notification offers no buttons to press', async () => {
  const w = loadWorker();
  await w.push({ kind: 'turn_finished', title: 'Done', body: 'ok', tag: 't', url: '/#/s/s1', sessionId: 's1' });
  assert.deepEqual(plain(w.shown[0].options.actions), []);
});

test('pressing Approve answers the real endpoint without opening the app', async () => {
  const w = loadWorker();
  await w.push(approvalPayload);
  await w.click(w.shown[0], 'allow');

  assert.equal(w.fetches.length, 1);
  const call = w.fetches[0];
  assert.equal(call.url, '/api/sessions/sess1/permissions/req7');
  assert.equal(call.init.method, 'POST');
  assert.equal(JSON.parse(call.init.body).decision, 'allow');
  assert.equal(w.opened.length, 0, 'answering does not launch the app');

  // The user gets told what happened.
  assert.match(w.shown.at(-1).title, /Approved/);
});

test('pressing Deny sends a denial, with a reason for the agent', async () => {
  const w = loadWorker();
  await w.push(approvalPayload);
  await w.click(w.shown[0], 'deny');

  const body = JSON.parse(w.fetches[0].init.body);
  assert.equal(body.decision, 'deny');
  assert.match(body.reason, /notification/i);
  assert.match(w.shown.at(-1).title, /Denied/);
});

test('an approval that is no longer waiting says so instead of failing silently', async () => {
  const w = loadWorker({
    fetchImpl: async () => ({ ok: false, json: async () => ({ message: 'no pending approval with that id' }) }),
  });
  await w.push(approvalPayload);
  await w.click(w.shown[0], 'allow');

  assert.match(w.shown.at(-1).title, /Could not answer/);
  assert.match(w.shown.at(-1).options.body, /no pending approval/);
});

test('an unreachable server is reported, not swallowed', async () => {
  const w = loadWorker({
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  await w.push(approvalPayload);
  await w.click(w.shown[0], 'allow');

  assert.match(w.shown.at(-1).title, /Could not answer/);
  assert.match(w.shown.at(-1).options.body, /unreachable/i);
});

test('tapping the body opens the app at that approval', async () => {
  const w = loadWorker();
  await w.push(approvalPayload);
  await w.click(w.shown[0], undefined);

  assert.equal(w.fetches.length, 0, 'a plain tap decides nothing');
  assert.equal(w.opened.length, 1);
  // The id rides ahead of the hash so the hash router still sees its own route.
  assert.match(w.opened[0], /\?perm=req7#\/s\/sess1$/);
});

test('an already-open window is reused rather than a second one launched', async () => {
  const posted = [];
  let focused = false;
  const w = loadWorker({
    clients: [
      {
        url: 'https://host.ts.net/#/s/other',
        postMessage: (m) => posted.push(m),
        focus: async () => {
          focused = true;
        },
      },
    ],
  });
  await w.push(approvalPayload);
  await w.click(w.shown[0], undefined);

  assert.equal(w.opened.length, 0, 'no second window');
  assert.equal(focused, true);
  assert.deepEqual(plain(posted), [{ type: 'navigate', url: 'https://host.ts.net/#/s/sess1', requestId: 'req7' }]);
});

test('an unreadable payload still shows something, as Safari requires', async () => {
  const w = loadWorker();
  const listenersPush = w.push;
  // event.data.json() throwing must not skip showNotification: a push with no
  // notification costs the PWA its permission on iOS.
  await listenersPush(undefined);
  assert.equal(w.shown.length, 1);
  assert.ok(w.shown[0].title.length > 0);
});
