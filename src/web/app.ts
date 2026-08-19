/**
 * Remote dev console — mobile client.
 *
 * Deliberately framework-free: the streaming view appends to the DOM instead of
 * re-rendering, which keeps long sessions smooth on a phone.
 */

type WorkspaceView = { id: string; name: string; enabled: boolean; isGitRepo: boolean };

type SessionSummary = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  title: string;
  state: 'starting' | 'idle' | 'busy' | 'cancelling' | 'exited' | 'crashed' | 'orphaned';
  model: string | null;
  createdAt: number;
  updatedAt: number;
  lastSeq: number;
  live: boolean;
  resumable: boolean;
  pendingInstructions: number;
  exit?: { code: number | null; signal: string | null; reason: string } | null;
};

type SessionEvent = { seq: number; ts: number; sessionId: string; type: string } & Record<string, unknown>;

type ServerMessage =
  | { t: 'welcome'; identity: { login: string | null; displayName: string | null; viaTailscale: boolean }; workspaces: WorkspaceView[]; sessions: SessionSummary[]; limits: { maxConcurrentSessions: number; maxInstructionChars: number } }
  | { t: 'pong' }
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
  sessions: new Map<string, SessionSummary>(),
  /** Highest event sequence rendered per session, for gap-free reconnect. */
  lastSeq: new Map<string, number>(),
  route: { name: 'home' as 'home' | 'session', sessionId: '' },
  tab: 'chat' as 'chat' | 'git',
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
  };

  ws.onclose = () => {
    socket = null;
    setConn('offline');
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
      state.sessions = new Map(message.sessions.map((s) => [s.id, s]));
      setConn('online');
      render();
      if (state.route.name === 'session') subscribe(state.route.sessionId);
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
  else state.route = { name: 'home', sessionId: '' };
}

function navigate(hash: string): void {
  location.hash = hash;
}

window.addEventListener('hashchange', () => {
  parseRoute();
  state.tab = 'chat';
  render();
  if (state.route.name === 'session') subscribe(state.route.sessionId);
});

// --------------------------------------------------------------------- views

function render(): void {
  app.replaceChildren(state.route.name === 'home' ? homeView() : sessionView());
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
  fragment.append(topbar('Remote Dev Console', state.identity?.viaTailscale ? 'via Tailscale' : 'local access'));

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
    if (workspace.enabled) card.onclick = () => void startSession(workspace);
    scroll.append(card);
  }

  scroll.append(el('div', { class: 'section-title' }, `Active sessions (${active.length})`));
  if (active.length === 0) scroll.append(el('div', { class: 'empty' }, 'Nothing running right now.'));
  for (const session of active) scroll.append(sessionCard(session));

  if (past.length > 0) {
    scroll.append(el('div', { class: 'section-title' }, 'History'));
    for (const session of past) scroll.append(sessionCard(session));
  }

  fragment.append(scroll);
  return fragment;
}

function sessionCard(session: SessionSummary): HTMLElement {
  const card = el('button', { class: 'card' });
  card.append(
    el(
      'div',
      { class: 'card-row' },
      el('span', { class: 'card-title' }, session.title),
      el('span', { class: 'badge', 'data-state': session.state }, session.state),
    ),
  );
  card.append(
    el(
      'div',
      { class: 'card-meta' },
      el('span', {}, session.workspaceName),
      el('span', {}, relativeTime(session.updatedAt)),
      ...(session.model ? [el('span', {}, session.model)] : []),
    ),
  );
  card.onclick = () => navigate(`/s/${session.id}`);
  return card;
}

async function startSession(workspace: WorkspaceView): Promise<void> {
  try {
    const result = await api<{ session: SessionSummary }>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: workspace.id }),
    });
    state.sessions.set(result.session.id, result.session);
    state.lastSeq.set(result.session.id, 0);
    navigate(`/s/${result.session.id}`);
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

// ------------------------------------------------------------- session view

