# AgentDeck

A mobile-first remote development console. It runs on your development machine,
keeps AI coding CLI sessions alive in the background, and is reachable from your
phone over your Tailscale tailnet — never from the public internet.
## AI Development Note
This project was built primarily with AI coding agents for personal use. As a result, some parts of the codebase may be rough around the edges and may not follow ideal production-grade practices. The project is actively developed and improved based on real-world use.

```
iPhone
  │  HTTPS (tailnet only)
  ▼
Tailscale Serve  ──►  127.0.0.1:4823   (this app)
                            │
                            ▼
                      Session manager
                            │
                    ┌───────┴────────┐
                    ▼                ▼
             Claude Code CLI   Antigravity CLI (agy)   (pick one per session)
                    └───────┬────────┘
                            ▼
                  A registered workspace directory
```

## What it does

- Start and reattach to AI coding sessions from your phone on **Claude Code** or
  the **Antigravity CLI (`agy`)** — chosen per session.
- **Approve or deny** a command the agent wants to run, from the phone, before
  it runs.
- Streaming output, token by token, plus a structured feed of tool calls and
  shell commands.
- Sessions survive the browser closing, the phone sleeping, and the network
  dropping. Reconnecting replays exactly what you missed.
- Cancel a running task without losing the conversation.
- Read-only git status and diffs for the workspace.
- Only directories you explicitly register can ever be touched.

## Requirements

- Node.js 22 or newer (developed on 24).
- At least one coding agent, already installed and authenticated:
  - `claude` (Claude Code), and/or
  - `agy` (Antigravity CLI).
- Tailscale installed and logged in on this machine.

## Quick Start (Interactive Setup Wizard)

The fastest and easiest way to set up `terminal-agent` on your machine is with the interactive setup wizard:

```bash
git clone https://github.com/your-username/terminal-agent.git
cd terminal-agent
npm install
npm run setup
```

The setup wizard features a full colored CLI walkthrough that:
1. **Detects installed AI agents**: Checks for `claude` (Claude Code) and `agy` (Antigravity CLI) binaries on your `PATH`.
2. **Configures network & port**: Sets local loopback host (`127.0.0.1`) and configurable port (`4823`).
3. **Inspects Tailscale tailnet**: Detects your machine's MagicDNS hostname and user identity, with optional identity restriction (`REQUIRE_TAILSCALE_IDENTITY`).
4. **Registers workspace repositories**: Prompts for repository directories to manage and writes `workspaces.json`.
5. **Generates `.env`**: Writes full environment configuration.
6. **Builds server & client**: Automatically compiles the TypeScript backend and bundles the web application.

> **Tip (Non-interactive / CI / Defaults)**: Run `npm run setup -- --defaults` (or `--yes`) to automatically accept detected defaults without prompting.

### Connecting from Your Phone

After running setup:

1. **Start the local server**:
   ```bash
   npm start
   ```

2. **Publish to your Tailnet (in another terminal or daemon)**:
   ```bash
   npm run serve:tailscale
   ```
   This prints your secure HTTPS URL (e.g. `https://my-macbook.tailnet-xyz.ts.net/`).

3. **Open on your mobile browser**:
   - Navigate to the printed HTTPS URL in Safari (iOS) or Chrome (Android).
   - Tap **Share → Add to Home Screen** for a full-screen, app-like development console.

4. **Turn on notifications** (see below) so the phone wakes you when the agent needs you.

---

## Push Notifications on your Phone

The point of leaving an agent running is that you can put the phone away. DevTunnel
uses Web Push so a locked phone still buzzes when:

- the agent **needs an approval** for a command (this one blocks the CLI until you answer), or
- a **turn finishes**, successfully or with an error.

### Turning them on (iPhone / iPad)

Apple only delivers push to an **installed** PWA, so the order matters:

1. Open the `https://…ts.net` URL in **Safari** (iOS 16.4 or newer).
2. **Share → Add to Home Screen**.
3. Launch DevTunnel **from the new Home Screen icon**, not from the Safari tab.
4. Tap the 🔔 button in the header → **Turn on**, and accept the iOS prompt.
5. Use **Send a test notification** to confirm the round trip.

Android and desktop Chrome/Edge/Firefox skip step 1–3: the 🔔 toggle works in a
normal tab, though installing still helps the notifications survive a closed browser.

If the sheet refuses to show a toggle it will say why — not installed yet, served
over plain `http`, permission blocked in system settings, or push disabled server-side.

### What it costs you

Delivery goes through Apple's, Google's or Mozilla's push service, so this is the
**one part of DevTunnel that leaves your tailnet**. A notification carries the session
title and a one-line summary of the command awaiting approval. Everything is encrypted
end to end (RFC 8291) — the push service can see the size and timing, not the content.
If that is not a trade you want, set `PUSH_ENABLED=false` and the whole subsystem,
including the VAPID key generation, never starts.

