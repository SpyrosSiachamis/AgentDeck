import { renderMarkdownInto } from './markdown.js';
import { currentTheme, initTheme, setTheme, type Theme } from './theme.js';
import {
  disablePush,
  dismissNotification,
  enablePush,
  initPush,
  isStandalone,
  pushStatus,
  sendTestPush,
  type PushStatus,
} from './push.js';

type WorkspaceView = { id: string; name: string; enabled: boolean; isGitRepo: boolean };


type AgentView = {
  id: string;
  displayName: string;
  command: string;
  model: string | null;
  available: boolean;
  persistentProcess: boolean;
  supportsPermissionPrompts: boolean;
  /** Whether this agent can be asked for a list of models to pick from. */
  listsModels?: boolean;
  note: string;
};

type PendingPermission = {
  requestId: string;
  toolName: string;
  summary: string;
  command?: string;
  requestedAt: number;
};

type SessionSummary = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  adapterId: string;
  adapterName: string;
  title: string;
  state: 'starting' | 'idle' | 'busy' | 'cancelling' | 'exited' | 'crashed' | 'orphaned';
  model: string | null;
  createdAt: number;
  updatedAt: number;
  lastSeq: number;
  live: boolean;
  resumable: boolean;
  pendingInstructions: number;
  pendingPermissions: PendingPermission[];
  supportsPermissionPrompts: boolean;
  exit?: { code: number | null; signal: string | null; reason: string } | null;
};

type SessionEvent = { seq: number; ts: number; sessionId: string; type: string } & Record<string, unknown>;

type ServerMessage =
  | { t: 'welcome'; identity: { login: string | null; displayName: string | null; viaTailscale: boolean }; workspaces: WorkspaceView[]; agents: AgentView[]; defaultAgent: string; sessions: SessionSummary[]; limits: { maxConcurrentSessions: number; maxInstructionChars: number }; settings?: AppSettings }
  | { t: 'pong' }
  | { t: 'settings'; settings: AppSettings }
  | { t: 'events'; sessionId: string; events: SessionEvent[] }
  | { t: 'session'; session: SessionSummary }
  | { t: 'sessions'; sessions: SessionSummary[] }
  | { t: 'subscribed'; sessionId: string; lastSeq: number; gapSkipped: number }
  | { t: 'ack'; clientMsgId?: string; sessionId: string; instructionId: string }
  | { t: 'error'; code: string; message: string; sessionId?: string; clientMsgId?: string };

type ConnState = 'connecting' | 'online' | 'offline';

const state = {
  conn: 'connecting' as ConnState,
  identity: null as { login: string | null; displayName: string | null; viaTailscale: boolean } | null,
  workspaces: [] as WorkspaceView[],
  agents: [] as AgentView[],
  defaultAgent: '',
  sessions: new Map<string, SessionSummary>(),
  /** Highest event sequence rendered per session, for gap-free reconnect. */
  lastSeq: new Map<string, number>(),
  route: { name: 'home' as 'home' | 'session' | 'settings', sessionId: '' },
  tab: 'chat' as 'chat' | 'git',
  /** Server-side preferences, mirrored from the welcome frame. */
  settings: { models: {}, notifications: {} } as AppSettings,
};

type AppSettings = {
  models: Record<string, string>;
  notifications: { turnFinished?: boolean };
};

const app = document.getElementById('app') as HTMLElement;

// ---------------------------------------------------------------- utilities

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

function relativeTime(ts: number): string {
  const delta = Math.max(0, Date.now() - ts);
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  document.querySelector('.toast')?.remove();
  const node = el('div', { class: `toast ${kind}` }, message);
  document.body.append(node);
  setTimeout(() => node.remove(), 4200);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // Only declare a JSON body when there actually is one.
  const headers = init?.body ? { 'content-type': 'application/json', ...(init.headers ?? {}) } : (init?.headers ?? {});
  const response = await fetch(path, { ...init, headers });
  const body = (await response.json().catch(() => ({}))) as T & { message?: string; error?: string };
  if (!response.ok) throw new Error(body.message || body.error || `Request failed (${response.status})`);
  return body;
}

// ------------------------------------------------------------ websocket link

let socket: WebSocket | null = null;
let reconnectDelay = 500;
let reconnectTimer: number | undefined;

function connect(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  setConn('connecting');

  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  const ws = new WebSocket(url);
  socket = ws;

  ws.onmessage = (event) => {
    let message: ServerMessage;
    try {
      message = JSON.parse(event.data as string) as ServerMessage;
    } catch {
      return;
    }
    handleMessage(message);
  };

  ws.onopen = () => {
    reconnectDelay = 500;
    setConn('online');
    // Re-attach to whatever the user was watching, continuing from the last
    // event we rendered so nothing is missed or duplicated.
    if (state.route.name === 'session') subscribe(state.route.sessionId);
    // The new socket knows nothing about presence; re-declare it.
    presenceSessionId = null;
    reportPresence();
  };

  ws.onclose = () => {
    socket = null;
    setConn('offline');
    // The server drops this connection's presence when it closes.
    presenceSessionId = null;
    scheduleReconnect();
  };

  ws.onerror = () => ws.close();
}

function scheduleReconnect(): void {
  window.clearTimeout(reconnectTimer);
  reconnectTimer = window.setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 1.8, 15_000);
    connect();
  }, reconnectDelay);
}

function send(message: Record<string, unknown>): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    toast('Not connected — reconnecting…', 'error');
    connect();
    return false;
  }
  socket.send(JSON.stringify(message));
  return true;
}

function subscribe(sessionId: string): void {
  send({ t: 'subscribe', sessionId, sinceSeq: state.lastSeq.get(sessionId) ?? 0 });
}

/** Subscribe without complaining when the socket is not up yet; onopen retries. */
function subscribeQuiet(sessionId: string): void {
  if (socket?.readyState === WebSocket.OPEN) subscribe(sessionId);
}

/**
 * Rebuild the transcript from the server.
 *
 * `state.lastSeq` is what stops replayed events from being drawn twice, but it
 * outlives the DOM: leaving a session and coming back, or a re-render when the
 * session ends, produces an empty stream that the server then has nothing new
 * to fill. So whenever a fresh stream is mounted, the history is re-read from
 * scratch rather than resumed. Reading over HTTP rather than the socket reaches
 * further back than the socket's replay window and works while it is down.
 */
