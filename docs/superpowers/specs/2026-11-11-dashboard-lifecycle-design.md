# Dashboard lifecycle design

Date: 2026-11-11. Status: approved in chat (the user asked for the build described in the conversation); the
calls listed at the end are the author's.

## Intent

The dashboard server is a machine-wide daemon that every orchestrator session starts if it is not running and
nobody stops. Spawned detached on purpose (background Bash dies after two hours, other sessions share it), it
outlives every Claude Code session and is left behind as an orphan. The server should live exactly as long as
someone can see it: a factory session or a browser tab. It must also recover from a stale or missing pidfile
without spawning a second server, and every edit the plugin makes to a Claude settings file must be atomic and
idempotent.

## Goals

1. A Claude Code session that ends tells the server (SessionEnd hook). The server exits on its own once no
   factory session is live and no browser stream is open, after a short grace period.
2. A session that dies without its hook (SIGKILL, crash, power loss) is detected by silence: no event, no
   transcript growth, no live agent for an idle period.
3. `factory-dashboard start|status|stop` reconcile the pidfile with whoever answers `/api/health` on the port:
   adopt an unrecorded factory server, repair a stale pidfile, never spawn a second server, name a foreign
   listener.
4. Settings edits (`<repo>/.claude/settings.local.json`, `<repo>/.mcp.json`, the factory's own JSON config)
   go through one helper that writes atomically (temp file + rename) and is idempotent (a repeat run changes
   nothing and says so).

## Non-goals

- No Claude settings edit for the hook itself: plugin hooks are registered by `hooks/hooks.json`.
  Plugin-provided SessionEnd hooks have a fixed 1.5 s budget that a plugin cannot raise, so the hook stays a
  fast loopback POST and nothing is written to `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`.
- No persistence of the repo registry across server restarts (a separate gap, noted for later).
- No change to what the dashboard shows.

## Anti-goals

- Never exit while a browser stream is open or a session is live.
- Never kill or adopt a process that is not a factory dashboard.
- Never overwrite an existing MCP server entry (it may hold a real token); never log a token.
- Never leave a half-written or reformatted-and-truncated settings file; an invalid file is left untouched.

## Constraints

- Bun ≥ 1.2.10, TypeScript, existing test layout (`bun test` at the root covers `tests/` and `dashboard/test/`).
- Content budgets: `skills/run/SKILL.md` ≤ 16 000 chars, `skills/run/stages/setup.md` ≤ 16 000 chars.
- `bin/factory-event` stays POSIX sh + curl; `bin/*` wrappers are `exec bun …`.
- `tests/plugin/bin.test.ts` pins hook shapes: keep SubagentStart/Stop async with timeout 5, SessionStart sync
  with timeout 3; its SessionStart matcher assertion is updated to the new matcher and a SessionEnd assertion
  (sync, timeout 1) is added.

## Design

### 1. Hook and relay

- `hooks/hooks.json` gains `SessionEnd` (no matcher: every reason) → `"${CLAUDE_PLUGIN_ROOT}/bin/factory-event" session-end`,
  sync, `timeout: 1`. The `SessionStart` matcher becomes `startup|resume|clear|compact`: a resumed session must
  register itself or the server would stop under it.
- `bin/factory-event session-end` posts the usual envelope (`payload` = the hook JSON: `session_id`,
  `transcript_path`, `cwd`, `reason`) and prints nothing. Its curl timeout drops to `-m 1 --connect-timeout 1`
  for every kind: the target is loopback and the SessionEnd budget is 1.5 s.
- Every envelope `factory-event` sends gains two optional top-level fields from the caller's environment:
  `session` = `$CLAUDE_CODE_SESSION_ID` and `pid` = `$CLAUDE_PID` (only when it is all digits). Claude Code sets
  both for the Bash tool, so the orchestrator's own `factory-event stage …` calls name their session; hook
  payloads already carry `session_id`, which the server prefers when present. This is what lets a server
  started from inside a running session learn about that session.
- `factory-dashboard start` registers its cwd with `POST /api/repos` `{ path, session?, pid? }` from the same
  two variables, so the orchestrator's session is known the moment it starts the server.
- Fixture `tests/fixtures/hooks/session-end.json`.

### 2. Session tracker (`dashboard/src/sessions.ts`)

`SessionTracker` keeps `sessions: Map<sessionId, { repoKey, transcriptPath?, pid?, lastSeen }>`, a `streams`
count, `lastActivity` (initialised at construction) and `lastEnd` (unset until the first session end).

- `seen(id, repoKey, { transcriptPath?, pid? })` upserts (a fact reported later replaces the known one) and bumps
  `lastSeen`; `end(id)` deletes, sets `lastEnd`, returns whether it was known; both and `activity()` set
  `lastActivity = now`.
- `streamOpened()` / `streamClosed()` keep `streams` and count as activity.
- `live(sessionIdleMs)`: a session with a `pid` is live iff that process exists (`process.kill(pid, 0)`; EPERM
  counts as alive); one without is live when `lastSeen` is within `sessionIdleMs`, or its transcript file (under
  `~/.claude/projects` only) was modified within it, or it owns a live agent in the agent registry.
- `reap()` removes every session whose `pid` is gone and sets `lastEnd` when it removed one: a crashed Claude
  is noticed at the next check, not after the idle period. The idle rule remains for sessions without a pid.
- `exitReason({ graceMs, sessionIdleMs })` returns `null` when `streams > 0` or `live(sessionIdleMs)` is non-empty;
  otherwise `"no factory session or browser for <grace>s"` when `lastEnd` is set and `now − lastActivity ≥ graceMs`;
  otherwise `"idle for <idle>"` when `now − lastActivity ≥ sessionIdleMs`; else `null`. The grace path needs a
  transition the server saw (a `session-end`, or a reaped pid); an unknown session id still sets `lastEnd`
  (nothing known is using the server). A server started by hand from a plain shell, with no session and no
  browser, lives until the idle period or until some session end arrives.

### 3. Wiring

- Events route: the session id of an event is `payload.session_id`, else the envelope's `session`; the pid is
  the envelope's `pid`. Every accepted event with a session id → `tracker.seen(id, repoKey, { transcriptPath?,
  pid? })` (`transcript_path` only under `~/.claude/projects`, the existing guard); `session-end` → stop that
  session's live agents (they cannot outlive it) then `tracker.end`; every accepted event → `tracker.activity()`.
  `POST /api/repos` `{ path, session?, pid? }` registers the session the same way after the repo.
- Stream route gets `onOpen` / `onClose` callbacks (close fires once per stream) → `streamOpened` / `streamClosed`.
  Only repo streams exist (`/api/stream?repo=`); the web app opens one as soon as a repo is selected, which it
  does automatically when any repo is registered. A tab with no repo at all holds no stream and does not keep
  the server alive.
- `createApp` takes `config.graceMs`, `config.sessionIdleMs`, `config.autoExit` and `opts.onExit?(reason)`; the
  periodic `sweep` (default lowered from 60 s to 15 s; it still stops idle agents after the existing `IDLE_MS`)
  also calls `checkExit()` = `tracker.reap()` then `exitReason`; when `autoExit` and a reason exists,
  `onExit(reason)` runs once. `App` exposes `sessions` and `checkExit()` for tests.
- `GET /api/health` adds `sessions` (count), `streams` (count) and `autoExit` (boolean).
- `server.ts` passes `onExit`: log `factory-dashboard: exiting (<reason>)`, `app.stop()`, `server.stop(true)`,
  delete `<configDir>/dashboard.pid` if it holds this process's pid, `process.exit(0)`.
- Config: `FACTORY_GRACE_MS` (default 60 000), `FACTORY_SESSION_IDLE_MS` (default 7 200 000),
  `FACTORY_AUTO_EXIT=0` disables self-exit (`autoExit` true otherwise). The existing `IDLE_MS` export for idle
  agents is untouched.

### 4. Daemon reconciliation (`dashboard/src/daemon.ts`)

- `probe()` → `{ ok: false } | { ok: true, pid: number | null }` from `/api/health` (1 s timeout; `pid` null when
  absent or not an integer). A listener is "ours" when `ok`, `pid` is an integer and `isOurServer(pid)`.
- `status`: ours → `{ running: true, port, pid, url }`, rewriting a pidfile that names another pid
  (`repaired: true`); `ok` but not ours → `{ running: false, port, foreign: true }`; else `{ running: false, port }`
  and a dead pidfile is removed.
- `start`: ours → register cwd, repair the pidfile if needed, print running (`adopted: true` when the pidfile
  did not name it), exit 0; foreign → `{ running: false, error: "port <port> is in use by another program" }`,
  exit 1, nothing spawned; otherwise the existing path (wait out a live-but-unhealthy pid of ours, then
  spawn), and the start-up wait requires `probe().pid === proc.pid`; a process that exits during the wait
  reports `dashboard exited during startup` with the log tail (the port-clash case lands here).
- `stop`: ours (by probe) → terminate that pid; else the pidfile path as today. The pidfile is removed either way.

### 5. Atomic, idempotent settings edits

- `lib/atomic.ts`: `writeFileAtomic(path, text, { mode })` writes `<dir>/.<base>.<pid>.<random>.tmp`, fsyncs,
  sets the mode (the existing file's mode when there is one, else the given default), renames over `path`,
  removes the temp file on any failure. `lib/config.ts`'s `writeJson` uses it, so `factory-config set` and
  `migrate-trilium` become atomic too.
- `lib/settings.ts` + `lib/cli/settings.ts` + `bin/factory-settings`:
  - `factory-settings env <file> KEY=VALUE [KEY=VALUE…]` ensures `env.KEY = VALUE`; prints `written`,
    `unchanged` (every key already equal; the file is not touched) or `invalid` (exit 1: the file exists and is
    not a JSON object, or its `env` is not an object). Other keys and key order are preserved; a missing file
    or directory is created (mode 0644).
  - `factory-settings mcp <file> <name> <url>` adds `mcpServers.<name>` = `{ type: "http", url: <base>/mcp,
    headers: { Authorization: "Bearer your-etapi-token" } }` with the URL normalised as setup does today
    (trim, strip trailing slashes and a `/etapi` or `/mcp` suffix); prints `written` (file mode 0600),
    `exists` (exit 1: any entry of that name, never overwritten) or `invalid` (exit 1).
  - Output is one word; never file content.
- `skills/run/stages/setup.md` calls these two commands instead of its inline `bun -e` scripts; the stage's
  `written` / `invalid` / `exists` handling stays as written. A content test pins "no `bun -e` in setup.md".

### 6. Documentation

- README Dashboard section: the lifecycle (ends a minute after the last factory session unless a browser tab
  is open; idle fallback; `FACTORY_GRACE_MS`, `FACTORY_SESSION_IDLE_MS`, `FACTORY_AUTO_EXIT=0`), pidfile
  reconciliation, `factory-settings`.
- `dashboard/scripts/verify.md`: a lifecycle walk (start with `FACTORY_GRACE_MS=5000`, post `session-start`
  then `session-end` with `send-event.sh`, `status` reports stopped within half a minute, pidfile gone; with a
  browser tab open it stays).
- `skills/run/SKILL.md` Dashboard section: one line on the self-stop so the orchestrator can tell the user.

## Left to the builder

Exact test fixtures and temp-file naming, the health JSON beyond the named fields, how the tracker learns the
registry's live agents (a callback is fine), the log line wording.

## Calls made by the author (flag if wrong)

- Grace 60 s, session idle 2 h, exit check every 15 s; `FACTORY_AUTO_EXIT=0` as the opt-out.
- Session identity comes from `CLAUDE_CODE_SESSION_ID` / `CLAUDE_PID` in the Bash environment (observed in
  Claude Code 2.1.319; hooks carry `session_id` anyway). Absent variables degrade to the idle rule.
- A session with a known pid is live exactly while that process exists; a shared Claude process hosting
  several sessions still ends each one through its SessionEnd hook.
- Only repo streams count as "a browser is open".
- `resume` added to the SessionStart matcher.
- curl capped at 1 s for every `factory-event` kind, not only `session-end`.
- A `session-end` stops the live agents of that session.
- A foreign listener on the port is an error, never killed.
- A non-object `env` in settings.local.json is `invalid` rather than replaced.
- First write through `factory-settings` reformats the file to two-space JSON (as the inline scripts did).
- The repo registry still forgets repos on restart; out of scope here.
