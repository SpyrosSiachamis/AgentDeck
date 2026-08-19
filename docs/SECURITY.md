# Security model

This application is **highly privileged by design**. It drives an AI coding CLI
that can read files, write files and execute shell commands inside the
directories you register. Anyone who can reach it can do anything the AI can do.
Every control below exists to keep that reach small and well defined.

## Trust boundaries

```
public internet ──✗── (no route: no Funnel, no port forwarding, no public IP)

tailnet device ──► tailscaled ──► Tailscale Serve ──► 127.0.0.1:4823 ──► app
                                  (TLS terminates here,               (this code)
                                   identity headers added)
```

1. **Network boundary — Tailscale.** The tailnet decides who can reach the
   machine at all. Nothing here duplicates that with a homegrown login page.
2. **Process boundary — loopback.** The server binds `127.0.0.1`. It is not on
   the LAN interface and cannot be reached from another machine except through
   the Serve proxy.
3. **Authorization boundary — this app.** Identity checks, the workspace
   allowlist, input validation and resource limits.
4. **Blast-radius boundary — the workspace registry.** The AI process is started
   with its working directory set to a registered path and nothing else.

## Why the identity headers can be trusted

`tailscale serve` adds `Tailscale-User-Login`, `Tailscale-User-Name` and
`Tailscale-User-Profile-Pic` to every proxied request, after authenticating the
tailnet peer. Those headers are only meaningful if a client cannot set them
itself, which holds precisely when the only path to the socket is the local
proxy. The code enforces both halves:

- `src/server/auth.ts` ignores the headers unless the peer address is loopback
  **and** the configured bind host is loopback.
- `src/server/config.ts` refuses to start on a non-loopback host unless
  `ALLOW_NON_LOOPBACK_BIND=true` is set explicitly, and logs a warning about
  spoofable identity when it is.
- `trustProxy` is `false`, so `X-Forwarded-For` is never believed.

With `REQUIRE_TAILSCALE_IDENTITY=true`, a request with no identity header is
refused — which also blocks another local user on the machine from using
`http://127.0.0.1:4823` directly. `ALLOWED_TAILSCALE_USERS` narrows it further
to named logins.

**Residual risk:** any process running as your user on this machine can reach
the loopback port and forge headers. This is a single-user personal development
tool; if that is not your situation, the honest fix is OS-level isolation, not
another header check.

## Workspace allowlisting

The server never accepts a filesystem path from the browser. Clients send a
workspace **id**; `WorkspaceRegistry.require()` maps it to a path or throws.

At load time, each registered entry is:

- required to be absolute (`~` is expanded),
- resolved through `realpath`, collapsing `..` and symlinks,
- verified to exist and be a directory (missing paths are auto-disabled),
- rejected if it is a protected location — `/`, your home directory itself,
  `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config`, `~/.claude`, `~/.gemini`, `~/.antigravity`,
  `~/.agy`, `~/Library`, `/etc`, `/var`, `/usr`, `/bin`, `/sbin`, `/System`.

Ids are constrained to `^[a-z0-9][a-z0-9_-]{0,63}$`, so a path-shaped id
(`../other`, `/etc`) can never match an entry. Disabled workspaces resolve but
refuse to start sessions. The absolute path is stripped from every API response;
the browser only ever sees id, name, enabled and whether it is a git repository.

For the one place a file path is legitimately needed — a per-file git diff —
`resolveInside()` rejects absolute paths, `~`, NUL bytes, anything resolving
outside the workspace root, and symlinks pointing outside it. The result is
passed to `git` after a `--` separator, in an argv array, with no shell.

## The AI process environment

The server may be launched from a shell full of credentials. The child process
gets an allowlisted environment instead (`src/server/adapters/env.ts`):

- **Forwarded:** `PATH`, `HOME`, `USER`, `SHELL`, locale, `TMPDIR`, XDG dirs,
  proxy and CA settings, plus `ANTIGRAVITY_*`, `AGY_*`, `GEMINI_*`,
  `GOOGLE_*` and `GCLOUD_*` configuration. `GOOGLE_CLOUD_PROJECT` is forwarded
  because Workspace accounts may require it.
- **Never forwarded:** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
  `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`,
  `GOOGLE_CLIENT_SECRET`, and anything matching
  `SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|SESSION_TOKEN`.
- **Not forwarded by default:** everything else, including your application env
  vars and cloud credentials.

The CLI authenticates through its own credential stores under `$HOME`, so
stripping the API keys does not break it. If you genuinely need a variable inside sessions,
opt in explicitly with `CLI_FORWARD_ENV=NAME1,NAME2` — and understand that the
AI can read it, including through its Bash tool.

Sessions also run with `--strict-mcp-config --setting-sources ''`, so they do not
inherit your personal MCP servers or per-project settings, which commonly carry
tokens.