async function loadTranscript(sessionId: string): Promise<void> {
  const stream = streamEl;
  if (!stream) return;

  blockNodes.clear();
  streamingText.clear();
  state.lastSeq.set(sessionId, 0);

  try {
    const history = await api<{ events: SessionEvent[]; skipped: number }>(
      `/api/sessions/${sessionId}/events?since=0&limit=2000`,
    );
    // A slow fetch can land after the user has navigated on; do not paint over
    // whatever they are looking at now.
    if (state.route.name !== 'session' || state.route.sessionId !== sessionId || streamEl !== stream) return;

    stream.replaceChildren();
    if (history.skipped > 0) {
      appendNotice(`${history.skipped} older events are no longer kept.`);
    }
    for (const event of history.events) renderEvent(event);
    scrollToBottom(true);
    if (highlightRequestId) focusPermissionCard(highlightRequestId);
  } catch {
    // Offline, or the session is gone. The socket replay is the fallback.
    state.lastSeq.set(sessionId, 0);
  }

  subscribeQuiet(sessionId);
}

function setConn(next: ConnState): void {
  state.conn = next;
  const pill = document.querySelector('.conn');
  if (pill) {
    pill.setAttribute('data-state', next);
    const label = pill.querySelector('.conn-label');
    if (label) label.textContent = connLabel();
  }
}

function connLabel(): string {
  if (state.conn === 'online') {
    return state.identity?.login ?? (state.identity?.viaTailscale ? 'tailnet' : 'local');
  }
  return state.conn === 'connecting' ? 'connecting' : 'offline';
}

function handleMessage(message: ServerMessage): void {
  switch (message.t) {
    case 'welcome':
      state.identity = message.identity;
      state.workspaces = message.workspaces;
      state.agents = message.agents ?? [];
      state.defaultAgent = message.defaultAgent ?? '';
      if (message.settings) state.settings = message.settings;
      state.sessions = new Map(message.sessions.map((s) => [s.id, s]));
      setConn('online');
      render();
      if (state.route.name === 'session') void loadTranscript(state.route.sessionId);
      return;

    case 'sessions':
      state.sessions = new Map(message.sessions.map((s) => [s.id, s]));
      if (state.route.name === 'home') render();
      return;

    case 'session':
      state.sessions.set(message.session.id, message.session);
      if (state.route.name === 'home') render();
      else if (message.session.id === state.route.sessionId) updateSessionChrome();
      return;

    case 'subscribed':
      if (message.gapSkipped > 0) {
        appendNotice(`${message.gapSkipped} older events were trimmed from the log.`);
      }
      return;

    case 'events':
      if (message.sessionId !== state.route.sessionId) {
        const highest = message.events.at(-1)?.seq;
        if (highest) state.lastSeq.set(message.sessionId, highest);
        return;
      }
      for (const event of message.events) renderEvent(event);
      return;

    case 'settings':
      // Another device changed a shared preference.
      state.settings = message.settings;
      if (state.route.name === 'settings') render();
      return;

    case 'ack':
      return;

    case 'error':
      toast(message.message, 'error');
      return;
  }
}

// -------------------------------------------------------------------- routing

function parseRoute(): void {
  const hash = location.hash.replace(/^#/, '');
  const match = /^\/s\/([A-Za-z0-9_-]+)$/.exec(hash);
  if (match?.[1]) state.route = { name: 'session', sessionId: match[1] };
  else if (hash === '/settings') state.route = { name: 'settings', sessionId: '' };
  else state.route = { name: 'home', sessionId: '' };
}

function navigate(hash: string): void {
  location.hash = hash;
}

window.addEventListener('hashchange', () => {
  parseRoute();
  state.tab = 'chat';
  render();
  if (state.route.name === 'session') void loadTranscript(state.route.sessionId);
  reportPresence();
});

// --------------------------------------------------------------------- views

function render(): void {
  const view =
    state.route.name === 'home' ? homeView() : state.route.name === 'settings' ? settingsView() : sessionView();
  app.replaceChildren(view);
}

function topbar(title: string, subtitle?: string, opts: { back?: boolean; actions?: HTMLElement[] } = {}): HTMLElement {
  const heading = el('h1', {}, title);
  if (subtitle) heading.append(el('span', { class: 'subtitle' }, subtitle));

  const bar = el('header', { class: 'topbar' });
  if (opts.back) {
    const back = el('button', { class: 'icon-btn', 'aria-label': 'Back' }, '‹');
    back.style.fontSize = '26px';
    back.onclick = () => navigate('/');
    bar.append(back);
  }
  bar.append(heading);
  for (const action of opts.actions ?? []) bar.append(action);

  const pill = el(
    'div',
    { class: 'conn', 'data-state': state.conn },
    el('span', { class: 'dot' }),
    el('span', { class: 'conn-label' }, connLabel()),
  );
  bar.append(pill);
  return bar;
}

function homeView(): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const gear = el(
    'button',
    { class: 'icon-btn', id: 'settings-btn', 'aria-label': 'Settings', title: 'Settings' },
    '\u2699\uFE0F',
  );
  gear.onclick = () => navigate('/settings');
  fragment.append(
    topbar('AgentDeck', state.identity?.viaTailscale ? 'via Tailscale' : 'local access', { actions: [gear] }),
  );

  const scroll = el('div', { class: 'scroll' });
  const sessions = [...state.sessions.values()];
  const active = sessions.filter((s) => s.live);
  const past = sessions.filter((s) => !s.live);

  scroll.append(el('div', { class: 'section-title' }, 'Workspaces'));
  if (state.workspaces.length === 0) {
    scroll.append(el('div', { class: 'empty' }, 'No workspaces registered. Add one to workspaces.json and restart.'));
  }
  for (const workspace of state.workspaces) {
    const card = el('button', { class: `card ${workspace.enabled ? '' : 'disabled'}` });
    const row = el('div', { class: 'card-row' }, el('span', { class: 'card-title' }, workspace.name));
    if (!workspace.enabled) row.append(el('span', { class: 'badge' }, 'disabled'));
    else row.append(el('span', { class: 'badge' }, 'start →'));
    card.append(row);
    card.append(
      el(
        'div',
        { class: 'card-meta' },
        el('span', {}, workspace.isGitRepo ? 'git repository' : 'plain directory'),
      ),
    );
    if (workspace.enabled) card.onclick = () => chooseAgent(workspace);
    scroll.append(card);
  }

  scroll.append(el('div', { class: 'section-title' }, `Active sessions (${active.length})`));
  if (active.length === 0) scroll.append(el('div', { class: 'empty' }, 'Nothing running right now.'));
  for (const session of active) scroll.append(sessionCard(session));

  if (past.length > 0) {
    const header = el('div', { class: 'section-header' });
    header.append(el('span', { class: 'section-title' }, `History (${past.length})`));
    const clearBtn = el('button', { class: 'section-action', 'aria-label': 'Clear all history' }, 'Clear all');
    clearBtn.onclick = () => void clearAllHistory();
    header.append(clearBtn);
    scroll.append(header);
    for (const session of past) scroll.append(sessionCard(session));
  }

  fragment.append(scroll);
  return fragment;
}

