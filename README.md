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
- **Approvals**: When an agent requests a shell command or risky action, an **Approve / Deny** prompt appears with the exact command.
- **Controls**: Send instructions via the composer. Tap ■ to cancel a running task without losing context.
- **Git Inspector**: View branch, modified files, and line-by-line diffs.

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
| `CLI_PERMISSION_MODE` | `default` | `default`, `acceptEdits`, or `full` |
| `PERMISSION_TIMEOUT_MS` | `900000` (15m) | Auto-denies an unanswered approval |
| `MAX_CONCURRENT_SESSIONS` | `4` | Maximum concurrent active CLI processes |
| `TURN_TIMEOUT_MS` | `1800000` (30m) | Timeout before auto-cancelling a runaway task |
| `SESSION_IDLE_TIMEOUT_MS` | `21600000` (6h) | Reaps forgotten inactive sessions |

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