The keys live in `${STATE_DIR}/push/vapid.json` and registered devices in
`${STATE_DIR}/push/subscriptions.json`, both mode `0600`. Deleting `vapid.json`
invalidates every device and everyone has to turn notifications on again.

---

## Multi-Device & Team Setup

You can deploy `terminal-agent` on any machine where you want AI coding agents to run:

- **Local Laptop / Desktop (macOS / Linux / WSL)**: Keep sessions active on your primary machine while walking away from your desk.
- **Dedicated Homelab / Headless Server**: Run sessions on high-power desktop hardware or build servers.
- **Cloud VMs (AWS, GCP, Hetzner, DigitalOcean)**: Install Tailscale on the VM and access your remote cloud development environment from anywhere with zero open firewall ports.

### Setting up on a new device:

1. Ensure **Node.js 22+**, **Tailscale**, and at least one AI CLI (`claude` or `agy`) are installed.
2. Clone `terminal-agent` and run `npm install && npm run setup`.
3. Set up a background daemon (launchd on macOS, systemd on Linux, or Docker) so it starts on boot.

---

## Manual Setup

If you prefer configuring by hand:

```bash
npm install
cp workspaces.example.json workspaces.json
cp .env.example .env
npm run build
npm start
```

### 1. Register Workspaces (`workspaces.json`)

List the repositories you want accessible in `workspaces.json`:

```json
{
  "workspaces": [
    {
      "id": "my-project",
      "name": "My Project",
      "path": "~/Code/my-project",
      "enabled": true
    }
  ]
}
```

- `id` is what the browser client sends.
- `path` is the filesystem location on your machine (supports `~` expansion). Absolute paths never leave the server.

### 2. Configure Environment (`.env`)

Edit `.env` to configure your port, agents, and security settings:

```bash
HOST=127.0.0.1
PORT=4823

# Coding agents
CLI_ADAPTERS=claude-code,antigravity-cli
CLI_DEFAULT_ADAPTER=claude-code

# Lock down access to your Tailscale identity once connected
REQUIRE_TAILSCALE_IDENTITY=true
ALLOWED_TAILSCALE_USERS=you@example.com
```

### 3. Publish to Tailscale

```bash
npm run serve:tailscale
```

This sets up a background Tailscale Serve mapping (`tailscale serve --bg --https=443 http://127.0.0.1:4823`) and prints your HTTPS URL (e.g. `https://my-macbook.tailnet-xyz.ts.net/`).

See [docs/TAILSCALE.md](docs/TAILSCALE.md) for full tailnet configuration, ACLs, and troubleshooting.

## Using it from your Phone

Open the HTTPS URL on Safari or Chrome on your phone (connected to your tailnet):
- **Add to Home Screen**: Tap **Share → Add to Home Screen** for a full-screen, standalone app.
- **Home Screen**: Lists registered workspaces, active sessions, and history.
- **Start / Reattach**: Tap a workspace to start a new session or reopen an ongoing one.
- **Approvals**: When an agent wants to run a shell command or another risky action, an **Approve / Deny** prompt appears with the exact command. Nothing runs until you answer, and an unanswered request is denied after `PERMISSION_TIMEOUT_MS`.
- **Reload**: The ↻ button in the session header re-reads the whole transcript from the server.
- **Controls**: Send instructions via the composer. Tap ■ to cancel a running task without losing context.
- **Git Inspector**: View branch, modified files, and line-by-line diffs.

## Approvals, per agent

Both agents stop and ask before doing something risky, but they get there
differently, and the difference matters:

| | Claude Code | Antigravity CLI (Gemini) |
| --- | --- | --- |
| Shell commands | Asks, over the CLI's own control channel | Asks, via DevTunnel's shell broker |
| File edits | Asks (unless `acceptEdits`) | **Not gated** — see below |
| Cancels cleanly mid-turn | Yes | Yes |

Claude Code exposes `--permission-prompt-tool`, so it hands each tool request to
DevTunnel and blocks until you answer.

The Antigravity CLI has no such channel. Run it headless and it offers only two
behaviours: its `request-review` mode auto-**denies** every tool (the turn just
fails), or `--dangerously-skip-permissions` runs everything unattended. Neither
is "ask the phone".

What it does do is run every shell command as `<shell> -c "<command>"`, resolving
the shell through `PATH`. So DevTunnel puts its own `zsh`/`bash`/`sh` at the
front of that `PATH`. Each is a tiny program that hands the command line back to
the server and waits; you get the normal Approve / Deny card and push
notification, and only then does it exec the real shell. Deny it and the agent
sees a failed command and adapts. If the broker cannot be reached, the command is
**denied** — it fails closed.

**The limitation, stated plainly:** this gates shell commands. The Antigravity
CLI writes and edits files inside its own process without going through a shell,
so those edits are **not** gated. Keep it pointed at workspaces you are willing
to let it change, and use git to review. Claude Code is the one to pick when you
want edits gated too.