function sessionCard(session: SessionSummary): HTMLElement {
  const card = el('div', { class: 'card', role: 'button', tabindex: '0' });
  const row = el(
    'div',
    { class: 'card-row' },
    el('span', { class: 'card-title' }, session.title),
    ...(session.pendingPermissions?.length
      ? [el('span', { class: 'badge needs-approval' }, 'approval needed')]
      : []),
    el('span', { class: 'badge', 'data-state': session.state }, session.state),
  );

  if (!session.live) {
    const delBtn = el(
      'button',
      { class: 'card-delete-btn', 'aria-label': 'Delete conversation', title: 'Delete conversation' },
      '🗑',
    );
    delBtn.onclick = (event) => {
      event.stopPropagation();
      void deleteSession(session.id);
    };
    row.append(delBtn);
  }

  card.append(row);
  card.append(
    el(
      'div',
      { class: 'card-meta' },
      el('span', {}, session.workspaceName),
      el('span', {}, session.adapterName ?? ''),
      el('span', {}, relativeTime(session.updatedAt)),
    ),
  );
  card.onclick = (event) => {
    if ((event.target as HTMLElement).closest('.card-delete-btn')) return;
    navigate(`/s/${session.id}`);
  };
  card.onkeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      if ((event.target as HTMLElement).closest('.card-delete-btn')) return;
      event.preventDefault();
      navigate(`/s/${session.id}`);
    }
  };
  return card;
}

/** Ask which agent should run the session, unless there is only one to pick. */
function chooseAgent(workspace: WorkspaceView): void {
  const usable = state.agents.filter((a) => a.available);
  if (usable.length === 0) {
    toast('No coding agent is installed on the server.', 'error');
    return;
  }
  if (usable.length === 1) {
    void startSession(workspace, usable[0]!.id);
    return;
  }

  const sheet = el('div', { class: 'sheet' });
  const panel = el('div', { class: 'sheet-panel' });
  panel.append(el('div', { class: 'sheet-title' }, `Start in ${workspace.name}`));

  for (const agent of state.agents) {
    const option = el('button', { class: `card ${agent.available ? '' : 'disabled'}` });
    const row = el('div', { class: 'card-row' }, el('span', { class: 'card-title' }, agent.displayName));
    if (!agent.available) row.append(el('span', { class: 'badge' }, 'not installed'));
    else if (agent.id === state.defaultAgent) row.append(el('span', { class: 'badge' }, 'default'));
    option.append(row);
    option.append(
      el(
        'div',
        { class: 'card-meta' },
        el('span', {}, agent.available ? agent.note : `"${agent.command}" was not found on PATH`),
      ),
    );
    if (agent.available) {
      option.onclick = () => {
        sheet.remove();
        void startSession(workspace, agent.id);
      };
    }
    panel.append(option);
  }

  const cancel = el('button', { class: 'btn' }, 'Cancel');
  cancel.onclick = () => sheet.remove();
  panel.append(cancel);

  sheet.append(panel);
  sheet.onclick = (event) => {
    if (event.target === sheet) sheet.remove();
  };
  document.body.append(sheet);
}

async function startSession(workspace: WorkspaceView, adapterId: string): Promise<void> {
  try {
    const result = await api<{ session: SessionSummary }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: workspace.id, adapterId }),
    });
    state.sessions.set(result.session.id, result.session);
    state.lastSeq.set(result.session.id, 0);
    navigate(`/s/${result.session.id}`);
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

// ------------------------------------------------------------ settings page

function settingsView(): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(topbar('Settings', undefined, { back: true }));

  const scroll = el('div', { class: 'scroll' });

  scroll.append(el('div', { class: 'section-title' }, 'Appearance'));
  scroll.append(themeCard());

  scroll.append(el('div', { class: 'section-title' }, 'Notifications'));
  const notifications = el('div', { class: 'settings-card', id: 'notifications-card' });
  notifications.append(el('div', { class: 'status-line' }, 'Checking…'));
  scroll.append(notifications);
  // The element is passed in rather than looked up: this fragment is not in the
  // document yet, so getElementById would find nothing and leave it "Checking…".
  void refreshNotificationCard(notifications);

  scroll.append(el('div', { class: 'section-title' }, 'Default models'));
  scroll.append(modelsCard());

  fragment.append(scroll);
  return fragment;
}

function themeCard(): HTMLElement {
  const card = el('div', { class: 'settings-card' });
  const group = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Theme' });

  const options: { value: Theme; label: string }[] = [
    { value: 'auto', label: 'Device' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];

  const buttons = options.map(({ value, label }) => {
    const button = el(
      'button',
      { type: 'button', 'aria-pressed': String(currentTheme() === value), 'data-theme-choice': value },
      label,
    );
    button.onclick = () => {
      setTheme(value);
      for (const other of buttons) {
        other.setAttribute('aria-pressed', String(other.getAttribute('data-theme-choice') === value));
      }
    };
    return button;
  });
  for (const button of buttons) group.append(button);

  card.append(group);
  card.append(
    el(
      'div',
      { class: 'settings-hint' },
      'Device follows your phone\u2019s light or dark setting. This choice is stored on this device only.',
    ),
  );
  return card;
}

/**
 * Model defaults are a server-side preference: they decide what a new session
 * launches with. A workspace that pins its own model still wins.
 */
function modelsCard(): HTMLElement {
  const card = el('div', { class: 'settings-card' });
  if (state.agents.length === 0) {
    card.append(el('div', { class: 'settings-hint' }, 'No agents are configured.'));
    return card;
  }

  for (const agent of state.agents) {
    const field = el('div', { class: 'model-field' });
    const inputId = `model-${agent.id}`;
    field.append(el('label', { for: inputId }, agent.displayName));

    const row = el('div', { class: 'model-input-row' });
    const input = el('input', {
      id: inputId,
      type: 'text',
      autocapitalize: 'off',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: agent.model || 'the agent\u2019s own default',
      value: state.settings.models[agent.id] ?? '',
    }) as HTMLInputElement;
    row.append(input);

    const save = el('button', { class: 'btn primary' }, 'Save');
    save.onclick = () => void saveModel(agent.id, input.value, field);
    row.append(save);
    field.append(row);

    if (agent.listsModels) {
      const browse = el('button', { class: 'btn' }, 'Browse models');
      browse.onclick = () => void browseModels(agent, input, browse);
      field.append(el('div', { class: 'btn-row' }, browse));
    }

    field.append(
      el(
        'div',
        { class: 'settings-hint' },
        state.settings.models[agent.id]
          ? `Leave empty to fall back to ${agent.model || 'the agent\u2019s own default'}.`
          : `Currently using ${agent.model || 'the agent\u2019s own default'}.`,
      ),
    );
    card.append(field);
  }
  return card;
}

async function saveModel(agentId: string, value: string, field: HTMLElement): Promise<void> {
  try {
    const result = await api<{ settings: AppSettings }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ models: { [agentId]: value.trim() } }),
    });
    state.settings = result.settings;
    const note = el('div', { class: 'settings-saved' }, value.trim() ? 'Saved' : 'Cleared \u2014 using the default');
    field.append(note);
    setTimeout(() => note.remove(), 2500);
    // Existing sessions keep the model they started with.
    toast('Applies to new sessions');
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