## What the API deliberately does not have

- No shell/exec endpoint. The only way to run a command is to ask the AI, inside
  a registered workspace, which is recorded as `command_started` /
  `command_finished` events in the session log.
- No filesystem read/write endpoint, and no file browser.
- No endpoint that accepts a path as a working directory.
- No git write operations. `git.ts` runs `status`, `diff`, `ls-files` only.
- No way to choose an agent binary from the browser: the client sends an agent
  **id**, which is resolved against the enabled, installed set server-side.
- No way to enumerate or read environment variables.

A test (`tests/api-ws.test.mjs`) asserts these endpoints stay absent.

## Resource limits and abuse control

| Control | Default | Enforced in |
| --- | --- | --- |
| Concurrent sessions | 4 | `SessionManager.create` |
| Queued instructions per session | 5 | `Session.instruct` |
| Instruction length | 32 000 chars | HTTP route + WS handler |
| Single event text | 20 000 chars, then truncated | adapter |
| Total session output | 64 MB, then the session is killed | adapter |
| Events kept in memory | 1 500 (full log stays on disk) | `Session.record` |
| WebSocket frame | 256 KB | `@fastify/websocket` `maxPayload` |
| Turn duration | 30 min, then auto-cancel | manager sweep |
| Idle session | 6 h, then terminated | manager sweep |
| Dead session retention | 24 h, then evicted and deleted | manager sweep |
| Invalid WS messages | 10, then the socket is closed | `ws/hub.ts` |
| Unanswered tool approval | 15 min, then denied | `Session.armPermissionTimeout` |

Every inbound WebSocket frame is validated against a zod schema before it can
touch session state; unknown types, malformed JSON and binary frames are
rejected without side effects.

## Process lifecycle

Sessions are spawned in their own process group (`detached`), so termination
reaps whatever the CLI itself started. Shutdown escalates: close stdin → wait →
`SIGTERM` to the group → wait → `SIGKILL`. Cancellation is gentler: an
`interrupt` control frame ends the turn but keeps the process, escalating to
termination only if the CLI does not respond within `CANCEL_GRACE_MS`.

Crashes are detected from a non-zero exit and reported as a fatal `error` event
plus `session_finished`; the transcript is preserved and the session can be
resumed into a fresh process with the CLI's `--resume`.

`SIGINT`/`SIGTERM` to the server terminates live sessions, flushes event logs and
persists metadata before exiting, with a hard-exit backstop if that stalls.

## Data at rest

`STATE_DIR` (default `.data/`) holds session metadata and the full event log,
created with mode `0700`/`0600`. **The event log contains everything the AI read
and wrote, including file contents and command output.** It is as sensitive as
the repositories themselves. It is not encrypted; keep it on an encrypted disk
and keep it out of version control (`.gitignore` covers `.data/` and
`workspaces.json`).

## Browser-side hardening

Responses carry a strict CSP (`default-src 'none'`, no external origins),
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and
`X-Frame-Options: DENY`. The client uses no CDN, no external fonts and no
analytics. All rendering uses `textContent`, never `innerHTML`, so CLI output
cannot inject markup. 5xx responses return a generic message; details stay in
the server log.

## Approving tool use

`CLI_PERMISSION_MODE` decides what an agent may do without asking:

| Level | Behaviour |
| --- | --- |
| `default` | Asks before anything risky. You approve or deny it from the phone. |
| `acceptEdits` | Edits confined to the workspace proceed silently (`acceptEdits` / `--mode accept-edits`). |
| `full` | Never asks (`bypassPermissions` on Claude, `--dangerously-skip-permissions` on Antigravity). |

With Claude Code and Antigravity CLI the request travels over the CLI's control channel and the turn
**blocks** until it is answered, so:

- Only a request the CLI actually raised can be answered; ids are validated
  against the session's pending set, and answering twice is refused.
- An unanswered request is auto-denied after `PERMISSION_TIMEOUT_MS`
  (15 minutes), so a forgotten session cannot pin a blocked process forever.
- Cancelling, stopping, or losing the process abandons every pending request
  rather than leaving the CLI waiting.
- The decision, who made it, and any reason given are written to the session
  log, so the transcript shows what was authorised and by whom.

## Operating checklist

- [ ] `workspaces.json` lists only repositories you would let an AI modify.
- [ ] The server binds `127.0.0.1` (check the startup log line).
- [ ] `tailscale serve status` shows the proxy; Funnel is **off**.
- [ ] `REQUIRE_TAILSCALE_IDENTITY=true` once Serve works.
- [ ] `ALLOWED_TAILSCALE_USERS` set if others share your tailnet.
- [ ] Tailnet ACLs restrict which devices may reach this machine's port 443.
- [ ] `.data/` lives on an encrypted disk.
- [ ] Repositories with production credentials in `.env` files are **not**
      registered — the AI can read them.
