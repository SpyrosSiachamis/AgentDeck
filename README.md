# terminal-agent

A mobile-first remote development console. It runs on your development machine,
keeps AI coding CLI sessions alive in the background, and is reachable from your
phone over your Tailscale tailnet — never from the public internet.

```
iPhone
  │  HTTPS (tailnet only)
  ▼
Tailscale Serve  ──►  127.0.0.1:4823   (this app)
                            │
                            ▼
                      Session manager
                            │  one long-lived process per session
                            ▼
                  claude -p --input-format stream-json
                            │
                            ▼
                 A registered workspace directory
```

## What it does

- Start and reattach to AI coding sessions from your phone.
- Streaming output, token by token, plus a structured feed of tool calls and
  shell commands.
- Sessions survive the browser closing, the phone sleeping, and the network
  dropping. Reconnecting replays exactly what you missed.
- Cancel a running task without losing the conversation.
- Read-only git status and diffs for the workspace.
- Only directories you explicitly register can ever be touched.

## Requirements

- Node.js 22 or newer (developed on 24).
- The `claude` CLI, already authenticated (`claude auth` or an existing login).
- Tailscale installed and logged in on this machine.

## Setup

```bash
npm install
cp workspaces.example.json workspaces.json   # then edit it
cp .env.example .env                         # optional; defaults are sensible
npm run build
npm start
```

Register the repositories you want reachable in `workspaces.json`:

```json
{
  "workspaces": [
    { "id": "my-app", "name": "My App", "path": "/Users/you/Code/my-app", "enabled": true }
  ]
}
```

`id` is what the browser sends. The absolute `path` never leaves the server, and
the browser has no way to name a directory that is not in this file.

Then publish it to your tailnet:

```bash
npm run serve:tailscale
```

That prints the HTTPS URL to open on your phone. See
[docs/TAILSCALE.md](docs/TAILSCALE.md) for the manual commands, the one-time
tailnet settings it depends on, and how to turn it off again.

Once the Serve URL works, tighten the door behind you:

```bash
REQUIRE_TAILSCALE_IDENTITY=true
ALLOWED_TAILSCALE_USERS=you@example.com
```

## Using it from the phone

Open the HTTPS URL, then **Share → Add to Home Screen** for a full-screen app
without browser chrome.

- **Home** lists your workspaces, the sessions running now, and past sessions.
- Tap a workspace to start a session; tap a session to open it.
- The composer sends instructions. The ■ button cancels the running task while
  keeping the session alive; the ⏹ button in the header stops the session
  entirely.
- The **Git** tab shows the branch, whether the tree is dirty, which files
  changed, and the diff for any of them.
- The pill in the header is the connection state: green online, amber
  reconnecting, red offline.

## How it talks to the CLI

The adapter drives the CLI's documented headless interface and parses its JSONL
event stream. No terminal output is ever scraped:

```
claude -p --input-format stream-json --output-format stream-json --verbose \
       --include-partial-messages --strict-mcp-config --setting-sources ''
```

One process serves the whole session. Instructions are JSON lines on stdin;
cancellation is a `control_request`/`interrupt` frame on the same channel, which
stops the current turn but leaves the conversation intact. The CLI's native
events are translated into an internal vocabulary — `message`, `tool_use`,
`tool_result`, `command_started`, `command_finished`, `error`,
`session_started`, `session_cancelled`, `session_finished` and a few more — so
nothing above the adapter knows which CLI is running.

Adding another provider means writing one file that implements `CLIAdapter`
(`startSession`, `sendInstruction`, `streamEvents`, `cancel`, `getStatus`,
`terminate`) and registering it in `src/server/adapters/registry.ts`.

## Architecture

| Path | Responsibility |
| --- | --- |
| `src/server/config.ts` | Environment parsing; refuses non-loopback binds by default |
| `src/server/workspaces.ts` | The workspace registry and all path containment checks |
| `src/server/auth.ts` | Tailscale identity resolution and authorization |
| `src/server/sessions/` | Session lifecycle, event log, persistence, limits, cleanup |
| `src/server/adapters/` | CLI integrations plus the child-process environment policy |
| `src/server/ws/` | WebSocket protocol, validation, per-connection subscriptions |
| `src/server/git.ts` | Read-only git status and diff |
| `src/web/` | The mobile client |

Session metadata and a full event log are written under `STATE_DIR` (default
`.data/`), so history survives a restart and a dead session can be resumed with
the CLI's own `--resume`.

## Configuration

Every setting and its default is documented in [.env.example](.env.example).
The ones worth knowing:

| Variable | Default | Why you would change it |
| --- | --- | --- |
| `PORT` | `4823` | Must match what `tailscale serve` proxies |
| `REQUIRE_TAILSCALE_IDENTITY` | `false` | Set to `true` once Serve works |
| `ALLOWED_TAILSCALE_USERS` | *(any)* | Restrict to specific tailnet logins |
| `CLI_PERMISSION_MODE` | `acceptEdits` | Headless sessions can't answer prompts |
| `MAX_CONCURRENT_SESSIONS` | `4` | Each session is a full CLI process |
| `TURN_TIMEOUT_MS` | 30 min | Auto-cancels a runaway task |
| `SESSION_IDLE_TIMEOUT_MS` | 6 h | Reaps forgotten sessions |

## Deployment

Run it as a plain process on the host. **Do not containerize the CLI**: it needs
direct access to your real repositories, your git credentials, your toolchain
and your CLI authentication. In a container you would have to bind-mount the
repositories, the git config, the SSH agent and the CLI credential store back
in — which reproduces host access with more moving parts, worse process
management, and a larger surface than running it natively. The isolation that
matters here is the workspace allowlist, not a container boundary. There is
therefore no Dockerfile, deliberately.

To keep it running across logins, install the launchd job:

```bash
cp deploy/com.terminal-agent.plist ~/Library/LaunchAgents/
# edit the paths inside first
launchctl load ~/Library/LaunchAgents/com.terminal-agent.plist
```

`GET /api/health` reports uptime, live session count and the active adapter.
Logs are structured JSON on stdout (`LOG_PRETTY=true` for development).

## Development

```bash
npm run dev        # rebuild + restart on change
npm run typecheck
npm test           # 36 automated tests
npm run test:live  # full lifecycle against the real CLI (costs tokens)
```

See [docs/TESTING.md](docs/TESTING.md) for what is covered and the manual
phone checklist.

## Security

The full model is in [docs/SECURITY.md](docs/SECURITY.md). The short version:
Tailscale is the network boundary, the app binds to loopback only, workspaces
are allowlisted, secrets are stripped from the CLI's environment, and there is
no shell endpoint and no filesystem endpoint. Treat the app as privileged — the
AI it drives can run commands and modify files in whatever you register.

## MVP scope

Implemented: Tailscale-reachable local app, mobile UI, workspace registry,
persistent sessions, streaming, instructions, reconnect, cancellation, git
status/diff, process cleanup, and multiple concurrent sessions across multiple
repositories.

Deliberately not built yet: a file browser, push notifications, session search,
git write operations, and background job scheduling.