async function browseModels(agent: AgentView, input: HTMLInputElement, button: HTMLElement): Promise<void> {
  button.setAttribute('disabled', 'true');
  button.textContent = 'Loading\u2026';
  try {
    const result = await api<{ models: { id: string; label: string }[] }>(`/api/agents/${agent.id}/models`);
    pickFromSheet(agent.displayName, result.models, (id) => {
      input.value = id;
    });
  } catch (err) {
    toast((err as Error).message, 'error');
  }
  button.removeAttribute('disabled');
  button.textContent = 'Browse models';
}

function pickFromSheet(
  title: string,
  models: { id: string; label: string }[],
  onPick: (id: string) => void,
): void {
  const sheet = el('div', { class: 'sheet' });
  const panel = el('div', { class: 'sheet-panel' });
  panel.append(el('div', { class: 'sheet-title' }, title));

  if (models.length === 0) {
    panel.append(el('div', { class: 'empty' }, 'That agent returned no models.'));
  }
  for (const model of models) {
    const option = el('button', { class: 'card' });
    option.append(el('div', { class: 'card-row' }, el('span', { class: 'card-title' }, model.label)));
    option.append(el('div', { class: 'card-meta' }, el('span', {}, model.id)));
    option.onclick = () => {
      onPick(model.id);
      sheet.remove();
    };
    panel.append(option);
  }

  const cancel = el('button', { class: 'btn' }, 'Cancel');
  cancel.onclick = () => sheet.remove();
  panel.append(cancel);

  sheet.append(panel);
  sheet.onclick = (event) => {
    if (event.target === sheet) sheet.remove();
  };
  document.body.append(sheet);
}

async function refreshNotificationCard(card: HTMLElement): Promise<void> {
  try {
    card.replaceChildren(notificationPanel(await pushStatus(), () => refreshNotificationCard(card)));
  } catch (err) {
    card.replaceChildren(el('div', { class: 'bubble error' }, (err as Error).message));
  }
}

// ------------------------------------------------------- notification panel

/**
 * The notifications section of the settings page. On iOS the answer to "why
 * didn't my phone buzz?" is almost always a setup step the user has not done
 * yet, so this states which step that is rather than showing a dead toggle.
 */
function notificationPanel(status: PushStatus, refresh: () => Promise<void>): DocumentFragment {
  const fragment = document.createDocumentFragment();

  fragment.append(
    el(
      'div',
      { class: 'push-explainer' },
      'Get a notification when the agent needs an approval, or when it finishes a turn.',
    ),
  );

  if (status.availability === 'needs-install') {
    fragment.append(installInstructions());
    return fragment;
  }

  if (status.availability !== 'ready') {
    fragment.append(el('div', { class: 'bubble notice' }, status.detail));
    if (status.availability === 'denied') {
      const retry = el('button', { class: 'btn' }, 'Check again');
      retry.onclick = () => void refresh();
      fragment.append(el('div', { class: 'btn-row' }, retry));
    }
    return fragment;
  }

  const row = el('div', { class: 'push-row' });
  row.append(
    el(
      'div',
      { class: 'push-row-text' },
      el('span', { class: 'push-row-title' }, status.subscribed ? 'Notifications are on' : 'Notifications are off'),
      el(
        'span',
        { class: 'push-row-sub' },
        status.subscribed
          ? `This device is registered${status.devices > 1 ? ` (${status.devices} devices total)` : ''}.`
          : 'This device will not be notified.',
      ),
    ),
  );

  const toggle = el(
    'button',
    { class: `btn ${status.subscribed ? 'danger' : 'primary'}` },
    status.subscribed ? 'Turn off' : 'Turn on',
  );
  toggle.onclick = async () => {
    toggle.setAttribute('disabled', 'true');
    toggle.textContent = status.subscribed ? 'Turning off…' : 'Turning on…';
    try {
      // enablePush must stay inside this click: Safari drops a permission
      // request that is not attached to a user gesture.
      if (status.subscribed) await disablePush();
      else await enablePush();
      toast(status.subscribed ? 'Notifications turned off' : 'Notifications turned on');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
    await refresh();
  };
  row.append(toggle);
  fragment.append(row);

  if (status.subscribed) {
    // Whether Approve/Deny appear on the notification itself is a platform
    // decision, so state which one this device made rather than leave the user
    // wondering if something is broken.
    fragment.append(
      el(
        'div',
        { class: 'push-row-sub' },
        status.maxActions >= 2
          ? 'Approval notifications carry Approve and Deny buttons.'
          : 'This device does not support buttons on notifications, so an approval opens straight to its card instead.',
      ),
    );

    fragment.append(turnFinishedToggle());

    const test = el('button', { class: 'btn' }, 'Send a test notification');
    test.onclick = async () => {
      test.setAttribute('disabled', 'true');
      try {
        const result = await sendTestPush();
        toast(result.sent > 0 ? `Test sent to ${result.sent} device${result.sent === 1 ? '' : 's'}` : 'No device received it');
      } catch (err) {
        toast((err as Error).message, 'error');
      }
      test.removeAttribute('disabled');
    };
    fragment.append(el('div', { class: 'btn-row' }, test));

    if (!isStandalone()) {
      fragment.append(
        el(
          'div',
          { class: 'status-line' },
          'Tip: add AgentDeck to your Home Screen so notifications keep arriving with the browser closed.',
        ),
      );
    }
  }

  return fragment;
}

/**
 * Approvals are deliberately not switchable: they block the CLI, so silencing
 * them would strand a session with no sign of why.
 */
function turnFinishedToggle(): HTMLElement {
  const row = el('div', { class: 'toggle-row' });
  const enabled = state.settings.notifications.turnFinished ?? true;

  row.append(
    el(
      'div',
      { class: 'push-row-text' },
      el('span', { class: 'push-row-title' }, 'When a turn finishes'),
      el('span', { class: 'push-row-sub' }, 'Approval requests always notify, because they block the agent.'),
    ),
  );

  const toggle = el('input', {
    type: 'checkbox',
    class: 'switch',
    'aria-label': 'Notify when a turn finishes',
  }) as HTMLInputElement;
  toggle.checked = enabled;
  toggle.onchange = async () => {
    toggle.disabled = true;
    try {
      const result = await api<{ settings: AppSettings }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ notifications: { turnFinished: toggle.checked } }),
      });
      state.settings = result.settings;
    } catch (err) {
      toast((err as Error).message, 'error');
      toggle.checked = !toggle.checked;
    }
    toggle.disabled = false;
  };
  row.append(toggle);
  return row;
}

