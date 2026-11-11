# Dashboard Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The dashboard server stops itself once no factory session is live and no browser tab is open, the daemon never spawns a second server, and every settings-file edit the plugin makes is atomic and idempotent.

**Architecture:** A `SessionEnd` plugin hook and a session id on every `factory-event` envelope let a `SessionTracker` in the server know which Claude sessions use it; the periodic sweep asks it for an exit reason and the server exits. The daemon reconciles its pidfile with whoever answers `/api/health`. A `factory-settings` command (temp file + rename) replaces the inline `bun -e` writes of the setup stage.

**Tech Stack:** Bun ≥ 1.2.10, TypeScript, POSIX sh + curl for `bin/factory-event`, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-11-dashboard-lifecycle-design.md`

## Global Constraints

- Plugin-provided SessionEnd hooks have a fixed 1.5 s budget: `factory-event` stays POSIX sh + curl with `-m 1 --connect-timeout 1`, no bun.
- Hook shapes pinned by `tests/plugin/bin.test.ts`: SubagentStart/Stop async with timeout 5; SessionStart sync with timeout 3, matcher `startup|resume|clear|compact`; SessionEnd sync with timeout 1, no matcher.
- Session identity: `payload.session_id` first, else the envelope's top-level `session` (from `$CLAUDE_CODE_SESSION_ID`); pid from the envelope's top-level `pid` (from `$CLAUDE_PID`, only when all digits).
- Exit policy: `FACTORY_GRACE_MS` default 60 000, `FACTORY_SESSION_IDLE_MS` default 7 200 000, `FACTORY_AUTO_EXIT=0` disables; exit check every 15 s (the sweep); reasons `no factory session or browser for 60s` and `idle for 120min`.
- Never exit while `streams > 0` or a session is live; never kill or adopt a non-factory listener; never overwrite an existing `mcpServers.<name>`; never log a token; an invalid settings file is left byte-identical.
- `factory-settings` prints exactly one word (`written` | `unchanged` | `invalid` | `exists`); exit 0 for `written`/`unchanged`, 1 for `invalid`/`exists`, 2 for usage.
- Atomic write: temp file `<dir>/.<base>.<pid>.<random>.tmp`, fsync, mode = existing file's mode else the default, `renameSync` over the target, temp removed on failure.
- Content budgets: `skills/run/SKILL.md` ≤ 16 000 chars, `skills/run/stages/setup.md` ≤ 16 000 chars.
- The existing `IDLE_MS` export (idle agents, 30 min) keeps its name and value.

## Review Focus

1. A `session-end` for a session the server never saw while a known session with a live pid is working: the server must not exit (Task 3 test "unknown session's end").
2. A foreign program answering `/api/health` on the port (no `pid`): `start` must refuse without spawning (Task 4 test "foreign listener").
3. `factory-settings env` on a file that is not valid JSON: `invalid`, bytes untouched, no temp file left (Task 5 test "invalid JSON").
4. A stream whose abort and cancel both fire: `streams` goes down exactly once and never below zero (Task 2 test "streamClosed floor", Task 3 test "stream keeps the server alive").
5. `CLAUDE_PID` set to something non-numeric: no `pid` field in the envelope (Task 1 test "pid only when digits").

---

### Task 1: SessionEnd hook and session fields on the event envelope

**Files:**
- Modify: `hooks/hooks.json`
- Modify: `bin/factory-event`
- Create: `tests/fixtures/hooks/session-end.json`
- Modify: `tests/bin/factory-event.test.ts`
- Modify: `tests/plugin/bin.test.ts:46-54`

**Interfaces:**
- Consumes: nothing new.
- Produces: the envelope `{"event","ts","project",["stage","status","task","workstream",]["session",]["pid",]"payload"}`; `session` is a JSON string, `pid` a JSON number; both only when the variable is set (`pid` only when `$CLAUDE_PID` matches `^[0-9]+$`). Hook event names `session-end`.

- [ ] **Step 1: Write the failing tests**

In `tests/bin/factory-event.test.ts` add inside the describe:

```ts
test("session-end posts the hook JSON as payload and prints nothing", async () => {
  writeFileSync(join(repo, ".factory/config.json"), "{}");
  const r = await run(["session-end"], readFileSync("tests/fixtures/hooks/session-end.json", "utf8"));
  expect(r.code).toBe(0); expect(r.out).toBe("");
  const body = JSON.parse(readFileSync(join(dir, "curl.body"), "utf8"));
  expect(body.event).toBe("session-end"); expect(body.payload.session_id).toBe("s1"); expect(body.payload.reason).toBe("other");
});
test("session and pid come from CLAUDE_CODE_SESSION_ID and CLAUDE_PID; pid only when digits", async () => {
  writeFileSync(join(repo, ".factory/config.json"), "{}");
  await run(["stage", "--stage", "setup", "--status", "started"], "", { CLAUDE_CODE_SESSION_ID: "abc-1", CLAUDE_PID: "4242" });
  let body = JSON.parse(readFileSync(join(dir, "curl.body"), "utf8"));
  expect(body.session).toBe("abc-1"); expect(body.pid).toBe(4242);
  await run(["stage", "--stage", "setup", "--status", "started"], "", { CLAUDE_CODE_SESSION_ID: "", CLAUDE_PID: "nope" });
  body = JSON.parse(readFileSync(join(dir, "curl.body"), "utf8"));
  expect("session" in body).toBe(false); expect("pid" in body).toBe(false);
});
test("curl is capped at one second", async () => {
  writeFileSync(join(repo, ".factory/config.json"), "{}");
  await run(["subagent-stop"], "{}");
  const args = readFileSync(join(dir, "curl.args"), "utf8").split("\n");
  expect(args[args.indexOf("-m") + 1]).toBe("1");
  expect(args[args.indexOf("--connect-timeout") + 1]).toBe("1");
});
```

The `run` helper already merges `extraEnv` over `process.env`; a test that sets `CLAUDE_CODE_SESSION_ID: ""` relies on the script treating an empty value as unset. Create `tests/fixtures/hooks/session-end.json`:

```json
{"session_id":"s1","transcript_path":"/tmp/x/s1.jsonl","cwd":"/tmp/x","hook_event_name":"SessionEnd","reason":"other"}
```

In `tests/plugin/bin.test.ts` change the SessionStart matcher expectation to `"startup|resume|clear|compact"` and add:

```ts
test("SessionEnd is sync with timeout 1 and no matcher", () => {
  const e = entries("SessionEnd");
  expect(e.length).toBe(1);
  expect("matcher" in hooks.SessionEnd[0]).toBe(false);
  expect(e[0].timeout).toBe(1);
  expect("async" in e[0]).toBe(false);
  expect(e[0].command.endsWith(" session-end")).toBe(true);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test tests/bin/factory-event.test.ts tests/plugin/bin.test.ts`
Expected: the four new/changed tests fail (no `session`/`pid` fields, `-m` is `2`, no SessionEnd entry, old matcher).

- [ ] **Step 3: Implement**

`hooks/hooks.json`: SessionStart matcher `startup|resume|clear|compact`; add `SessionEnd` with one group (no `matcher`) whose hook is `{"type":"command","command":"\"${CLAUDE_PLUGIN_ROOT}/bin/factory-event\" session-end","timeout":1}`.

`bin/factory-event`: curl `-m 1 --connect-timeout 1`; in `build_body`, after the `workstream` field, emit `,"session":"<escaped $CLAUDE_CODE_SESSION_ID>"` when that variable is non-empty and `,"pid":<n>` when `$CLAUDE_PID` matches `^[0-9]+$` (use `case "$CLAUDE_PID" in ''|*[!0-9]*) ;; *) … esac`). `session-end` needs no special case: it posts like every other kind and prints nothing.

- [ ] **Step 4: Run the tests**

Run: `bun test tests/bin tests/plugin`
Expected: PASS, including the existing `trailing flag without value` and `session-start prints context line` tests.

- [ ] **Step 5: Commit**

```bash
git add hooks/hooks.json bin/factory-event tests/fixtures/hooks/session-end.json tests/bin/factory-event.test.ts tests/plugin/bin.test.ts
git commit -m "feat(hooks): SessionEnd relays session-end; envelopes carry session and pid"
```

---

### Task 2: SessionTracker

**Files:**
- Create: `dashboard/src/sessions.ts`
- Test: `dashboard/test/sessions.test.ts`

**Interfaces:**
- Produces (all in `dashboard/src/sessions.ts`):

```ts
export interface SessionFacts { transcriptPath?: string; pid?: number }
export interface SessionInfo extends SessionFacts { id: string; repoKey: string; lastSeen: number }
export interface TrackerDeps {
  now?: () => number;                        // default Date.now
  mtime?: (path: string) => number | null;   // default statSync(path).mtimeMs, null when missing
  processAlive?: (pid: number) => boolean;   // default process.kill(pid, 0): true; EPERM → true; else false
  liveSessionIds?: () => Set<string>;        // default () => new Set()
}
export interface ExitPolicy { graceMs: number; sessionIdleMs: number }
export class SessionTracker {
  streams: number;                            // starts at 0
  constructor(deps?: TrackerDeps);
  seen(id: string, repoKey: string, facts?: SessionFacts): SessionInfo;  // upsert; new facts fill in, known facts kept; lastSeen = now; activity
  end(id: string): boolean;                   // delete; lastEnd = now; activity; true when it was known
  activity(): void;                           // lastActivity = now
  streamOpened(): void;                       // streams++; activity
  streamClosed(): void;                       // streams = max(0, streams - 1); activity
  list(): SessionInfo[];
  get count(): number;
  live(sessionIdleMs: number): SessionInfo[];
  reap(): string[];                           // removes sessions whose pid is gone; when any, lastEnd = lastActivity = now
  exitReason(policy: ExitPolicy): string | null;
}
```

`live`: a session with `pid` is live iff `processAlive(pid)`; one without is live when `now − lastSeen < sessionIdleMs`, or `mtime(transcriptPath)` is within `sessionIdleMs`, or `liveSessionIds()` has its id. `exitReason`: `null` when `streams > 0` or `live(sessionIdleMs)` is non-empty; else `` `no factory session or browser for ${Math.round(graceMs / 1000)}s` `` when `lastEnd !== undefined && now − lastActivity ≥ graceMs`; else `` `idle for ${Math.round(sessionIdleMs / 60000)}min` `` when `now − lastActivity ≥ sessionIdleMs`; else `null`. `lastActivity` starts at construction; `lastEnd` starts undefined.

- [ ] **Step 1: Write the failing tests** in `dashboard/test/sessions.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { SessionTracker } from "../src/sessions";

