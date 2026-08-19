# Testing

```bash
npm test           # automated tests, no API calls, a few seconds
npm run test:live  # full lifecycle against the real CLI (spends tokens)
```

`npm test` builds first, then runs everything under `tests/`. The coding CLI is
replaced by a fake that speaks its real stream-json protocol (`tests/fake-cli.mjs`)
and can be told to stall, crash, flood, emit malformed lines, or ask for permission. The real
adapters do the parsing, so cancellation, crash handling and approvals are
exercised without spending API calls.

## What is covered

**Workspace security** — `tests/workspace-security.test.mjs`

- Unknown, disabled and path-shaped workspace ids (`../repo`, `/etc`, `repo/../off`,
  non-strings) are all rejected.
- `resolveInside` blocks `../` traversal, absolute paths, `~`, NUL bytes and
  symlinks that point outside the workspace.
- The registry refuses protected directories (`~`, `/etc`, …), relative paths,
  malformed ids and duplicate ids.
- The child environment keeps `PATH`/`HOME`/`ANTIGRAVITY_*`/`AGY_*` and drops API keys,
  cloud credentials, tokens and passwords; explicit opt-in is the only way through.

**Session lifecycle** — `tests/session-lifecycle.test.mjs`

- A turn produces the full translated event vocabulary with strictly increasing,
  unique sequence numbers.
- Cancel interrupts the turn, keeps the *same* process, and accepts a follow-up.
- Terminate kills the process; the test confirms with `process.kill(pid, 0)`.
- A crashing CLI is detected, reported as a fatal error, and refuses further
  instructions.
- A dead session resumes and preserves its CLI conversation id.
- After a simulated server restart, sessions come back as `orphaned` with their
  history replayable from disk, and can be resumed.
- After a restart with stale metadata, the on-disk log wins, so a resumed
  session never reuses a sequence number (this was a real bug, found live).
- The concurrent-session limit is enforced.
- Sessions cannot be created for unregistered or disabled workspaces.
- Oversized output terminates the session; oversized single events are truncated.
- Malformed lines from the CLI are reported without killing the session.
- Streamed text and the final message share a block id, so a reply cannot render
  twice (this was a real bug, caught against the live CLI).

**API and WebSocket** — `tests/api-ws.test.mjs`

- Health and identity endpoints; identity allow list and required-identity mode.
- Workspace listings never contain a filesystem path.
- Unauthorized workspace access over HTTP.
- Git status/diff correctness, plus traversal attempts returning no content from
  outside the workspace.
- Full WS lifecycle: subscribe, instruct, stream, disconnect mid-work, reconnect
  with gap-free replay, cancel.
- Invalid frames (bad JSON, unknown type, unknown session, negative sequence,
  binary) are rejected, and a flood of them closes the socket.
- Oversized frames are rejected without affecting the session.
- WebSocket *handshakes* are authorized like HTTP: anonymous and non-allowlisted
  upgrades are refused outright.
- Instruction length caps.
- The absence of shell and filesystem endpoints.

**Agents and approvals** — `tests/agents-permissions.test.mjs`

- Both agents (Claude Code and Antigravity CLI) are listed with their real capabilities, and a session runs on the
  one that was chosen; sessions on different agents coexist.
- Unknown, malformed and uninstalled agent ids are refused; an empty id means
  "use the default".
- Approvals: granting lets the tool run, denying passes the reason to the model,
  the pending request appears in the session summary, an unanswered request is
  auto-denied, and stale or unknown request ids are rejected.
- Approvals travel over the WebSocket, and a malformed decision is rejected by
  schema validation.

**Client** — `tests/ui.test.mjs`

The built bundle runs in jsdom against recorded server frames:

- Home screen: workspaces, active sessions, history, identity, connection state.
- Streaming deltas reconcile into a single bubble when the final message lands.
- Tool and command events render and later fill in their results; failures are
  marked.
- Replayed events are de-duplicated by sequence number.
- Composer trims and sends; the stop control cancels; empty input sends nothing.
- A dead session shows Reconnect instead of a composer, and calls `/resume`
  without claiming a JSON body.
- State updates never wipe the transcript; server errors surface as a toast.
- The agent picker lists installed agents, skips itself when there is only one
  choice, and refuses to start anything when none is installed.
- An approval renders Approve/Deny with the exact command, sends the decision,
  and shows the outcome — including for a request already answered before a
  reconnect, which must not show stale buttons.
- A shell command renders as one entry, not as both a tool and a command.

## The live end-to-end run

`npm run test:live` requires the server running with a workspace called `demo`
(override with `--workspace <id>`), and drives the exact path a phone takes:

```
health → workspace list → rejected traversal attempts → create session →
subscribe → instruct → streamed output → tool events → turn finishes →
second instruction → phone disconnects mid-work → CLI keeps running →
reconnect → replay only unseen events → cancel → same process answers again →
approve a tool request → deny one and confirm it did not run →
git status/diff → stop → verify the OS reaped the process → resume →
full history replays
```

It also asserts that every streamed reply reconciles with its final block, which
is the live guard against the double-render bug.

## Manual phone checklist

Things a test harness cannot judge:

1. Open the Serve URL on the phone; add it to the home screen.
2. Start a session and send a real instruction; confirm text streams in rather
   than appearing all at once.
3. Lock the phone mid-task for a minute, unlock: the connection pill goes amber
   then green, and the missed output appears.
4. Switch from Wi-Fi to cellular mid-task; same recovery.
5. Tap ■ during a long task: it stops promptly and you can immediately send
   another instruction.
6. Check the Git tab: branch, dirty state, changed files, and a per-file diff
   that scrolls horizontally without the page scrolling.
7. Kill the server (`Ctrl-C`) and restart it: the session appears in History as
   interrupted, opens with its full transcript, and Reconnect brings it back —
   verified live, including the model still remembering the conversation.
8. Confirm the composer does not zoom the viewport when focused, and that the
   keyboard does not cover the send button.
9. Ask for something that needs approval ("run the test suite"): the card should
   appear with the real command, and nothing should run until you tap Approve.
10. Confirm streaming output, tool calls, and cancelling mid-task works cleanly.