function installInstructions(): HTMLElement {
  const box = el('div', { class: 'push-install' });
  box.append(el('div', { class: 'push-row-title' }, 'Add AgentDeck to your Home Screen first'));
  box.append(
    el(
      'div',
      { class: 'push-row-sub' },
      'iOS only delivers notifications to an installed app, not to a Safari tab.',
    ),
  );
  const steps = el('ol', { class: 'push-steps' });
  for (const step of [
    'Tap the Share button in Safari\u2019s toolbar.',
    'Choose \u201CAdd to Home Screen\u201D.',
    'Open AgentDeck from the new icon, then come back here and turn notifications on.',
  ]) {
    steps.append(el('li', {}, step));
  }
  box.append(steps);
  return box;
}

// ---------------------------------------------------------------- presence

/**
 * Tells the server which session is in front of a human. It uses that to skip
 * a "turn finished" push you would only be reading off the screen anyway.
 */
let presenceSessionId: string | null = null;

function reportPresence(): void {
  const wanted =
    state.route.name === 'session' && document.visibilityState === 'visible' ? state.route.sessionId : null;
  if (wanted === presenceSessionId) return;

  if (presenceSessionId) sendQuiet({ t: 'presence', sessionId: presenceSessionId, visible: false });
  if (wanted) sendQuiet({ t: 'presence', sessionId: wanted, visible: true });
  presenceSessionId = wanted;
}

/** Presence is advisory, so a closed socket is not worth a "reconnecting" toast. */
function sendQuiet(message: Record<string, unknown>): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

// ------------------------------------------------------------- session view

let streamEl: HTMLElement | null = null;
/** blockId -> element, so streamed deltas land in the right bubble. */
const blockNodes = new Map<string, HTMLElement>();
/** blockId -> accumulated text, for progressive markdown rendering. */
const streamingText = new Map<string, string>();

function sessionView(): DocumentFragment {
  const session = state.sessions.get(state.route.sessionId);
  const fragment = document.createDocumentFragment();
  blockNodes.clear();
  streamingText.clear();

  const actions: HTMLElement[] = [];
  const refreshBtn = el(
    'button',
    { class: 'icon-btn', id: 'header-refresh', 'aria-label': 'Reload conversation', title: 'Reload conversation' },
    '\u21BB',
  );
  refreshBtn.onclick = () => {
    if (state.tab === 'git') {
      void loadGit();
      return;
    }
    refreshBtn.classList.add('spinning');
    void loadTranscript(state.route.sessionId).finally(() => refreshBtn.classList.remove('spinning'));
  };
  actions.push(refreshBtn);

  if (session?.live) {
    const stopBtn = el('button', { class: 'icon-btn', id: 'header-stop', 'aria-label': 'Stop session', title: 'Stop session' }, '⏹');
    stopBtn.onclick = () => void stopSession();
    actions.push(stopBtn);
  } else if (session) {
    const delBtn = el('button', { class: 'icon-btn', id: 'header-delete', 'aria-label': 'Delete conversation', title: 'Delete conversation' }, '🗑');
    delBtn.onclick = () => void deleteSession(session.id);
    actions.push(delBtn);
  }

  fragment.append(
    topbar(session?.title ?? 'Session', session ? `${session.workspaceName} · ${session.adapterName} · ${session.state}` : undefined, {
      back: true,
      actions,
    }),
  );

  const tabs = el('nav', { class: 'tabs' });
  for (const [id, label] of [
    ['chat', 'Conversation'],
    ['git', 'Git'],
  ] as const) {
    const tab = el('button', { class: 'tab', role: 'tab', 'aria-selected': String(state.tab === id) }, label);
    tab.onclick = () => {
      state.tab = id;
      render();
      if (id === 'chat') void loadTranscript(state.route.sessionId);
      else void loadGit();
    };
    tabs.append(tab);
  }
  fragment.append(tabs);

  if (state.tab === 'git') {
    const scroll = el('div', { class: 'scroll', id: 'git-panel' }, el('div', { class: 'empty' }, 'Loading git status…'));
    fragment.append(scroll);
    return fragment;
  }

  const scroll = el('div', { class: 'scroll' });
  const stream = el('div', { class: 'stream', id: 'stream' });
  streamEl = stream;
  scroll.append(stream);
  fragment.append(scroll);

  if (session && !session.live) {
    fragment.append(deadSessionBar(session));
  } else {
    fragment.append(composer());
  }
  return fragment;
}

function deadSessionBar(session: SessionSummary): HTMLElement {
  const bar = el('div', { class: 'composer' });
  const info = el(
    'div',
    { class: 'status-line' },
    session.state === 'crashed'
      ? 'The CLI process crashed. Its transcript is kept below.'
      : session.state === 'orphaned'
        ? 'This session was interrupted by a server restart.'
        : 'This session has stopped.',
  );
  info.style.flex = '1';

  const del = el('button', { class: 'btn danger' }, 'Delete');
  del.onclick = () => void deleteSession(session.id);

  const resume = el('button', { class: 'btn primary' }, 'Reconnect');
  resume.onclick = async () => {
    resume.setAttribute('disabled', 'true');
    try {
      const result = await api<{ session: SessionSummary }>(`/api/sessions/${session.id}/resume`, { method: 'POST' });
      state.sessions.set(result.session.id, result.session);
      render();
      void loadTranscript(session.id);
      toast('Session reconnected');
    } catch (err) {
      toast((err as Error).message, 'error');
      resume.removeAttribute('disabled');
    }
  };

  bar.append(info, del, resume);
  return bar;
}