const POLICY = { graceMs: 60_000, sessionIdleMs: 7_200_000 };
function make(opts: { alive?: Set<number>; mtimes?: Record<string, number>; liveIds?: Set<string> } = {}) {
  let t = 1_000_000;
  const tracker = new SessionTracker({
    now: () => t,
    processAlive: (pid) => opts.alive?.has(pid) ?? false,
    mtime: (p) => opts.mtimes?.[p] ?? null,
    liveSessionIds: () => opts.liveIds ?? new Set(),
  });
  return { tracker, tick: (ms: number) => { t += ms; } };
}

describe("SessionTracker", () => {
  test("seen upserts, keeps known facts, bumps lastSeen", () => {
    const { tracker, tick } = make({ alive: new Set([7]) });
    tracker.seen("s1", "/r", { pid: 7 });
    tick(5_000);
    const s = tracker.seen("s1", "/r", { transcriptPath: "/t/s1.jsonl" });
    expect(tracker.count).toBe(1);
    expect(s).toMatchObject({ id: "s1", repoKey: "/r", pid: 7, transcriptPath: "/t/s1.jsonl", lastSeen: 1_005_000 });
  });
  test("end: true for a known session, false for an unknown one; both arm the grace path", () => {
    const { tracker, tick } = make();
    tracker.seen("s1", "/r");
    expect(tracker.end("s1")).toBe(true);
    expect(tracker.end("zzz")).toBe(false);
    tick(59_999); expect(tracker.exitReason(POLICY)).toBeNull();
    tick(1); expect(tracker.exitReason(POLICY)).toBe("no factory session or browser for 60s");
  });
  test("a fresh tracker only exits through the idle path", () => {
    const { tracker, tick } = make();
    tick(7_199_999); expect(tracker.exitReason(POLICY)).toBeNull();
    tick(1); expect(tracker.exitReason(POLICY)).toBe("idle for 120min");
  });
  test("an unknown session's end never stops a live known session", () => {
    const { tracker, tick } = make({ alive: new Set([42]) });
    tracker.seen("s1", "/r", { pid: 42 });
    tracker.end("other");
    tick(7_200_000);
    expect(tracker.exitReason(POLICY)).toBeNull();
  });
  test("reap removes sessions whose process is gone and arms the grace path", () => {
    const alive = new Set([42]);
    const { tracker, tick } = make({ alive });
    tracker.seen("s1", "/r", { pid: 42 });
    expect(tracker.reap()).toEqual([]);
    alive.delete(42);
    expect(tracker.reap()).toEqual(["s1"]);
    expect(tracker.count).toBe(0);
    tick(60_000);
    expect(tracker.exitReason(POLICY)).toBe("no factory session or browser for 60s");
  });
  test("live: pid decides when known; otherwise lastSeen, transcript mtime or a live agent", () => {
    const { tracker, tick } = make({ alive: new Set([1]), mtimes: { "/t/s3.jsonl": 1_000_000 + 7_000_000 }, liveIds: new Set(["s4"]) });
    tracker.seen("s1", "/r", { pid: 1 });
    tracker.seen("s2", "/r", { pid: 2 });
    tracker.seen("s3", "/r", { transcriptPath: "/t/s3.jsonl" });
    tracker.seen("s4", "/r");
    tracker.seen("s5", "/r");
    tick(7_100_000); // s5 seen 7 100 s ago (< idle); s3's transcript grew 100 s ago
    expect(tracker.live(POLICY.sessionIdleMs).map((s) => s.id).sort()).toEqual(["s1", "s3", "s4", "s5"]);
    tick(7_100_000); // now both s5's lastSeen and s3's transcript are older than the idle period
    expect(tracker.live(POLICY.sessionIdleMs).map((s) => s.id).sort()).toEqual(["s1", "s4"]);
  });
  test("a stream keeps the server alive; streamClosed floors at zero", () => {
    const { tracker, tick } = make();
    tracker.streamClosed();
    expect(tracker.streams).toBe(0);
    tracker.seen("s1", "/r"); tracker.end("s1");
    tracker.streamOpened();
    tick(10_000_000);
    expect(tracker.exitReason(POLICY)).toBeNull();
    tracker.streamClosed();
    tick(59_000); expect(tracker.exitReason(POLICY)).toBeNull();
    tick(1_000); expect(tracker.exitReason(POLICY)).toBe("no factory session or browser for 60s");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test dashboard/test/sessions.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `dashboard/src/sessions.ts`** with the interface above. Default `processAlive`: `try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM" }`. Default `mtime`: `statSync(path).mtimeMs`, `null` on any error.

- [ ] **Step 4: Run the tests**

Run: `bun test dashboard/test/sessions.test.ts`
Expected: 7 pass.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/sessions.ts dashboard/test/sessions.test.ts
git commit -m "feat(dashboard): SessionTracker decides when the server may exit"
```

---

### Task 3: Wire sessions, streams and self-exit into the server

**Files:**
- Modify: `dashboard/src/shared/types.ts:21` (`HookEvent`)
- Modify: `dashboard/src/config.ts`
- Modify: `dashboard/src/routes/events.ts`
- Modify: `dashboard/src/routes/stream.ts`
- Modify: `dashboard/src/routes/api.ts` (`Ctx`, `addRepoRoute`, `health`, `stream`)
- Modify: `dashboard/src/app.ts`
- Modify: `dashboard/src/server.ts`
- Test: `dashboard/test/config.test.ts`, `dashboard/test/integration/server.test.ts`

**Interfaces:**
- Consumes: `SessionTracker` (Task 2); envelope fields `session`, `pid` (Task 1).
- Produces:
  - `HookEvent` gains `session?: string; pid?: number`.
  - `DashboardConfig` gains `graceMs: number; sessionIdleMs: number; autoExit: boolean` (env `FACTORY_GRACE_MS`, `FACTORY_SESSION_IDLE_MS` through the existing `num` helper with defaults 60000 / 7200000; `autoExit = env.FACTORY_AUTO_EXIT !== "0"`).
  - `createApp(deps, opts)` accepts `opts.onExit?: (reason: string) => void`; `opts.sweepMs` default becomes 15 000.
  - `App` gains `sessions: SessionTracker` and `checkExit(): string | null` (= `sessions.reap()` then `sessions.exitReason({ graceMs, sessionIdleMs })`); `sweep()` calls `checkExit()` and, when `config.autoExit` and a reason exists, calls `onExit(reason)` once (a flag stops repeats).
  - `EventDeps` gains `sessions?: SessionTracker`. `handleEvent`: `sessionId = str(payload.session_id) ?? str(b.session)`; `pid = Number.isInteger(b.pid) && b.pid > 0 ? b.pid : undefined`; after the repo is resolved, when `sessionId` → `deps.sessions?.seen(sessionId, repoKey, { transcriptPath: underProjects(deps.homeDir, str(payload.transcript_path)), pid })`; always `deps.sessions?.activity()`. New case `"session-end"`: stop every live agent of `repoKey` whose `sessionId === sessionId` via `stopAgent`, then `deps.sessions?.end(sessionId)` (when known), then `deps.refresh(repoKey)`, 204.
  - `StreamDeps` gains `onOpen?: () => void; onClose?: () => void`; `onOpen` runs in `start` before the first frame, `onClose` inside `cleanup` (which already runs once).
  - `POST /api/repos` body `{ path: string; session?: string; pid?: number }`: after a successful `addRepo`, `ctx.sessions.seen(session, entry.repoPath, { pid })` when `session` is a non-empty string.
  - `GET /api/health` adds `sessions: ctx.sessions.count`, `streams: ctx.sessions.streams`, `autoExit: deps.config.autoExit`.
  - `server.ts` passes `onExit`: `console.log(\`factory-dashboard: exiting (${reason})\`)`, `app.stop()`, `server.stop(true)`, remove `join(config.configDir, "dashboard.pid")` when its trimmed content equals `String(process.pid)`, `process.exit(0)`.

The tracker is built in `createApp` as `new SessionTracker({ now, liveSessionIds: () => new Set(deps.registry.list().live.map((a) => a.sessionId).filter((s): s is string => !!s)) })`.

- [ ] **Step 1: Write the failing config tests** in `dashboard/test/config.test.ts`

Update every `toEqual` literal to include `graceMs: 60000, sessionIdleMs: 7200000, autoExit: true`, and add:

```ts
test("lifecycle: FACTORY_GRACE_MS, FACTORY_SESSION_IDLE_MS, FACTORY_AUTO_EXIT=0", () => {
  const c = loadConfig({ FACTORY_CONFIG_DIR: dir, FACTORY_GRACE_MS: "5000", FACTORY_SESSION_IDLE_MS: "1000", FACTORY_AUTO_EXIT: "0" });
  expect([c.graceMs, c.sessionIdleMs, c.autoExit]).toEqual([5000, 1000, false]);
  expect(loadConfig({ FACTORY_CONFIG_DIR: dir, FACTORY_GRACE_MS: "x", FACTORY_AUTO_EXIT: "1" })).toMatchObject({ graceMs: 60000, autoExit: true });
});
```

- [ ] **Step 2: Write the failing integration tests** in `dashboard/test/integration/server.test.ts`, inside the existing top-level describe after the `session-start` test. Extend `boot`'s `opts` type with `onExit?: (reason: string) => void` and its config literal with `graceMs: 60000, sessionIdleMs: 7200000, autoExit: true` (a boot parameter `autoExit = true` feeds it).

```ts
test("lifecycle: the last session's end exits the server after the grace period, once", async () => {
  let t = Date.now();
  const exits: string[] = [];
  const { app, base } = boot(home, { now: () => t, sweepMs: 3_600_000, onExit: (r) => exits.push(r) });
  await postJson(`${base}/api/events`, { event: "session-start", project: repoDir, payload: { session_id: "L1", source: "startup" } });
  expect((await (await fetch(`${base}/api/health`)).json()).sessions).toBe(1);
  await postJson(`${base}/api/events`, { event: "session-end", project: repoDir, payload: { session_id: "L1", reason: "other" } });
  expect(app.checkExit()).toBeNull();
  t += 60_000;
  expect(app.checkExit()).toBe("no factory session or browser for 60s");
  app.sweep(); app.sweep();
  expect(exits).toEqual(["no factory session or browser for 60s"]);
});
test("lifecycle: an unknown session's end does not exit while a known session's process is alive", async () => {
  let t = Date.now();
  const { app, base } = boot(home, { now: () => t, sweepMs: 3_600_000 });
  await postJson(`${base}/api/events`, { event: "stage", project: repoDir, stage: "setup", status: "started", session: "L2", pid: process.pid, payload: {} });
  await postJson(`${base}/api/events`, { event: "session-end", project: repoDir, payload: { session_id: "nobody", reason: "other" } });
  t += 7_200_000;
  expect(app.checkExit()).toBeNull();
  expect(app.sessions.list().map((s) => [s.id, s.pid])).toEqual([["L2", process.pid]]);
});
test("lifecycle: a session whose process is gone is reaped and the server exits after the grace period", async () => {
  let t = Date.now();
  const { app, base } = boot(home, { now: () => t, sweepMs: 3_600_000 });
  await postJson(`${base}/api/events`, { event: "stage", project: repoDir, stage: "setup", status: "started", session: "L3", pid: 999_999, payload: {} });
  expect(app.checkExit()).toBeNull();
  expect(app.sessions.count).toBe(0);
  t += 60_000;
  expect(app.checkExit()).toBe("no factory session or browser for 60s");
});
test("lifecycle: an open stream keeps the server alive; closing it starts the grace period", async () => {
  let t = Date.now();
  const { app, base } = boot(home, { now: () => t, sweepMs: 3_600_000, heartbeatMs: 50 });
  const ac = new AbortController();
  const res = await fetch(`${base}/api/stream?repo=${encodeURIComponent(repoDir)}`, { signal: ac.signal });
  await readUntil(res.body!.getReader(), (acc) => acc.includes(": connected"), 2000);
  expect((await (await fetch(`${base}/api/health`)).json()).streams).toBe(1);
  await postJson(`${base}/api/events`, { event: "session-end", project: repoDir, payload: { session_id: "L4" } });
  t += 7_200_000;
  expect(app.checkExit()).toBeNull();
  ac.abort();
  for (let i = 0; i < 40 && app.sessions.streams > 0; i++) await Bun.sleep(50);
  expect(app.sessions.streams).toBe(0);
  t += 59_000; expect(app.checkExit()).toBeNull();
  t += 1_000; expect(app.checkExit()).toBe("no factory session or browser for 60s");
});
test("lifecycle: POST /api/repos registers the caller's session; session-end stops that session's live agents", async () => {
  const { app, base } = boot(home, { sweepMs: 3_600_000 });
  const r = await postJson(`${base}/api/repos`, { path: repoDir, session: "L5", pid: process.pid });
  expect(r.status).toBe(201);
  expect(app.sessions.list().map((s) => s.id)).toEqual(["L5"]);
  await postJson(`${base}/api/events`, { event: "subagent-start", project: repoDir, payload: { agent_id: "L5a", agent_type: "x", session_id: "L5", cwd: repoDir } });
  await postJson(`${base}/api/events`, { event: "subagent-start", project: repoDir, payload: { agent_id: "L6a", agent_type: "x", session_id: "L6", cwd: repoDir } });
  await postJson(`${base}/api/events`, { event: "session-end", project: repoDir, payload: { session_id: "L5" } });
  const agents = (await (await fetch(`${base}/api/agents?repo=${encodeURIComponent(repoDir)}`)).json()) as { live: { agentId: string }[] };
  expect(agents.live.map((a) => a.agentId)).toEqual(["L6a"]);
  expect(app.sessions.list().map((s) => s.id).sort()).toEqual(["L6"]);
});
test("lifecycle: FACTORY_AUTO_EXIT=0 reports the reason but never calls onExit", async () => {
  let t = Date.now();
  const exits: string[] = [];
  const { app, base } = boot(home, { now: () => t, sweepMs: 3_600_000, onExit: (r) => exits.push(r) }, undefined, {}, false, false);
  await postJson(`${base}/api/events`, { event: "session-end", project: repoDir, payload: { session_id: "L7" } });
  t += 60_000;
  expect(app.checkExit()).toBe("no factory session or browser for 60s");
  app.sweep();
  expect(exits).toEqual([]);
  expect((await (await fetch(`${base}/api/health`)).json()).autoExit).toBe(false);
});
```

`postJson` and `readUntil` already exist in the file; `/api/agents` lists `live` and `recent` (check its shape in the existing agents tests and adjust the property name if it differs).

- [ ] **Step 3: Run to verify they fail**

Run: `bun test dashboard/test/config.test.ts dashboard/test/integration/server.test.ts`
Expected: FAIL (type errors on the new config fields, unknown `checkExit`, `sessions` undefined in health).

- [ ] **Step 4: Implement** per the Interfaces block. Order: types → config → sessions wiring in `app.ts` → events → stream → api → server. Keep `handleEvent`'s existing `session-start` behaviour (`endOtherSessions`) and add the `seen` call before the switch.

- [ ] **Step 5: Run the whole dashboard suite and the type check**

Run: `bun test dashboard && cd dashboard && bunx tsc --noEmit -p .`
Expected: all pass, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src dashboard/test
git commit -m "feat(dashboard): server exits once no session or browser uses it"
```

---

### Task 4: Daemon reconciles the pidfile with the listener

**Files:**
- Modify: `dashboard/src/daemon.ts`
- Test: `dashboard/test/daemon.test.ts`

**Interfaces:**
- Consumes: `/api/health` `pid` (existing) and `POST /api/repos` `{ path, session?, pid? }` (Task 3).
- Produces (JSON printed by the daemon):
  - `status`: `{ running: true, port, pid, url[, repaired: true] }` | `{ running: false, port, foreign: true }` | `{ running: false, port }`.
  - `start`: `{ running: true, port, pid, url[, adopted: true][, replaced] }` | `{ running: false, error: "port <port> is in use by another program" }` (exit 1) | the existing failure shapes.
  - `stop`: `{ running: false, stopped: pid }` | `{ running: false }` | `{ running: false, stale: true }`.

Implementation notes: replace `healthy()` with `probe(): Promise<{ ok: false } | { ok: true; pid: number | null }>` (1 s timeout; `pid` from the JSON when it is a positive integer, else `null`). `ours = (p) => p.ok && p.pid !== null && isOurServer(p.pid)`. `registerCwd` adds `session: env.CLAUDE_CODE_SESSION_ID` when non-empty and `pid: Number(env.CLAUDE_PID)` when `/^[0-9]+$/` matches. `start`: probe first; ours → `registerCwd`, write the pidfile when it differs (`adopted: true`), print running, exit 0; `ok` but not ours → the foreign error, exit 1, nothing spawned; otherwise the existing path, where the start-up wait loop accepts only `probe()` answers whose `pid === proc.pid`. `status`: ours → running (write the pidfile when it differs, `repaired: true`); `ok` but not ours → foreign; else not running (remove a dead pidfile). `stop`: ours by probe → terminate that pid; else the existing pidfile logic.

- [ ] **Step 1: Write the failing tests** in `dashboard/test/daemon.test.ts` (same `run`/`env`/`port` helpers; each test stops what it starts, also on failure, as the existing ones do):

```ts
test("start adopts a running factory server the pidfile does not name", async () => {
  const a = run("start");
  try {
    expect(a.json.running).toBe(true);
    rmSync(join(env.FACTORY_CONFIG_DIR, "dashboard.pid"));
    const b = run("start");
    expect(b.json).toMatchObject({ running: true, pid: a.json.pid, adopted: true });
    expect(readFileSync(join(env.FACTORY_CONFIG_DIR, "dashboard.pid"), "utf8").trim()).toBe(String(a.json.pid));
    expect(alive(a.json.pid)).toBe(true);
  } finally { run("stop"); }
});
test("status repairs a pidfile that names another process", async () => {
  const a = run("start");
  try {
    writeFileSync(join(env.FACTORY_CONFIG_DIR, "dashboard.pid"), "1");
    expect(run("status").json).toMatchObject({ running: true, pid: a.json.pid, repaired: true });
    expect(readFileSync(join(env.FACTORY_CONFIG_DIR, "dashboard.pid"), "utf8").trim()).toBe(String(a.json.pid));
  } finally { run("stop"); }
});
test("a foreign listener on the port is reported, never killed or replaced", async () => {
  const foreign = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => Response.json({ ok: true }) });
  try {
    const s = run("start");
    expect(s.code).toBe(1);
    expect(s.json).toEqual({ running: false, error: `port ${port} is in use by another program` });
    expect(existsSync(join(env.FACTORY_CONFIG_DIR, "dashboard.pid"))).toBe(false);
    expect(run("status").json).toEqual({ running: false, port, foreign: true });
    expect((await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).ok).toBe(true);
  } finally { foreign.stop(true); }
});
test("start registers the caller's session from CLAUDE_CODE_SESSION_ID and CLAUDE_PID", async () => {
  const saved = env;
  env = { ...saved, CLAUDE_CODE_SESSION_ID: "d-sess", CLAUDE_PID: String(process.pid) };
  try {
    expect(run("start", repoWithConfig).json.running).toBe(true);
    const h = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    expect(h.sessions).toBe(1);
  } finally { run("stop"); env = saved; }
});
```

`repoWithConfig` is a temp directory holding `.factory/config.json` (`{}`), created in `beforeAll` like the existing registration test does (reuse its directory if one exists). The `run` helper is `run(cmd, cwd?, script = daemon)` and reads the module-level `env`, which the existing tests reassign and restore the same way.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test dashboard/test/daemon.test.ts`
Expected: the four new tests fail (second `start` spawns and fails on the port, `status` reports not running, foreign start spawns, `sessions` undefined).

- [ ] **Step 3: Implement** per the notes above.

- [ ] **Step 4: Run the daemon tests and the bin test**

Run: `bun test dashboard/test/daemon.test.ts tests/plugin/bin.test.ts`
Expected: PASS (the existing `start / start / status / stop / status` and `factory-dashboard status reports not running` tests included).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/daemon.ts dashboard/test/daemon.test.ts
git commit -m "fix(dashboard): daemon adopts or repairs the pidfile from /api/health and refuses a foreign port"
```

---

### Task 5: Atomic, idempotent settings edits

**Files:**
- Create: `lib/atomic.ts`, `lib/settings.ts`, `lib/cli/settings.ts`, `bin/factory-settings`
- Modify: `lib/config.ts:28-32` (`writeJson`)
- Modify: `skills/run/stages/setup.md:63,83` (the two `bun -e` commands and their surrounding prose)
- Modify: `tests/plugin/bin.test.ts:61`, `tests/plugin/content.test.ts` (new rule 14)
- Test: `tests/bin/factory-settings.test.ts`, `tests/lib/atomic.test.ts`

**Interfaces:**
- Produces:

```ts
// lib/atomic.ts
export function writeFileAtomic(path: string, text: string, opts?: { mode?: number }): void;
// temp `<dir>/.<base>.<pid>.<random>.tmp` in the same directory; fsync; chmod to the existing file's mode when
// there is one, else `opts.mode ?? 0o644`; renameSync over `path`; the temp file is removed on any failure and
// the error rethrown. mkdirSync(dirname, { recursive: true }) first.

// lib/settings.ts
export type SettingsResult = "written" | "unchanged" | "invalid" | "exists";
export function ensureEnv(file: string, pairs: Record<string, string>): SettingsResult;   // never "exists"
export function ensureMcpServer(file: string, name: string, url: string): SettingsResult;  // never "unchanged"
```

`ensureEnv`: missing file → `{}`; a file that does not parse to a JSON object, or whose `env` exists and is not an object → `invalid` (nothing written). Sets `env[k] = v` for each pair; when every value was already equal → `unchanged` (no write). Writes `JSON.stringify(doc, null, 2) + "\n"` with default mode 0o644. `ensureMcpServer`: same parsing (`mcpServers` must be an object when present); an existing `mcpServers[name]` → `exists`; else sets `{ type: "http", url: `${triliumBaseUrl(url.replace(/\/etapi$/, ""))}/mcp`, headers: { Authorization: `Bearer ${PLACEHOLDER_TOKEN}` } }` (`triliumBaseUrl`, `PLACEHOLDER_TOKEN` from `lib/trilium-config.ts`), writes with mode 0o600 and `chmodSync(file, 0o600)` afterwards → `written`.

`bin/factory-settings`: `#!/bin/sh` + `exec bun "$(dirname "$0")/../lib/cli/settings.ts" "$@"`. CLI: `factory-settings env <file> KEY=VALUE [KEY=VALUE…]` | `factory-settings mcp <file> <name> <url>`; prints the result word; exit 0 for `written`/`unchanged`, 1 for `invalid`/`exists`, 2 with a `usage:` line on stderr for anything else (a `KEY=VALUE` without `=` is a usage error). A thrown write error prints `invalid` and exits 1.

- [ ] **Step 1: Write the failing tests**

`tests/lib/atomic.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../../lib/atomic";

describe("writeFileAtomic", () => {
  test("creates the directory and file with the default mode, leaves no temp file", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-"));
    const f = join(dir, "sub", "a.json");
    writeFileAtomic(f, "{}\n");
    expect(readFileSync(f, "utf8")).toBe("{}\n");
    expect(statSync(f).mode & 0o777).toBe(0o644);
    expect(readdirSync(join(dir, "sub"))).toEqual(["a.json"]);
  });
  test("keeps an existing file's mode and replaces its content whole", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-"));
    const f = join(dir, "b.json");
    writeFileSync(f, "old"); chmodSync(f, 0o600);
    writeFileAtomic(f, "new", { mode: 0o644 });
    expect(readFileSync(f, "utf8")).toBe("new");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["b.json"]);
  });
});
```

`tests/bin/factory-settings.test.ts` (spawn `bin/factory-settings` like `tests/bin/factory-config.test.ts` does):

```ts
const run = async (args: string[]) => { const p = Bun.spawn(["bin/factory-settings", ...args], { stdout: "pipe", stderr: "pipe" }); return { code: await p.exited, out: (await new Response(p.stdout).text()).trim(), err: await new Response(p.stderr).text() }; };
const tmp = () => mkdtempSync(join(tmpdir(), "fset-"));
const noTemp = (dir: string) => expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);

describe("factory-settings env", () => {
  test("creates the file, merges into an existing env, keeps other keys and order, is idempotent", async () => {
    const dir = tmp(); const f = join(dir, ".claude", "settings.local.json");
    expect(await run(["env", f, "NODE_TLS_REJECT_UNAUTHORIZED=0"])).toMatchObject({ code: 0, out: "written" });
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } });
    writeFileSync(f, JSON.stringify({ permissions: { allow: ["Bash"] }, env: { FOO: "1" } }));
    expect((await run(["env", f, "NODE_TLS_REJECT_UNAUTHORIZED=0", "BAR=2"])).out).toBe("written");
    expect(readFileSync(f, "utf8")).toBe(JSON.stringify({ permissions: { allow: ["Bash"] }, env: { FOO: "1", NODE_TLS_REJECT_UNAUTHORIZED: "0", BAR: "2" } }, null, 2) + "\n");
    const before = statSync(f).mtimeMs;
    expect(await run(["env", f, "NODE_TLS_REJECT_UNAUTHORIZED=0"])).toMatchObject({ code: 0, out: "unchanged" });
    expect(statSync(f).mtimeMs).toBe(before);
    noTemp(join(dir, ".claude"));
  });
  test("an invalid file is reported and left byte-identical", async () => {
    const dir = tmp(); const f = join(dir, "s.json");
    for (const text of ["{ broken", "[]", JSON.stringify({ env: 5 })]) {
      writeFileSync(f, text);
      expect(await run(["env", f, "A=1"])).toMatchObject({ code: 1, out: "invalid" });
      expect(readFileSync(f, "utf8")).toBe(text);
    }
    noTemp(dir);
  });
  test("usage errors exit 2", async () => {
    expect((await run(["env", join(tmp(), "s.json"), "NOEQUALS"])).code).toBe(2);
    expect((await run(["bogus"])).code).toBe(2);
  });
});
describe("factory-settings mcp", () => {
  test("writes the trilium entry with a normalised url and mode 0600; keeps other servers", async () => {
    const dir = tmp(); const f = join(dir, ".mcp.json");
    expect(await run(["mcp", f, "trilium", "https://t.example:8443/etapi/"])).toMatchObject({ code: 0, out: "written" });
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ mcpServers: { trilium: { type: "http", url: "https://t.example:8443/mcp", headers: { Authorization: "Bearer your-etapi-token" } } } });
    expect(statSync(f).mode & 0o777).toBe(0o600);
    writeFileSync(f, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    expect((await run(["mcp", f, "trilium", "http://localhost:8080/mcp"])).out).toBe("written");
    expect(JSON.parse(readFileSync(f, "utf8")).mcpServers.other).toEqual({ command: "x" });
    expect(JSON.parse(readFileSync(f, "utf8")).mcpServers.trilium.url).toBe("http://localhost:8080/mcp");
    noTemp(dir);
  });
  test("an existing entry of that name is never overwritten", async () => {
    const dir = tmp(); const f = join(dir, ".mcp.json");
    const text = JSON.stringify({ mcpServers: { trilium: { type: "http", url: "http://x/mcp", headers: { Authorization: "Bearer real" } } } });
    writeFileSync(f, text);
    expect(await run(["mcp", f, "trilium", "http://y"])).toMatchObject({ code: 1, out: "exists" });
    expect(readFileSync(f, "utf8")).toBe(text);
    writeFileSync(f, "{ nope");
    expect((await run(["mcp", f, "trilium", "http://y"])).out).toBe("invalid");
    noTemp(dir);
  });
});
```

`tests/plugin/bin.test.ts`: add `"factory-settings"` to the expected scripts list. `tests/plugin/content.test.ts` rule 14:

```ts
test("settings: setup.md edits Claude settings through factory-settings, never inline bun scripts", () => {
  const s = read("skills/run/stages/setup.md");
  const problems: string[] = [];
  if (s.includes("bun -e")) problems.push("setup.md: still runs an inline bun -e script");
  for (const w of ["factory-settings env", "factory-settings mcp"]) if (!s.includes(w)) problems.push(`setup.md: does not use ${w}`);
  expect(problems, problems.join("\n")).toEqual([]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tests/lib tests/bin/factory-settings.test.ts tests/plugin`
Expected: FAIL (modules and script missing; rule 14 and the bin list fail).

- [ ] **Step 3: Implement** `lib/atomic.ts`, `lib/settings.ts`, `lib/cli/settings.ts`, `bin/factory-settings` (`chmod +x`); make `lib/config.ts`'s `writeJson` call `writeFileAtomic(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })` followed by `chmodSync(path, 0o600)` as today.

- [ ] **Step 4: Edit `skills/run/stages/setup.md`**

Step 4's TLS fix line becomes: ``Fix (keeps other keys; prints `written`, `unchanged` or `invalid`; then `<ignore>`): `factory-settings env "<repoPath>/.claude/settings.local.json" NODE_TLS_REJECT_UNAUTHORIZED=0` `` and the next sentence keeps "(`invalid` → show it, continue without)". Step 3's fix line becomes: ``Fix: Tracked rule; then (prints `written`, `invalid` or `exists`; `<url>` single-quoted) `factory-settings mcp "<repoPath>/.mcp.json" trilium '<url>'`.`` and the following line reads "`invalid` (not JSON) or `exists` (a `trilium` server is already there; the factory never overwrites it) → the user must fix `.mcp.json`; Stop setup." Keep every other sentence. Check `wc -c skills/run/stages/setup.md` ≤ 16000.

- [ ] **Step 5: Run everything**

Run: `bun test tests && bun test dashboard/test/mcp-config.test.ts`
Expected: PASS (factory-config tests still green: `set`, `migrate-trilium`).

- [ ] **Step 6: Commit**

```bash
git add lib bin/factory-settings tests skills/run/stages/setup.md
git commit -m "feat(bin): factory-settings edits Claude settings atomically and idempotently; config writes are atomic"
```

---

### Task 6: Documentation

**Files:**
- Modify: `README.md` (Dashboard section, step 2 of the first-run list)
- Modify: `dashboard/scripts/verify.md` (new "## Lifecycle" section before "## Repo tab")
- Modify: `skills/run/SKILL.md` ("## Dashboard" section)

**Interfaces:** consumes the names and defaults of Tasks 1–5; produces no code.

- [ ] **Step 1: README**

Dashboard section, after the `factory-dashboard status | open | stop | restart` bullet, add:

- "The server stops itself a minute after the last factory session ends (the plugin's `SessionEnd` hook tells it) unless a browser tab is open; a session whose Claude process is gone is noticed within a sweep, and a session that stops sending events for two hours counts as gone. `FACTORY_GRACE_MS` (60000) and `FACTORY_SESSION_IDLE_MS` (7200000) set the periods; `FACTORY_AUTO_EXIT=0` before `factory-dashboard start` keeps it running until `stop`."
- "`start` and `status` reconcile the pidfile with whatever answers `/api/health` on the port: a factory server the pidfile does not name is adopted, a stale pidfile is repaired, and another program on the port is reported (`foreign: true`), never replaced."

First-run step 2: after the sentence about `NODE_TLS_REJECT_UNAUTHORIZED=0`, add "Both files are written by `factory-settings` (atomic temp-file-and-rename, idempotent; an existing `trilium` server entry is never overwritten)."

- [ ] **Step 2: verify.md** — insert before "## Repo tab":

```
## Lifecycle

1. `FACTORY_GRACE_MS=5000 bin/factory-dashboard start` from a plain shell (no Claude session) -> running.
2. `echo '{"session_id":"v1","source":"startup"}' | CLAUDE_PROJECT_DIR="$repo" dashboard/scripts/send-event.sh session-start`,
   then `curl -s 127.0.0.1:<port>/api/health` -> `"sessions": 1, "streams": 0, "autoExit": true`.
3. `echo '{"session_id":"v1","reason":"other"}' | CLAUDE_PROJECT_DIR="$repo" dashboard/scripts/send-event.sh session-end`;
   within 30 s `bin/factory-dashboard status` -> `running: false`, the pidfile is gone and `dashboard.log` ends with
   `factory-dashboard: exiting (no factory session or browser for 5s)`.
4. Repeat 1-3 with the board open in a browser: `streams` is 1 and the server stays; close the tab and it stops.
5. `bin/factory-dashboard start`, delete `~/.config/claude-factory/dashboard.pid`, `bin/factory-dashboard start`
   again -> same pid with `"adopted": true`; `status` -> running; `stop`.
```

- [ ] **Step 3: SKILL.md** Dashboard section, add one bullet: "The server stops itself a minute after the last factory session ends unless a browser tab is open; the next `/factory:run` starts it again. Never run `factory-dashboard stop` for the user."

- [ ] **Step 4: Check sizes and the content tests**

Run: `wc -c skills/run/SKILL.md skills/run/stages/setup.md && bun test tests/plugin`
Expected: both files ≤ 16000; PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md dashboard/scripts/verify.md skills/run/SKILL.md
git commit -m "docs: dashboard lifecycle, pidfile reconciliation and factory-settings"
```