let streamEl: HTMLElement | null = null;
/** blockId -> element, so streamed deltas land in the right bubble. */
const blockNodes = new Map<string, HTMLElement>();

function sessionView(): DocumentFragment {
  const session = state.sessions.get(state.route.sessionId);
  const fragment = document.createDocumentFragment();
  blockNodes.clear();

  const stopBtn = el('button', { class: 'icon-btn', id: 'header-stop', 'aria-label': 'Stop session' }, '⏹');
  stopBtn.onclick = () => void stopSession();

  fragment.append(
    topbar(session?.title ?? 'Session', session ? `${session.workspaceName} · ${session.state}` : undefined, {
      back: true,
      actions: [stopBtn],
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
      if (id === 'chat') subscribe(state.route.sessionId);
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

  const resume = el('button', { class: 'btn primary' }, 'Reconnect');
  resume.onclick = async () => {
    resume.setAttribute('disabled', 'true');
    try {
      const result = await api<{ session: SessionSummary }>(`/api/sessions/${session.id}/resume`, { method: 'POST' });
      state.sessions.set(result.session.id, result.session);
      render();
      subscribe(session.id);
      toast('Session reconnected');
    } catch (err) {
      toast((err as Error).message, 'error');
      resume.removeAttribute('disabled');
    }
  };

  bar.append(info, resume);
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

  const subtitle = document.querySelector('.topbar .subtitle');
  if (subtitle) subtitle.textContent = `${session.workspaceName} · ${session.state}`;
  const heading = document.querySelector('.topbar h1');
  if (heading && heading.firstChild) heading.firstChild.textContent = session.title;

  const busy = session.state === 'busy' || session.state === 'cancelling';
  document.getElementById('cancel-btn')?.classList.toggle('hidden', !busy);
  document.getElementById('header-stop')?.classList.toggle('hidden', !session.live);

  // A session that died while being watched swaps the composer for a reconnect bar.
  const composerBar = document.querySelector('.composer');
  if (composerBar && !session.live && document.getElementById('composer-input')) render();
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
      stream.append(el('div', { class: 'bubble user' }, text('text')));
      break;
    }

    case 'message_delta':
    case 'thinking_delta': {
      const blockId = text('blockId');
      let node = blockNodes.get(blockId);
      if (!node) {
        node =
          event.type === 'message_delta'
            ? el('div', { class: 'bubble assistant streaming' })
            : thinkingBlock();
        blockNodes.set(blockId, node);
        stream.append(node);
      }
      const target = node.classList.contains('event') ? (node.querySelector('.body') as HTMLElement) : node;
      target.append(document.createTextNode(text('text')));
      break;
    }

    case 'message': {
      const blockId = text('blockId');
      const existing = blockNodes.get(blockId);
      if (existing && !existing.classList.contains('event')) {
        // Replace streamed text with the authoritative final block.
        existing.textContent = text('text');
        existing.classList.remove('streaming');
      } else {
        const node = el('div', { class: `bubble ${text('role') === 'user' ? 'user' : 'assistant'}` }, text('text'));
        blockNodes.set(blockId, node);
        stream.append(node);
      }
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
      const node = el('details', { class: 'event command', id: `cmd-${text('toolUseId')}` });
      node.append(
        el(
          'summary',
          {},
          el('span', { class: 'label' }, 'run'),
          el('span', { class: 'headline' }, text('command')),
        ),
      );
      node.append(el('pre', { class: 'body' }, '…'));
      stream.append(node);
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
    await api(`/api/sessions/${session.id}`, { method: 'DELETE' });
    toast('Session stopped');
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

// ------------------------------------------------------------------ bootstrap

parseRoute();
render();
connect();

// A phone aggressively suspends background tabs; reconnect as soon as it wakes.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (!socket || socket.readyState !== WebSocket.OPEN)) {
    window.clearTimeout(reconnectTimer);
    reconnectDelay = 500;
    connect();
  }
});
window.addEventListener('online', () => connect());
window.setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN) send({ t: 'ping' });
}, 25_000);