function composer(): HTMLElement {
  const bar = el('div', { class: 'composer' });
  const input = el('textarea', {
    id: 'composer-input',
    rows: '1',
    placeholder: 'Send an instruction…',
    autocapitalize: 'sentences',
    enterkeyhint: 'send',
  }) as HTMLTextAreaElement;

  const autosize = (): void => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`;
  };
  input.oninput = autosize;

  const stop = el('button', { class: 'stop-btn', id: 'cancel-btn', 'aria-label': 'Cancel current task' }, '■');
  stop.onclick = () => {
    send({ t: 'cancel', sessionId: state.route.sessionId });
    toast('Cancelling…');
  };

  const sendBtn = el('button', { class: 'send-btn', 'aria-label': 'Send' }, '↑');
  const submit = (): void => {
    const text = input.value.trim();
    if (!text) return;
    if (!send({ t: 'instruct', sessionId: state.route.sessionId, text, clientMsgId: String(Date.now()) })) return;
    input.value = '';
    autosize();
  };
  sendBtn.onclick = submit;
  input.onkeydown = (event: KeyboardEvent) => {
    // Enter sends on a hardware keyboard; Shift+Enter makes a newline.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && window.matchMedia('(pointer: fine)').matches) {
      event.preventDefault();
      submit();
    }
  };

  bar.append(input, stop, sendBtn);
  queueMicrotask(updateSessionChrome);
  return bar;
}

/** Reflect session state in the header and composer without a full re-render. */
function updateSessionChrome(): void {
  const session = state.sessions.get(state.route.sessionId);
  if (!session) return;

  const waiting = session.pendingPermissions?.length ?? 0;
  const subtitle = document.querySelector('.topbar .subtitle');
  if (subtitle) {
    subtitle.textContent = waiting
      ? `${session.workspaceName} · waiting for your approval`
      : `${session.workspaceName} · ${session.adapterName} · ${session.state}`;
  }
  document.querySelector('.topbar')?.classList.toggle('awaiting-approval', waiting > 0);
  const heading = document.querySelector('.topbar h1');
  if (heading && heading.firstChild) heading.firstChild.textContent = session.title;

  const busy = session.state === 'busy' || session.state === 'cancelling';
  document.getElementById('cancel-btn')?.classList.toggle('hidden', !busy);
  document.getElementById('header-stop')?.classList.toggle('hidden', !session.live);

  // A session that died while being watched swaps the composer for a reconnect bar.
  const composerBar = document.querySelector('.composer');
  if (composerBar && !session.live && document.getElementById('composer-input')) {
    render();
    // render() built an empty stream; put the transcript back into it.
    void loadTranscript(session.id);
  }
}

// --------------------------------------------------------------- event nodes

function scrollToBottom(force = false): void {
  const scroll = document.querySelector('.scroll') as HTMLElement | null;
  if (!scroll) return;
  const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 160;
  if (force || nearBottom) scroll.scrollTop = scroll.scrollHeight;
}

function appendNotice(text: string): void {
  if (!streamEl) return;
  streamEl.append(el('div', { class: 'bubble notice' }, text));
  scrollToBottom();
}

function renderEvent(event: SessionEvent): void {
  const previous = state.lastSeq.get(event.sessionId) ?? 0;
  if (event.seq <= previous) return; // replay overlap
  state.lastSeq.set(event.sessionId, event.seq);
  if (!streamEl) return;

  const stream = streamEl;
  const text = (key: string): string => String(event[key] ?? '');

  switch (event.type) {
    case 'turn_started': {
      const bubble = el('div', { class: 'bubble user' });
      renderMarkdownInto(bubble, text('text'));
      stream.append(bubble);
      break;
    }

    case 'message_delta': {
      const blockId = text('blockId');
      let node = blockNodes.get(blockId);
      if (!node) {
        node = el('div', { class: 'bubble assistant streaming' });
        blockNodes.set(blockId, node);
        stream.append(node);
      }
      const current = (streamingText.get(blockId) ?? '') + text('text');
      streamingText.set(blockId, current);
      renderMarkdownInto(node, current);
      break;
    }

    case 'thinking_delta': {
      const blockId = text('blockId');
      let node = blockNodes.get(blockId);
      if (!node) {
        node = thinkingBlock();
        blockNodes.set(blockId, node);
        stream.append(node);
      }
      const target = node.querySelector('.body') as HTMLElement | null;
      if (target) target.append(document.createTextNode(text('text')));
      break;
    }

    case 'message': {
      const blockId = text('blockId');
      const role = text('role') === 'user' ? 'user' : 'assistant';
      const existing = blockNodes.get(blockId);
      if (existing && !existing.classList.contains('event')) {
        // Replace streamed text with the authoritative final block.
        renderMarkdownInto(existing, text('text'));
        existing.classList.remove('streaming');
      } else {
        const node = el('div', { class: `bubble ${role}` });
        renderMarkdownInto(node, text('text'));
        blockNodes.set(blockId, node);
        stream.append(node);
      }
      streamingText.delete(blockId);
      break;
    }

    case 'thinking': {
      const blockId = text('blockId');
      const existing = blockNodes.get(blockId);
      if (existing) {
        const body = existing.querySelector('.body');
        if (body) body.textContent = text('text');
      } else {
        const node = thinkingBlock(text('text'));
        blockNodes.set(blockId, node);
        stream.append(node);
      }
      break;
    }

    case 'tool_use': {
      const node = el('details', { class: 'event tool', id: `tool-${text('toolUseId')}` });
      node.append(
        el(
          'summary',
          {},
          el('span', { class: 'label' }, text('name')),
          el('span', { class: 'headline' }, text('summary')),
        ),
      );
      node.append(el('pre', { class: 'body' }, JSON.stringify(event.input ?? {}, null, 2)));
      stream.append(node);
      break;
    }

    case 'command_started': {
      const toolUseId = text('toolUseId');
      // A shell tool arrives as tool_use *and* command_started. Upgrade the
      // node the tool_use created rather than rendering the command twice.
      const existing = document.getElementById(`tool-${toolUseId}`);
      const node = existing ?? el('details', { class: 'event' });
      node.className = 'event command';
      node.id = `cmd-${toolUseId}`;
      node.replaceChildren(
        el(
          'summary',
          {},
          el('span', { class: 'label' }, 'run'),
          el('span', { class: 'headline' }, text('command')),
        ),
        el('pre', { class: 'body' }, '…'),
      );
      if (!existing) stream.append(node);
      break;
    }

    case 'permission_request': {
      stream.append(permissionCard(event));
      if (highlightRequestId === text('requestId')) focusPermissionCard(highlightRequestId);
      break;
    }

    case 'permission_resolved': {
      const requestId = text('requestId');
      resolvePermissionCard(requestId, text('decision') as 'allow' | 'deny', text('decidedBy'));
      // The approval is answered; do not leave its notification on the lock screen.
      void dismissNotification(`perm-${requestId}`);
      break;
    }

    case 'command_finished':
    case 'tool_result': {
      const id = event.type === 'command_finished' ? `cmd-${text('toolUseId')}` : `tool-${text('toolUseId')}`;
      const owner = document.getElementById(id);
      const output = event.type === 'command_finished' ? text('output') : text('content');
      if (owner) {
        const body = owner.querySelector('.body') as HTMLElement | null;
        if (body) body.textContent = output || '(no output)';
        if (event.isError === true) owner.classList.add('failed');
      } else {
        const node = el('details', { class: `event tool ${event.isError ? 'failed' : ''}` });
        node.append(el('summary', {}, el('span', { class: 'label' }, 'result'), el('span', { class: 'headline' }, output.split('\n')[0] ?? '')));
        node.append(el('pre', { class: 'body' }, output));
        stream.append(node);
      }
      break;
    }

    case 'turn_finished': {
      const cost = typeof event.costUsd === 'number' ? ` · $${(event.costUsd as number).toFixed(3)}` : '';
      const duration = typeof event.durationMs === 'number' ? ` · ${Math.round((event.durationMs as number) / 100) / 10}s` : '';
      stream.append(el('div', { class: 'turn-divider' }, `${event.isError ? 'turn failed' : 'done'}${duration}${cost}`));
      break;
    }

    case 'session_cancelled':
      stream.append(el('div', { class: 'bubble notice' }, `Cancelled — ${text('reason')}`));
      break;

    case 'session_started':
      stream.append(
        el('div', { class: 'bubble notice' }, `${event.resumed ? 'Reattached to' : 'Started'} CLI session${event.model ? ` · ${text('model')}` : ''}`),
      );
      break;

    case 'session_finished':
      stream.append(el('div', { class: 'bubble notice' }, `Process ended (${text('reason')})`));
      break;

    case 'notice':
      stream.append(el('div', { class: 'bubble notice' }, text('message')));
      break;

    case 'error': {
      const node = el('div', { class: 'bubble error' }, text('message'));
      if (event.detail) node.append(el('div', { class: 'status-line' }, text('detail')));
      stream.append(node);
      break;
    }
  }

  scrollToBottom();
}

/**
 * The CLI is blocked until this is answered, so the card is deliberately loud
 * and shows the exact command that will run.
 */
function permissionCard(event: SessionEvent): HTMLElement {
  const requestId = String(event['requestId'] ?? '');
  const command = typeof event['command'] === 'string' ? event['command'] : '';
  const summary = String(event['summary'] ?? '');
  const toolName = String(event['displayName'] ?? event['toolName'] ?? 'tool');

  const card = el('div', { class: 'permission', id: `perm-${requestId}` });
  card.append(
    el(
      'div',
      { class: 'permission-head' },
      el('span', { class: 'permission-icon' }, '!'),
      el('span', {}, `${toolName} needs your approval`),
    ),
  );
  card.append(el('pre', { class: 'permission-command' }, command || summary));

  const actions = el('div', { class: 'permission-actions' });
  const deny = el('button', { class: 'btn danger' }, 'Deny');
  const allow = el('button', { class: 'btn primary' }, 'Approve');

  const decide = (decision: 'allow' | 'deny'): void => {
    allow.setAttribute('disabled', 'true');
    deny.setAttribute('disabled', 'true');
    if (!send({ t: 'permission', sessionId: state.route.sessionId, requestId, decision })) {
      allow.removeAttribute('disabled');
      deny.removeAttribute('disabled');
      return;
    }
    actions.replaceChildren(el('span', { class: 'permission-pending' }, 'Sending…'));
  };

  allow.onclick = () => decide('allow');
  deny.onclick = () => decide('deny');
  actions.append(deny, allow);
  card.append(actions);
  return card;
}

/** Which approval the user tapped in a notification, until it is on screen. */
let highlightRequestId: string | null = null;

/**
 * Bring the tapped approval into view. On platforms that draw no action buttons
 * on a notification — Safari and iOS — this is the whole answer: one tap lands
 * on the card with Approve and Deny already under the thumb.
 */
function focusPermissionCard(requestId: string): void {
  const card = document.getElementById(`perm-${requestId}`);
  if (!card) {
    // The transcript may still be loading; try again when it has.
    highlightRequestId = requestId;
    return;
  }
  highlightRequestId = null;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('highlighted');
  setTimeout(() => card.classList.remove('highlighted'), 2600);
}

function resolvePermissionCard(requestId: string, decision: 'allow' | 'deny', decidedBy: string): void {
  const card = document.getElementById(`perm-${requestId}`);
  if (!card) return;
  card.classList.add(decision === 'allow' ? 'allowed' : 'denied');
  const actions = card.querySelector('.permission-actions');
  const who = decidedBy && decidedBy !== 'null' ? ` by ${decidedBy}` : '';
  const label = decision === 'allow' ? `Approved${who}` : `Denied${who}`;
  if (actions) actions.replaceChildren(el('span', { class: 'permission-outcome' }, label));
}

function thinkingBlock(initial = ''): HTMLElement {
  const node = el('details', { class: 'event' });
  node.append(el('summary', {}, el('span', { class: 'label' }, 'thinking')));
  node.append(el('pre', { class: 'body' }, initial));
  return node;
}

async function stopSession(): Promise<void> {
  const session = state.sessions.get(state.route.sessionId);
  if (!session?.live) return;
  try {
    await api(`/api/sessions/${session.id}/stop`, { method: 'POST' });
    toast('Session stopped');
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

async function deleteSession(sessionId: string): Promise<void> {
  if (!window.confirm('Delete this conversation history?')) return;
  try {
    await api(`/api/sessions/${sessionId}`, { method: 'DELETE' });
    state.sessions.delete(sessionId);
    state.lastSeq.delete(sessionId);
    if (state.route.name === 'session' && state.route.sessionId === sessionId) {
      navigate('/');
    } else {
      render();
    }
    toast('Conversation deleted');
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

async function clearAllHistory(): Promise<void> {
  if (!window.confirm('Delete all conversation history?')) return;
  try {
    await api('/api/sessions/clear-history', { method: 'POST' });
    for (const [id, s] of state.sessions) {
      if (!s.live) {
        state.sessions.delete(id);
        state.lastSeq.delete(id);
      }
    }
    if (state.route.name === 'session' && !state.sessions.has(state.route.sessionId)) {
      navigate('/');
    } else {
      render();
    }
    toast('History cleared');
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

// ------------------------------------------------------------------ git view

async function loadGit(): Promise<void> {
  const session = state.sessions.get(state.route.sessionId);
  const panel = document.getElementById('git-panel');
  if (!session || !panel) return;

  try {
    const result = await api<{ git: GitStatusView }>(`/api/workspaces/${session.workspaceId}/git/status`);
    panel.replaceChildren(gitPanel(result.git, session.workspaceId));
  } catch (err) {
    panel.replaceChildren(el('div', { class: 'empty' }, (err as Error).message));
  }
}

type GitStatusView = {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  files: { path: string; status: string; staged: boolean; unstaged: boolean; untracked: boolean }[];
  stats: { insertions: number; deletions: number; filesChanged: number };
  error?: string;
};

function gitPanel(git: GitStatusView, workspaceId: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  if (!git.isRepo) {
    fragment.append(el('div', { class: 'empty' }, 'This workspace is not a git repository.'));
    return fragment;
  }
  if (git.error) fragment.append(el('div', { class: 'bubble error' }, git.error));

  const summary = el('div', { class: 'git-summary' });
  summary.append(el('span', { class: 'badge' }, git.branch ?? 'unknown branch'));
  summary.append(el('span', { class: `badge ${git.clean ? 'clean' : 'dirty'}` }, git.clean ? 'clean' : 'uncommitted changes'));
  if (git.ahead) summary.append(el('span', { class: 'badge' }, `↑${git.ahead}`));
  if (git.behind) summary.append(el('span', { class: 'badge' }, `↓${git.behind}`));
  if (git.stats.filesChanged) {
    summary.append(
      el('span', { class: 'badge' }, `${git.stats.filesChanged} files +${git.stats.insertions}/−${git.stats.deletions}`),
    );
  }
  fragment.append(summary);

  const refresh = el('button', { class: 'btn' }, 'Refresh');
  refresh.onclick = () => void loadGit();
  const wholeDiff = el('button', { class: 'btn' }, 'Full diff');
  wholeDiff.onclick = () => void loadDiff(workspaceId, undefined);
  fragment.append(el('div', { class: 'btn-row' }, refresh, wholeDiff));

  fragment.append(el('div', { class: 'section-title' }, `Changed files (${git.files.length})`));
  if (git.files.length === 0) fragment.append(el('div', { class: 'empty' }, 'Working tree is clean.'));

  for (const file of git.files) {
    const row = el('button', { class: 'file-row' });
    row.append(el('span', { class: 'status' }, file.status.replace(/ /g, '·')));
    row.append(el('span', { class: 'path' }, file.path));
    if (file.untracked) row.append(el('span', { class: 'badge' }, 'new'));
    else if (file.staged) row.append(el('span', { class: 'badge' }, 'staged'));
    row.onclick = () => void loadDiff(workspaceId, file.path);
    fragment.append(row);
  }

  fragment.append(el('div', { id: 'diff-holder' }));
  return fragment;
}

async function loadDiff(workspaceId: string, file?: string): Promise<void> {
  const holder = document.getElementById('diff-holder');
  if (!holder) return;
  holder.replaceChildren(el('div', { class: 'status-line' }, 'Loading diff…'));
  try {
    const query = file ? `?file=${encodeURIComponent(file)}` : '';
    const result = await api<{ diff: string; truncated: boolean; error?: string }>(
      `/api/workspaces/${workspaceId}/git/diff${query}`,
    );
    if (result.error) {
      holder.replaceChildren(el('div', { class: 'bubble error' }, result.error));
      return;
    }
    holder.replaceChildren(
      el('div', { class: 'section-title' }, file ? `Diff · ${file}` : 'Diff · working tree'),
      renderDiff(result.diff || '(no changes)'),
      ...(result.truncated ? [el('div', { class: 'status-line' }, 'Diff truncated')] : []),
    );
    holder.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    holder.replaceChildren(el('div', { class: 'bubble error' }, (err as Error).message));
  }
}

function renderDiff(diff: string): HTMLElement {
  const container = el('div', { class: 'diff' });
  for (const line of diff.split('\n')) {
    const cls = line.startsWith('+++') || line.startsWith('---')
      ? 'meta'
      : line.startsWith('+')
        ? 'add'
        : line.startsWith('-')
          ? 'del'
          : line.startsWith('@@')
            ? 'hunk'
            : line.startsWith('diff ') || line.startsWith('index ')
              ? 'meta'
              : '';
    container.append(el('div', cls ? { class: cls } : {}, line || ' '));
  }
  return container;
}

// ------------------------------------------------------------------ clipboard

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null;
  const copyBtn = target?.closest('.code-copy-btn') as HTMLButtonElement | null;
  if (!copyBtn) return;
  const codeBlock = copyBtn.closest('.code-block');
  const codeEl = codeBlock?.querySelector('pre code');
  const codeText = codeEl?.textContent ?? '';
  if (!codeText) return;

  const onCopied = () => {
    copyBtn.textContent = 'Copied!';
    copyBtn.classList.add('copied');
    setTimeout(() => {
      copyBtn.textContent = 'Copy';
      copyBtn.classList.remove('copied');
    }, 2000);
  };

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(codeText).then(onCopied).catch(() => {
      fallbackCopy(codeText, onCopied);
    });
  } else {
    fallbackCopy(codeText, onCopied);
  }
});

function fallbackCopy(text: string, onSuccess: () => void): void {
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    if (ok) onSuccess();
    else toast('Failed to copy', 'error');
  } catch {
    toast('Failed to copy', 'error');
  }
}

// ------------------------------------------------------------------ bootstrap

// Before the first render, so there is no flash of the wrong palette.
initTheme();

parseRoute();
render();
connect();

// Registers the service worker and re-syncs this device's push subscription.
// A tapped notification arrives here as a navigate message from the worker.
void initPush((url, requestId) => {
  if (requestId) highlightRequestId = requestId;
  const hash = new URL(url, location.href).hash;
  if (hash && hash !== location.hash) location.hash = hash;
  else {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    if (requestId) focusPermissionCard(requestId);
  }
});

// A cold start from a notification tap carries the approval id in the query
// string, because the service worker cannot address the hash router directly.
const launchPerm = new URLSearchParams(location.search).get('perm');
if (launchPerm) {
  highlightRequestId = launchPerm;
  // Drop it from the URL so a reload does not re-trigger the jump.
  history.replaceState(null, '', location.pathname + location.hash);
}

// A phone aggressively suspends background tabs; reconnect as soon as it wakes.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') {
    reportPresence();
    return;
  }
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    window.clearTimeout(reconnectTimer);
    reconnectDelay = 500;
    connect();
  }
  // iOS suspends the tab hard enough that events can be missed without the
  // socket ever reporting a close, so re-read the transcript on the way back in.
  if (state.route.name === 'session' && state.tab === 'chat') {
    void loadTranscript(state.route.sessionId);
  }
  reportPresence();
});
window.addEventListener('online', () => connect());
window.setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN) send({ t: 'ping' });
}, 25_000);