Set `CLI_PERMISSION_MODE=full` to switch the broker off and let the agent run
genuinely unattended.

## How it talks to the agents

Each adapter drives its CLI's documented headless interface and parses the JSONL/NDJSON
event stream. No terminal output is ever scraped. Events are translated into the internal
vocabulary — `message`, `message_delta`, `tool_use`, `tool_result`, `command_started`,
`command_finished`, `permission_request`, `error`, `session_started`,
`session_cancelled`, `session_finished`, `turn_finished` — so nothing above the
adapter layer knows CLI-specific details.

| Property | Claude Code | Antigravity CLI |
| --- | --- | --- |
| Invocation | `claude -p --input-format stream-json --output-format stream-json` | `agy -p= --input-format stream-json --output-format stream-json --dangerously-skip-permissions` |
| Protocol | NDJSON Stream Events | NDJSON `init`, `step_update` & `result` |
| Process | One long-lived process per session | One long-lived process per session |
| Continuity | Process holds state during session | Process holds state during session; `--conversation <id>` on resume |
| Cancel | `control_request` / `interrupt`, process survives | Cooperative control & signal escalation, process survives |
| Approvals | Interactive approval requests via `control_request` | Auto-approved in unattended mode (`--dangerously-skip-permissions`) |

## Architecture

| Path | Responsibility |
| --- | --- |
| `src/server/config.ts` | Environment parsing; refuses non-loopback binds by default |
| `src/server/workspaces.ts` | The workspace registry and all path containment checks |
| `src/server/auth.ts` | Tailscale identity resolution and authorization |
| `src/server/sessions/` | Session lifecycle, event log, persistence, limits, cleanup |
| `src/server/adapters/` | Claude Code and Antigravity CLI adapters, registry, and environment policy |
| `src/server/ws/` | WebSocket protocol, validation, per-connection subscriptions |
| `src/server/git.ts` | Read-only git status and diff |
| `src/web/` | The mobile client |

Session metadata and a full event log are written under `STATE_DIR` (default
`.data/`), so history survives a restart and a dead session can be resumed.

## Configuration Reference

Every setting is documented in [.env.example](.env.example). Key settings:

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Local loopback host. Must remain loopback for Tailscale security |
| `PORT` | `4823` | Port for the HTTP and WebSocket server |
| `REQUIRE_TAILSCALE_IDENTITY` | `false` | When true, rejects requests without Tailscale headers |
| `ALLOWED_TAILSCALE_USERS` | *(empty)* | Comma-separated tailnet logins allowed to access the console |
| `CLI_ADAPTERS` | `claude-code,antigravity-cli` | Enabled CLI agents offered in the session picker |
| `CLI_DEFAULT_ADAPTER` | `claude-code` | Agent used when none is explicitly specified |
| `CLAUDE_COMMAND` | `claude` | Custom binary name or path for Claude Code |
| `AGY_COMMAND` | `agy` | Custom binary name or path for Antigravity CLI |
| `CLI_PERMISSION_MODE` | `default` | `default`, `acceptEdits`, or `full`. `full` disables approvals entirely |
| `PERMISSION_TIMEOUT_MS` | `900000` (15m) | Auto-denies an unanswered approval |
| `MAX_CONCURRENT_SESSIONS` | `4` | Maximum concurrent active CLI processes |
| `TURN_TIMEOUT_MS` | `1800000` (30m) | Timeout before auto-cancelling a runaway task |
| `SESSION_IDLE_TIMEOUT_MS` | `21600000` (6h) | Reaps forgotten inactive sessions |
| `PUSH_ENABLED` | `true` | Web Push for the installed PWA. `false` disables it entirely |
| `PUSH_NOTIFY_TURN_FINISHED` | `true` | Notify when a turn ends, not only on approvals |
| `PUSH_SUPPRESS_WHEN_VISIBLE` | `true` | Skip a "done" push while the session is on screen |
| `VAPID_SUBJECT` | `mailto:terminal-agent@localhost` | Contact claim sent to the push service |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | *(generated)* | Supply your own keys instead of the generated pair |

## Running as a Background Service

### macOS (launchd)
Edit `deploy/com.terminal-agent.plist` with your node path and repository location, then install:

```bash
cp deploy/com.terminal-agent.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.terminal-agent.plist
```

### Linux (systemd)
```bash
mkdir -p ~/.config/systemd/user/
cp deploy/terminal-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now terminal-agent
```

### Docker
See `Dockerfile.example` and `docker-compose.example.yml`:
```bash
docker compose -f docker-compose.example.yml up -d
```

## Development & Testing

```bash
npm run dev        # Rebuild + restart on change
npm run typecheck  # TypeScript validation
npm test           # Full unit and integration test suite
npm run test:live  # End-to-end test against real CLI (costs tokens)
```

See [docs/TESTING.md](docs/TESTING.md) for test harness details and [docs/SECURITY.md](docs/SECURITY.md) for the security boundary model.
