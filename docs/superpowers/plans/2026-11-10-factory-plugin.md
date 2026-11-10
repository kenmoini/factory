# Factory Plugin (core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `factory` Claude Code plugin: bin tooling, hooks, the `run` orchestrator skill with its stage files, references and templates, the 11 alias skills, and the 10 subagent definitions.

**Architecture:** A plugin whose only "code" is a handful of small Bun/TypeScript libraries behind `bin/` shims plus two POSIX-sh scripts; everything else is Markdown that drives Claude (the `run` skill reads `stages/<stage>.md` and follows it; subagents are `agents/*.md`). Trilium is reached through its built-in MCP server registered natively with `claude mcp add`; the dashboard (separate plan) is a black box behind `bin/factory-dashboard`.

**Tech Stack:** Bun ≥ 1.2.10 (TypeScript libs + `bun test`), POSIX sh, git, `claude plugin validate`, TriliumNext built-in MCP (≥ 0.106), Graphify (`graphifyy`), superpowers 7.0.0.

**Spec:** `docs/superpowers/specs/2026-11-10-factory-plugin-design.md`

## Global Constraints

- Plugin name `factory`; skills invoked as `/factory:<skill>`; skill set is exactly `run, setup, examine, set-standards, enforce-standards, brainstorm, uiux, api-design, plan, validate, execute, graph`.
- Agent set is exactly `spec-writer (fable), builder (opus), security-reviewer (opus), ux-reviewer (sonnet), ui-design-reviewer (sonnet), code-reviewer (opus), approver (opus), codebase-examiner (sonnet), standards-researcher (sonnet), plan-adversary (opus)`.
- Only the orchestrator writes Trilium: no agent file lists any `mcp__` tool; agents never receive `Skill`-preloaded Trilium access.
- Plugin agents must not use `hooks`, `mcpServers`, `permissionMode` frontmatter (ignored by Claude Code).
- No root `CLAUDE.md` in the plugin (not loaded; `claude plugin validate` warns).
- Global config lives at `~/.config/claude-factory/config.json` (override dir with env `FACTORY_CONFIG_DIR`), mode `0600`, keys `triliumUrl`, `etapiToken`, `dashboardPort` (default `7777`).
- Repo config lives at `<repo>/.factory/config.json`; `.factory/` and `graphify-out/` are gitignored in target repos.
- Worktrees at `<repo>/.factory/worktrees/<slug>` on branch `<slug>`; slug matches `^[a-z0-9][a-z0-9-]{0,62}$` and does not end with `-`.
- Merges to `main` are `git merge --no-ff`; no PRs.
- bin scripts never block Claude: `factory-event` always exits 0 within 2 s; `factory-preflight` always exits 0 and always prints one JSON line.
- Hook/dashboard event body shape: `{"event","ts","project","stage?","status?","task?","workstream?","payload"}` posted to `http://127.0.0.1:<dashboardPort>/api/events`.
- Task status vocabulary: `todo|spec|building|reviewing|fixing|approving|merging|done|needs-human|blocked`. Review verdicts `PASS|CHANGES`; approver verdicts `APPROVE|ESCALATE`; builder statuses `DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED`.
- Max 2 fix rounds (review round 3 with CHANGES → `needs-human`, escalation `fix-cap`).
- Every Agent dispatch `description` contains `[task:<noteId>]` when a task is involved.
- `bun test` from the repo root runs every test in `tests/`.

## Review Focus

1. `factory-event` invoked with an empty stdin or non-JSON stdin (hooks can send nothing on some events): it must still post a valid JSON body with `"payload": {}` and exit 0 — test in Task 3.
2. `factory-worktree ensure` run twice, and run when the branch exists but the worktree directory was deleted by hand: both must converge to a usable worktree without error — test in Task 6.
3. `factory-merge` when `main` has uncommitted changes: it must refuse (`dirty`) and leave the tree untouched rather than merging on top of a dirty tree — test in Task 8.
4. `factory-preflight` when Trilium is unreachable or the token is wrong: it must still return within the timeout with `trilium.ok=false` and an `error` string so the orchestrator can route to setup — test in Task 5.
5. A stage file referring to a label name that the schema does not declare (typo drift between `stages/*.md`, `agents/*.md` and `trilium-schema.md`): the content harness must fail — test in Task 10.

---

### Task 1: Repository scaffold, plugin manifest, Bun, validation test

**Files:**
- Create: `.claude-plugin/plugin.json`, `.gitignore`, `LICENSE` (MIT, copyright Ken Moini 2026 — flag to user), `README.md` (title + one-paragraph description + "docs/superpowers/specs" pointer), `package.json`, `tsconfig.json`
- Test: `tests/plugin/manifest.test.ts`

**Interfaces:**
- Produces: `package.json` scripts `test: "bun test"`; `tsconfig.json` with `"types": ["bun-types"]`, `"strict": true`, `"module": "esnext"`, `"moduleResolution": "bundler"`.

- [ ] **Step 1: Install Bun if missing**

Run: `command -v bun || brew install oven-sh/bun/bun || (curl -fsSL https://bun.sh/install | bash)`
Expected: `bun --version` prints ≥ 1.2.10.

- [ ] **Step 2: Write the failing test**

```ts
// tests/plugin/manifest.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("plugin manifest", () => {
  const manifest = JSON.parse(readFileSync(".claude-plugin/plugin.json", "utf8"));
  test("name is factory and kebab-case", () => {
    expect(manifest.name).toBe("factory");
    expect(manifest.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
  test("has version, description, author", () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof manifest.description).toBe("string");
    expect(manifest.author?.name).toBeTruthy();
  });
  test("claude plugin validate --strict passes", async () => {
    const proc = Bun.spawn(["claude", "plugin", "validate", ".", "--strict"], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    expect(code).toBe(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/plugin/manifest.test.ts`
Expected: FAIL (ENOENT reading `.claude-plugin/plugin.json`).

- [ ] **Step 4: Create the scaffold files**

`plugin.json`: `{"name":"factory","version":"0.1.0","description":"Claude-driven software factory: Trilium-backed planning/tracking, Graphify code graph, review pipeline and live dashboard","author":{"name":"Ken Moini"},"keywords":["factory","orchestrator","trilium","graphify"]}`.
`.gitignore`: `node_modules/`, `dashboard/dist/`, `*.log`, `.factory/`, `graphify-out/`, `.DS_Store`.
`package.json`: `{"name":"factory-plugin","private":true,"type":"module","scripts":{"test":"bun test"},"engines":{"bun":">=1.2.10"},"devDependencies":{"bun-types":"latest"}}` then `bun install`.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/plugin/manifest.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: scaffold factory plugin manifest, bun test harness"
```

---

### Task 2: `lib/config.ts` + `bin/factory-config`

**Files:**
- Create: `lib/config.ts`, `lib/cli/config.ts`, `bin/factory-config` (sh shim)
- Test: `tests/lib/config.test.ts`, `tests/bin/factory-config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type GlobalConfig = { triliumUrl: string; etapiToken: string; dashboardPort: number };
  export type WorkstreamEntry = { noteId: string; branch: string; worktree: string };
  export type RepoConfig = { projectNoteId?: string; activeWorkstream?: string; workstreams: Record<string, WorkstreamEntry> };
  export const DEFAULT_PORT = 7777;
  export function globalConfigDir(env?: NodeJS.ProcessEnv): string;        // env.FACTORY_CONFIG_DIR ?? `${env.HOME}/.config/claude-factory`
  export function globalConfigPath(env?): string;                          // `${dir}/config.json`
  export function readGlobalConfig(env?): GlobalConfig | null;             // null when missing/invalid JSON
  export function writeGlobalConfig(cfg: GlobalConfig, env?): string;     // mkdir -p; writes with mode 0o600; returns path
  export function repoConfigPath(repoDir: string): string;                 // `${repoDir}/.factory/config.json`
  export function readRepoConfig(repoDir: string): RepoConfig | null;
  export function writeRepoConfig(repoDir: string, cfg: RepoConfig): string;
  export function getPath(obj: unknown, dotted: string): unknown;
  export function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void;
  ```
- CLI `factory-config get <key> [--repo <dir>]` → prints value (JSON for objects) exit 0; exit 1 + stderr `missing: <key>` when absent. `factory-config set <key> <value> [--repo <dir>]` → coerces `dashboardPort` to number, writes file, prints path. `factory-config path [--repo <dir>]`.
- Shim pattern used by every later bin script: `#!/bin/sh` / `exec bun "$(dirname "$0")/../lib/cli/<name>.ts" "$@"`.

- [ ] **Step 1: Write the failing lib test**

```ts
// tests/lib/config.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGlobalConfig, writeGlobalConfig, readRepoConfig, writeRepoConfig, globalConfigPath, getPath, setPath } from "../../lib/config";

const env = () => ({ FACTORY_CONFIG_DIR: mkdtempSync(join(tmpdir(), "fcfg-")), HOME: "/nonexistent" });

describe("global config", () => {
  test("missing file reads as null", () => expect(readGlobalConfig(env())).toBeNull());
  test("round-trips and is mode 0600", () => {
    const e = env();
    const p = writeGlobalConfig({ triliumUrl: "http://t:8080", etapiToken: "tok", dashboardPort: 7777 }, e);
    expect(p).toBe(globalConfigPath(e));
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readGlobalConfig(e)).toEqual({ triliumUrl: "http://t:8080", etapiToken: "tok", dashboardPort: 7777 });
  });
});
describe("repo config", () => {
  test("round-trips under .factory/", () => {
    const repo = mkdtempSync(join(tmpdir(), "frepo-"));
    writeRepoConfig(repo, { projectNoteId: "n1", workstreams: { a: { noteId: "w1", branch: "a", worktree: ".factory/worktrees/a" } } });
    expect(readRepoConfig(repo)?.workstreams.a.noteId).toBe("w1");
  });
});
describe("dotted paths", () => {
  test("get/set nested", () => {
    const o: Record<string, unknown> = {};
    setPath(o, "workstreams.a.noteId", "x");
    expect(getPath(o, "workstreams.a.noteId")).toBe("x");
    expect(getPath(o, "nope.deeper")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/lib/config.test.ts`
Expected: FAIL — cannot resolve `../../lib/config`.

- [ ] **Step 3: Implement `lib/config.ts`**

Use `node:fs` sync APIs; `writeFileSync(path, json, { mode: 0o600 })` followed by `chmodSync(path, 0o600)` (mode is ignored when the file already exists).

- [ ] **Step 4: Run lib test to verify it passes**

Run: `bun test tests/lib/config.test.ts` → PASS.

- [ ] **Step 5: Write the failing CLI test**

```ts
// tests/bin/factory-config.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function run(args: string[], env: Record<string, string>) {
  const p = Bun.spawn(["bin/factory-config", ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: await p.exited, out: (await new Response(p.stdout).text()).trim(), err: await new Response(p.stderr).text() };
}
describe("factory-config", () => {
  test("set then get global key; missing key exits 1", async () => {
    const env = { FACTORY_CONFIG_DIR: mkdtempSync(join(tmpdir(), "fcfg-")) };
    expect((await run(["set", "dashboardPort", "7788"], env)).code).toBe(0);
    expect((await run(["get", "dashboardPort"], env)).out).toBe("7788");
    expect((await run(["get", "etapiToken"], env)).code).toBe(1);
  });
  test("repo scope writes .factory/config.json", async () => {
    const repo = mkdtempSync(join(tmpdir(), "frepo-"));
    await run(["set", "activeWorkstream", "demo", "--repo", repo], {});
    expect((await run(["path", "--repo", repo], {})).out).toBe(join(repo, ".factory/config.json"));
    expect((await run(["get", "activeWorkstream", "--repo", repo], {})).out).toBe("demo");
  });
});
```

- [ ] **Step 6: Run CLI test to verify it fails** → FAIL (no `bin/factory-config`).

- [ ] **Step 7: Implement `lib/cli/config.ts` and the `bin/factory-config` shim; `chmod +x bin/factory-config`**

- [ ] **Step 8: Run both tests** → PASS.

- [ ] **Step 9: Commit** — `git commit -m "feat(bin): factory-config with global/repo config library"`

---

### Task 3: `bin/factory-event` (POSIX sh) + SessionStart context line

**Files:**
- Create: `bin/factory-event`
- Test: `tests/bin/factory-event.test.ts`, `tests/fixtures/hooks/subagent-start.json`, `tests/fixtures/hooks/subagent-stop.json`

**Interfaces:**
- CLI: `factory-event <kind> [--stage S] [--status ST] [--task T] [--workstream W]`, stdin = hook JSON (may be empty). Kinds: `subagent-start | subagent-stop | session-start | stage | task | agent`.
- Behaviour: resolve `PROJECT="${CLAUDE_PROJECT_DIR:-$PWD}"`; if `$PROJECT/.factory/config.json` is absent → exit 0 silently. Port from `${FACTORY_CONFIG_DIR:-$HOME/.config/claude-factory}/config.json` via `sed -n 's/.*"dashboardPort"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p'`, default 7777. Body: `{"event":"<kind>","ts":"<date -u +%Y-%m-%dT%H:%M:%SZ>","project":"<PROJECT>","stage":"…","status":"…","task":"…","workstream":"…","payload":<stdin-or-{}>}` (omit optional keys not given). `curl -s -m 2 --connect-timeout 1 -X POST -H 'Content-Type: application/json' --data-binary @- "http://127.0.0.1:$PORT/api/events" >/dev/null 2>&1 || true`. Always `exit 0`.
- `session-start` additionally prints to stdout: `Factory project detected (active workstream: <slug|none>). Run /factory:run status.` where slug is read from `.factory/config.json` with sed; other kinds print nothing.

- [ ] **Step 1: Write fixtures** — `subagent-start.json`: `{"session_id":"s1","cwd":"/tmp/x","hook_event_name":"SubagentStart","agent_id":"a1","agent_type":"factory:builder"}`; `subagent-stop.json` adds `"agent_transcript_path":"/tmp/t.jsonl","last_assistant_message":"done"`.

- [ ] **Step 2: Write the failing test**

```ts
// tests/bin/factory-event.test.ts
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string, repo: string, cfgDir: string, binDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fev-")); repo = join(dir, "repo"); cfgDir = join(dir, "cfg"); binDir = join(dir, "bin");
  mkdirSync(join(repo, ".factory"), { recursive: true }); mkdirSync(cfgDir); mkdirSync(binDir);
  writeFileSync(join(binDir, "curl"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/curl.args"\ncat > "${dir}/curl.body"\nexit 7\n`); chmodSync(join(binDir, "curl"), 0o755);
  writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ triliumUrl: "http://t", etapiToken: "x", dashboardPort: 7801 }));
});
async function run(args: string[], stdin: string, extraEnv: Record<string,string> = {}) {
  const p = Bun.spawn(["bin/factory-event", ...args], { stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, CLAUDE_PROJECT_DIR: repo, FACTORY_CONFIG_DIR: cfgDir, ...extraEnv } });
  return { code: await p.exited, out: await new Response(p.stdout).text() };
}
describe("factory-event", () => {
  test("no .factory/config.json → exit 0, no curl", async () => {
    const r = await run(["subagent-start"], "{}", { CLAUDE_PROJECT_DIR: dir });
    expect(r.code).toBe(0); expect(existsSync(join(dir, "curl.args"))).toBe(false);
  });
  test("posts wrapped body to configured port; curl failure still exits 0", async () => {
    writeFileSync(join(repo, ".factory/config.json"), JSON.stringify({ activeWorkstream: "demo" }));
    const r = await run(["subagent-start"], readFileSync("tests/fixtures/hooks/subagent-start.json", "utf8"));
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "curl.args"), "utf8")).toContain("http://127.0.0.1:7801/api/events");
    const body = JSON.parse(readFileSync(join(dir, "curl.body"), "utf8"));
    expect(body.event).toBe("subagent-start"); expect(body.project).toBe(repo); expect(body.payload.agent_id).toBe("a1");
    expect(body.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  test("empty stdin → payload {} ; flags become fields", async () => {
    writeFileSync(join(repo, ".factory/config.json"), "{}");
    await run(["stage", "--stage", "execute", "--status", "started", "--task", "T-001"], "");
    const body = JSON.parse(readFileSync(join(dir, "curl.body"), "utf8"));
    expect(body.payload).toEqual({}); expect(body.stage).toBe("execute"); expect(body.status).toBe("started"); expect(body.task).toBe("T-001");
  });
  test("session-start prints context line with active workstream", async () => {
    writeFileSync(join(repo, ".factory/config.json"), JSON.stringify({ activeWorkstream: "demo" }));
    const r = await run(["session-start"], "{}");
    expect(r.out.trim()).toBe("Factory project detected (active workstream: demo). Run /factory:run status.");
  });
});
```

- [ ] **Step 3: Run test to verify it fails** → FAIL (no script).

- [ ] **Step 4: Implement `bin/factory-event`** as POSIX sh (no bash-isms, no jq). Read stdin with `payload=$(cat)`; if `[ -z "$payload" ]` use `{}`. Build the body with `printf`. `chmod +x`.

- [ ] **Step 5: Run test** → PASS (4 tests). Also run `sh -n bin/factory-event` and `shellcheck bin/factory-event` if available.

- [ ] **Step 6: Commit** — `git commit -m "feat(bin): factory-event hook relay to dashboard"`

---

### Task 4: `hooks/hooks.json`

**Files:**
- Create: `hooks/hooks.json`
- Test: `tests/plugin/hooks.test.ts`

**Interfaces:**
- Produces exactly the hooks block from the spec section "Hooks": `SubagentStart` and `SubagentStop` → `"${CLAUDE_PLUGIN_ROOT}/bin/factory-event" subagent-start|subagent-stop` with `async: true, timeout: 5`; `SessionStart` matcher `startup|clear|compact` → `… session-start` with `timeout: 3` (sync).

- [ ] **Step 1: Write the failing test** — parse `hooks/hooks.json`; assert keys `SubagentStart`, `SubagentStop`, `SessionStart` exist; every `command` string references `${CLAUDE_PLUGIN_ROOT}/bin/factory-event` and the referenced file exists and is executable (`statSync("bin/factory-event").mode & 0o111`); SubagentStart/Stop entries have `async === true`; no `PostToolUse` key.

- [ ] **Step 2: Run** → FAIL. **Step 3: Write `hooks/hooks.json`.** **Step 4: Run** → PASS; also `claude plugin validate . --strict` → exit 0.

- [ ] **Step 5: Commit** — `git commit -m "feat: plugin hooks relay subagent lifecycle to dashboard"`

---

### Task 5: `lib/preflight.ts` + `bin/factory-preflight`

**Files:**
- Create: `lib/preflight.ts`, `lib/cli/preflight.ts`, `bin/factory-preflight`
- Test: `tests/lib/preflight.test.ts`

**Interfaces:**
- Consumes: `readGlobalConfig`, `readRepoConfig` (Task 2).
- Produces:
  ```ts
  export type Preflight = {
    config: { global: boolean; repo: boolean; dir: string };
    trilium: { ok: boolean; url?: string; version?: string; mcpEndpoint?: boolean; mcpRegistered?: boolean; error?: string };
    dashboard: { running: boolean; port: number };
    git: { isRepo: boolean; root?: string; branch?: string; dirty?: boolean; hasCommits?: boolean };
    factory: { configured: boolean; projectNoteId?: string; activeWorkstream?: string; worktree?: string };
    graphify: { installed: boolean; outPresent: boolean; ageMinutes?: number; gitHooks: boolean };
    tools: { bun: boolean; uv: boolean; node: boolean; superpowers: boolean };
  };
  export async function preflight(opts: { cwd: string; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; timeoutMs?: number; exec?: (cmd: string[]) => Promise<{ code: number; out: string }> }): Promise<Preflight>;
  ```
- Probes: Trilium `GET ${triliumUrl}/etapi/app-info` header `Authorization: <token>` → `version = appVersion`; `mcpEndpoint = (GET ${triliumUrl}/mcp with Bearer).status !== 404` (any HTTP response counts); `mcpRegistered = exec(["claude","mcp","get","trilium"]).code === 0`; dashboard `GET http://127.0.0.1:<port>/api/health` ok; git via `git rev-parse --show-toplevel`, `--abbrev-ref HEAD`, `status --porcelain`, `rev-parse HEAD`; graphify `command -v graphify`, `<root>/graphify-out/graph.json` mtime, `.git/hooks/post-commit` contains `graphify`; superpowers = `~/.claude/plugins/installed_plugins.json` text includes `"superpowers@`.
- CLI prints `JSON.stringify(result)` on one line, exit 0 always (errors are embedded).

- [ ] **Step 1: Write the failing test** — use an injected `fetchImpl` (returns 200 `{appVersion:"0.107.0"}` for `/etapi/app-info`, 405 for `/mcp`, rejects for health) and injected `exec` (returns code 0 for `claude mcp get`, git answers from a real temp repo created with one commit). Assert: `trilium.ok === true`, `version === "0.107.0"`, `mcpEndpoint === true`, `dashboard.running === false`, `git.isRepo === true && hasCommits === true && dirty === false`, `config.global === true`. Second test: `fetchImpl` rejects with `ECONNREFUSED` → `trilium.ok === false`, `error` contains `ECONNREFUSED`, promise resolves within `timeoutMs` (use `timeoutMs: 500` and a fetch that never resolves; assert elapsed < 1000 ms). Third test: no global config → `config.global === false`, `trilium.ok === false`, `trilium.error === "no config"`.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement `lib/preflight.ts`** (use `AbortSignal.timeout(timeoutMs)` per probe; run probes with `Promise.allSettled`). **Step 4: Implement `lib/cli/preflight.ts` + shim; run `bin/factory-preflight` in this repo and confirm one JSON line.** **Step 5: Run tests** → PASS.

- [ ] **Step 6: Commit** — `git commit -m "feat(bin): factory-preflight environment probe"`

---

### Task 6: `lib/worktree.ts` + `bin/factory-worktree`

**Files:**
- Create: `lib/git.ts` (shared `git(repoDir, ...args): Promise<{code,out,err}>` + `defaultBranch(repoDir)`), `lib/worktree.ts`, `lib/cli/worktree.ts`, `bin/factory-worktree`
- Test: `tests/lib/worktree.test.ts`

**Interfaces:**
- Consumes: `readRepoConfig`, `writeRepoConfig` (Task 2).
- Produces:
  ```ts
  export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
  export function validateSlug(slug: string): string | null;            // null = ok; else reason
  export function worktreePath(repoDir: string, slug: string): string;   // `${repoDir}/.factory/worktrees/${slug}`
  export class ForeignBranchError extends Error {}
  export async function ensureWorktree(repoDir: string, slug: string, opts?: { adopt?: boolean; baseRef?: string }): Promise<{ path: string; branch: string; created: boolean; branchCreated: boolean }>;
  export async function removeWorktree(repoDir: string, slug: string, opts?: { deleteBranch?: boolean }): Promise<{ removed: boolean }>;
  ```
- Rules: branch name = slug; base = `opts.baseRef ?? defaultBranch` (`main` if exists, else `master`, else current HEAD). If branch exists and `readRepoConfig(repoDir)?.workstreams[slug]` is absent and `!adopt` → throw `ForeignBranchError`. If worktree dir exists and `git worktree list --porcelain` lists it on the branch → `created:false`. If the branch exists but the dir is missing → `git worktree prune` then `git worktree add <path> <slug>`. On success record `workstreams[slug] = { noteId: existing ?? "", branch, worktree: ".factory/worktrees/<slug>" }` in repo config. CLI: `factory-worktree ensure <slug> [--adopt] [--base <ref>]` prints the result JSON; `remove <slug> [--delete-branch]`. Exit 2 on `ForeignBranchError`, 3 on invalid slug.

- [ ] **Step 1: Write the failing test** — helper `makeRepo()` (temp dir, `git init -b main`, one commit). Tests: `validateSlug("My Slug")` → reason; `validateSlug("a-b")` → null; `ensureWorktree` creates `.factory/worktrees/demo` with `git -C <path> rev-parse --abbrev-ref HEAD` = `demo` and `created:true, branchCreated:true`; second call `created:false`; `rm -rf` the worktree dir then `ensureWorktree` again → `created:true, branchCreated:false`; pre-existing branch `other` not in config → `ForeignBranchError`; with `adopt:true` → succeeds; `removeWorktree` → dir gone, branch kept.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement `lib/git.ts`, `lib/worktree.ts`, CLI + shim.** **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(bin): factory-worktree ensure/remove per-workstream worktrees"`

---

### Task 7: `lib/review-package.ts` + `bin/factory-review-package`

**Files:**
- Create: `lib/review-package.ts`, `lib/cli/review-package.ts`, `bin/factory-review-package`
- Test: `tests/lib/review-package.test.ts`

**Interfaces:**
- Consumes: `git()` (Task 6).
- Produces: `export async function buildReviewPackage(opts: { worktree: string; base: string; head: string; outFile: string; context?: number }): Promise<{ path: string; commits: number; filesChanged: number }>` writing Markdown with sections `# Review package`, `Range: <base>..<head>`, `## Commits` (`git log --format=%h %s base..head`), `## Stat` (`git diff --stat base..head`), `## Diff` (fenced ```diff of `git diff -U<context=10> base..head`). CLI: `factory-review-package <worktree> <base> <head> --out <file>`; prints the JSON result; exit 1 if range invalid.

- [ ] **Step 1: Write the failing test** — temp repo with commit A (file `a.txt`), commit B (modifies `a.txt`, adds `b.txt`); `buildReviewPackage({ base: A, head: B })` → `commits === 1`, `filesChanged === 2`, file contains `## Commits`, `b.txt`, and `@@` hunk markers; invalid `head` rejects.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Step 5: Commit** — `git commit -m "feat(bin): factory-review-package diff bundle for reviewers"`

---

### Task 8: `lib/merge.ts` + `bin/factory-merge`

**Files:**
- Create: `lib/merge.ts`, `lib/cli/merge.ts`, `bin/factory-merge`
- Test: `tests/lib/merge.test.ts`

**Interfaces:**
- Consumes: `git()`, `defaultBranch()` (Task 6).
- Produces:
  ```ts
  export type MergeResult = { result: "merged"; sha: string } | { result: "up-to-date" } | { result: "conflict"; files: string[] } | { result: "dirty"; files: string[] } | { result: "error"; message: string };
  export async function mergeBranch(opts: { repoDir: string; branch: string; message: string; into?: string }): Promise<MergeResult>;
  ```
- Rules: `into` defaults to `defaultBranch`; if `git status --porcelain` non-empty → `dirty`; if current branch ≠ `into` → `git checkout <into>`; `git merge --no-ff -m <message> <branch>`; on conflict collect `git diff --name-only --diff-filter=U`, run `git merge --abort`, return `conflict`; "Already up to date" → `up-to-date`. CLI exit codes: merged/up-to-date 0, conflict 2, dirty 3, error 1; prints JSON.

- [ ] **Step 1: Write the failing test** — repo with `main` (commit A) and branch `feat` (commit B touching `f.txt`): merge → `merged`, `git rev-list --parents -n1 main` has 2 parents, commit subject equals message; merging again → `up-to-date`; conflicting branch (both sides edit `f.txt` line 1) → `conflict` with `files` `["f.txt"]`, and afterwards `git status --porcelain` is empty and `git rev-parse main` unchanged; dirty tree (untracked+modified tracked file) → `dirty`, no merge performed.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Step 5: Commit** — `git commit -m "feat(bin): factory-merge no-ff merge with conflict abort"`

---

### Task 9: `bin/factory-dashboard` shim placeholder

**Files:**
- Create: `bin/factory-dashboard`
- Test: covered by Task 4's executable check extended: add `bin/factory-dashboard` to the list in `tests/plugin/hooks.test.ts` → rename that test file to `tests/plugin/bin.test.ts` asserting every file in `bin/` is executable and starts with `#!/bin/sh`.

**Interfaces:**
- Produces: `#!/bin/sh` / `exec bun "$(dirname "$0")/../dashboard/src/daemon.ts" "$@"`; until the dashboard plan lands, `start|status` must not crash the orchestrator: the shim first checks `[ -f "$(dirname "$0")/../dashboard/src/daemon.ts" ] || { echo '{"running":false,"reason":"dashboard not built"}'; exit 0; }`.

- [ ] **Step 1: Extend the test; run → FAIL. Step 2: Write the shim; `chmod +x`. Step 3: Run → PASS. Step 4: Commit** — `git commit -m "feat(bin): factory-dashboard shim"`

---

### Task 10: Content harness for skills, agents, stages, references

**Files:**
- Create: `tests/plugin/content.test.ts`, `tests/plugin/frontmatter.ts` (tiny YAML-ish frontmatter parser: `---` block, `key: value`, arrays as comma lists / `- item`)
- Test: itself.

**Interfaces:**
- Produces: `parseFrontmatter(md: string): { data: Record<string, string | string[] | boolean>; body: string }`.
- Harness rules (each a `test`):
  1. `skills/<dir>/SKILL.md`: frontmatter `name === dir`, non-empty `description`; the set of dirs equals the 12 skills (this assertion is skipped with `test.skipIf(!existsSync("skills/run"))` until Task 12 lands, then unskipped there).
  2. Alias skills (every skill except `run`): `disable-model-invocation` is `true` and body contains `factory:run`.
  3. `agents/<name>.md`: `name === filename`, `description`, `model ∈ {fable,opus,sonnet,haiku,inherit}`, `tools` present, no `hooks|mcpServers|permissionMode` keys, no `mcp__` substring anywhere in the file; the set equals the 10 agents (skipIf until Task 14).
  4. Every `${CLAUDE_PLUGIN_ROOT}/<rel>` in `skills/**/SKILL.md` and `agents/*.md` → `existsSync(rel)`; every `$PLUGIN_ROOT/<rel>` in `skills/run/**/*.md` → exists.
  5. `skills/run/SKILL.md` mentions `stages/<s>.md` for each of the 11 stages and each file exists (skipIf until Task 12).
  6. Label drift: collect `#([a-z][A-Za-z0-9]*)` tokens from `skills/run/stages/*.md`, `skills/run/references/{sop,agent-protocol,execute-loop}.md`, `agents/*.md`, excluding an allowlist (`#!`, numbers handled by regex); each must occur in `skills/run/references/trilium-schema.md`.
  7. Size budgets: `skills/run/SKILL.md` ≤ 16 000 chars; each `references/*.md` ≤ 24 000 chars; each `stages/*.md` ≤ 16 000 chars; each `agents/*.md` ≤ 8 000 chars.

- [ ] **Step 1: Write `frontmatter.ts` with a unit test** (`tests/plugin/frontmatter.test.ts`: parses `name`, boolean `disable-model-invocation: true`, comma list `tools: Read, Grep`).
- [ ] **Step 2: Write `content.test.ts` with the rules above; run `bun test tests/plugin` → PASS (rules over empty sets pass; set-equality rules skipped).**
- [ ] **Step 3: Commit** — `git commit -m "test: content harness for skills/agents/stages"`

---

### Task 11: References and templates

**Files:**
- Create: `skills/run/references/trilium-schema.md`, `skills/run/references/sop.md`, `skills/run/references/agent-protocol.md`, `skills/run/references/execute-loop.md`, `skills/run/templates/{goal,examination,standards,enforcement-plan,overview,uiux-spec,api-design,task-spec,build-report,review,approval,validation,human-decision}.md`
- Test: harness (Task 10) + add to `content.test.ts`: templates set equals the 13 names; each template starts with a `# ` title line and contains the HTML comment `<!-- factoryDoc: <kind> -->` on line 2.

**Interfaces:**
- `trilium-schema.md` is the single source of truth for: the hierarchy tree from the spec, a **Labels** table (name, where, values), the **Canonical searches** list, note-type rules (`text` notes written in Markdown via `mcp__trilium__create_note`/`set_note_content`; machine state only in labels), and the **Agent Run note** convention (title `<ISO ts> <agentType> <agentId>`).
- `sop.md`: the eight SOP bullets from the spec, each as a `### ` heading with 3–8 lines; plus "Context hygiene after compaction" (re-read `.factory/state.json`, then `get_attributes` of the task note; Trilium wins).
- `agent-protocol.md`: dispatch brief format (`Task: … [task:<noteId>]` / `Read first:` / `Inputs:` / `Write:` / `Return:`), the exact JSON contracts for all 10 agents (copy the table from the spec as fenced JSON examples), guardrails list, the graphify paragraph (verbatim, reused in every agent file), and parsing rule: "take the LAST fenced ```json block of the agent's final message".
- `execute-loop.md`: the state table from the spec plus the `.factory/state.json` schema: `{"workstream","task":{"id","noteId"},"phase":"SELECT|SPEC|BUILD|REVIEW|FIX|APPROVE|MERGE|DONE|NEEDS-HUMAN","round","base","head","agents":{"builder":"<agentId>"},"updatedAt"}` and the exact `factory-*` commands per state.
- Templates are Markdown skeletons with `{{placeholders}}` the orchestrator fills; `review.md` embeds the review JSON contract; `task-spec.md` has sections `Goal`, `Acceptance criteria`, `Files`, `Interfaces`, `Steps`, `Out of scope`.

- [ ] **Step 1: Extend harness with the template rule; run → FAIL (no templates).**
- [ ] **Step 2: Write the four references and 13 templates.**
- [ ] **Step 3: Run `bun test tests/plugin` → PASS (label-drift rule now has real inputs; fix any undeclared label by adding it to the schema or correcting the typo).**
- [ ] **Step 4: Commit** — `git commit -m "docs(run): trilium schema, SOPs, agent protocol, execute loop, templates"`

---

### Task 12: Orchestrator skill `skills/run/SKILL.md` + 11 alias skills

**Files:**
- Create: `skills/run/SKILL.md`, `skills/{setup,examine,set-standards,enforce-standards,brainstorm,uiux,api-design,plan,validate,execute,graph}/SKILL.md`
- Test: harness rules 1, 2, 5 (unskip set-equality for skills).

**Interfaces:**
- `run` frontmatter: `name: run`, `description: Factory orchestrator — run the pipeline, show status, or approve/reject a task`, `argument-hint: "[status|approve <task>|reject <task> \"notes\"|<stage>] [--workstream <slug>]"`, `allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Agent, SendMessage, AskUserQuestion, WebSearch, WebFetch, Skill, mcp__trilium`.
- Body sections in order: **Preflight** (`` !`"${CLAUDE_PLUGIN_ROOT}/bin/factory-preflight" 2>/dev/null || echo '{"error":"preflight failed"}'` `` and `Plugin root: ${CLAUDE_PLUGIN_ROOT}` — tells the model `$PLUGIN_ROOT` in stage files means this path); **Arguments** (`$ARGUMENTS` grammar, `$0 $1 $2`); **Ensure setup**; **Dashboard**; **Stage state and prerequisites** (the prerequisite table); **Dispatch** (Read `$PLUGIN_ROOT/skills/run/stages/<stage>.md`, always Read `references/sop.md` first, and `references/trilium-schema.md` before any Trilium write); **status**; **approve/reject** (delegates to `stages/execute.md` sections "Human approve" / "Human reject").
- Alias skills: `name: <stage>`, `description: Factory stage: <one line>`, `disable-model-invocation: true`, `argument-hint` where relevant; body: `Invoke the Skill tool with skill \`factory:run\` and args \`<stage> $ARGUMENTS\`. Do nothing else.`

- [ ] **Step 1: Unskip the skill-set and stage-reference rules; run → FAIL.**
- [ ] **Step 2: Write `skills/run/SKILL.md` (≤ 16 000 chars) and the 11 aliases.**
- [ ] **Step 3: Run harness → PASS; `claude plugin validate . --strict` → 0; `claude --plugin-dir . -p '/help'` is not scriptable — instead start `claude --plugin-dir .` interactively once and confirm `/factory:run` appears in the slash menu.**
- [ ] **Step 4: Commit** — `git commit -m "feat(skills): run orchestrator and stage aliases"`

---

### Task 13: Stages `setup.md` and `graph.md`

**Files:**
- Create: `skills/run/stages/setup.md`, `skills/run/stages/graph.md`
- Test: harness rule 5 (files exist), rule 6 (labels), rule 7 (size).

**Interfaces:**
- `setup.md` is the idempotent checklist from the spec's "Stage notes → setup" with these exact commands: Trilium register `claude mcp add --scope user --transport http trilium "<triliumUrl>/mcp" --header "Authorization: Bearer <etapiToken>"` (replace existing with `claude mcp remove trilium -s user` first when the URL/token changed); version check `curl -s -H "Authorization: <token>" <url>/etapi/app-info`; uv `curl -LsSf https://astral.sh/uv/install.sh | sh`; `uv tool install graphifyy`; `graphify install`; `graphify hook install`; bun install command from Task 1; superpowers check via preflight `tools.superpowers`; Trilium notes via `mcp__trilium__search_notes` for `#factoryRoot` / `#factoryProject #repoPath='<abs>'`, create with `mcp__trilium__create_note` (type `text`, Markdown body from `templates/`), labels via `mcp__trilium__set_attribute`; `.factory/` + `.gitignore`; `factory-dashboard start`; final `set_attribute stageSetup=done` and `append_to_note` to Factory Log. Each step states its check, its fix, and what to tell the user before installing anything. Ends with "If `mcp__trilium__*` tools were not available in this session, tell the user to run `/mcp` → reconnect (or restart Claude Code) and re-run `/factory:run`; stop."
- `graph.md`: per spec "Stage notes → graph".

- [ ] **Step 1: Write both files. Step 2: Harness → PASS. Step 3: Commit** — `git commit -m "feat(stages): setup and graph"`

---

### Task 14: The ten agent definitions

**Files:**
- Create: `agents/spec-writer.md`, `agents/builder.md`, `agents/security-reviewer.md`, `agents/ux-reviewer.md`, `agents/ui-design-reviewer.md`, `agents/code-reviewer.md`, `agents/approver.md`, `agents/codebase-examiner.md`, `agents/standards-researcher.md`, `agents/plan-adversary.md`
- Test: harness rule 3 (unskip set-equality), rule 4, rule 6, rule 7.

**Interfaces:**
- Frontmatter per the spec table: `name`, `description` (one line, starts with "Factory <role>:"), `model`, `tools` (comma list), `disallowedTools` for reviewers (`Write, Edit, NotebookEdit, Agent`) and builder (`Agent`), `maxTurns` (builder 200, reviewers 60, others 80).
- Body skeleton for every agent: `## Role`, `## Inputs` (paths given in the dispatch brief), `## Procedure` (numbered), `## Guardrails`, `## Codebase navigation` (the graphify paragraph verbatim from `agent-protocol.md`), `## Output contract` (≤ 15 lines then exactly one fenced ```json block, last thing in the message; the JSON shape copied from `agent-protocol.md`).
- Reviewer-specific: severity rubric (`critical` = security hole/data loss/spec violation that ships broken behaviour; `important` = bug or standards breach a user would hit; `minor` = style/nit); `verdict: CHANGES` iff any critical/important finding; re-review mode when `open findings` input present → fill `addressed[]`.
- Builder: `cd <worktree>` first; TDD per Standards; run `#lintCmd`/`#testCmd` before reporting; commit with conventional messages; never touch `main`, never merge, never leave the worktree; append the Build Report file.

- [ ] **Step 1: Unskip agent-set rule; run → FAIL. Step 2: Write the ten files (≤ 8 000 chars each). Step 3: Harness → PASS; `claude plugin validate . --strict` → 0. Step 4: Model check: in a throwaway session with `claude --plugin-dir .`, ask Claude to spawn `factory:ux-reviewer` on a trivial prompt, then `cat ~/.claude/projects/<slug>/<session>/subagents/agent-*.meta.json` and confirm `model`/`pickedEffortModel` reflects sonnet (not the global `CLAUDE_CODE_SUBAGENT_MODEL`). Record the outcome in README "Known caveats".**
- [ ] **Step 5: Commit** — `git commit -m "feat(agents): spec-writer, builder, four reviewers, approver, helpers"`

---

### Task 15: Stages `examine.md`, `set-standards.md`, `enforce-standards.md`

**Files:**
- Create: `skills/run/stages/examine.md`, `skills/run/stages/set-standards.md`, `skills/run/stages/enforce-standards.md`
- Test: harness.

**Interfaces:**
- Each stage file has the same skeleton: `# Stage: <name>`, `## Prerequisites` (labels checked, exact `get_attributes` call), `## Procedure` (numbered; every user interaction is an explicit AskUserQuestion step with the options listed; every Trilium write names the tool, note title, parent, template and labels), `## Completion` (labels set, Factory Log line, `factory-event stage --stage <x> --status done`), `## Direct-command behaviour` (what differs when entered via `/factory:<stage>` — usually "ask whether to re-run; if re-running, bump nothing, overwrite the doc content, keep labels").
- `examine.md`: greenfield detection = no tracked source files (`git ls-files | grep -vE '^(\.|docs/|README)' | head -1` empty); greenfield flow (3 AskUserQuestion rounds max: what/why/for whom; constraints; success criteria) then `standards-researcher` dispatch to validate the named technologies exist at the stated versions; brownfield flow dispatches `codebase-examiner` with `[task:none]`, writes `Codebase Examination` from template, then asks the goal. Both end with Goal doc + `#projectKind` + `stageExamine=done` and an approval question.
- `set-standards.md`: dispatch `standards-researcher`; question rounds per area (runtimes/versions, API docs, CI platform, artifacts, pipelines, public docs, other); brownfield pre-fills from examination; write Standards from template; set machine labels `#lintCmd #testCmd #buildCmd #ciPlatform` on the Standards note (values are shell commands); approval.
- `enforce-standards.md`: compute desired scaffolding vs present (table), write Enforcement Plan doc with `#approval=pending`, AskUserQuestion `Approve / Edit / Skip stage`; on approve apply files, run `#lintCmd` and `#testCmd` (tolerate "no tests yet"), commit on `main` (`chore: enforce standards`), `#appliedSha`, `stageEnforce=done`; on skip `stageEnforce=skipped`.

- [ ] **Step 1: Write the three files. Step 2: Harness → PASS. Step 3: Commit** — `git commit -m "feat(stages): examine, set-standards, enforce-standards"`

---

### Task 16: Stages `brainstorm.md`, `uiux.md`, `api-design.md`, `plan.md`, `validate.md`

**Files:**
- Create: the five stage files.
- Test: harness.

**Interfaces:**
- `brainstorm.md`: ask slug (validate with `factory-worktree ensure --dry-run`? no — validate with the regex from Global Constraints and reject with the reason) + overview; create `Workstreams/<slug>` note (+ `#factoryWorkstream #slug #branch #worktree #wsStatus=brainstorm`), `Overview` doc; `factory-worktree ensure <slug>`; `factory-config set activeWorkstream <slug> --repo .`; invoke Skill `superpowers:brainstorming` with this preamble (verbatim in the file): "Preference: do NOT write `docs/superpowers/specs` or `docs/superpowers/plans` files. When the design is approved, give the full design document back to me in a single message; I store it in Trilium. Context documents: `.factory/workstreams/<slug>/docs/goal.md`, `standards.md`, `overview.md`." After the design is returned: `create_note` `Spec` (`#factoryDoc=spec #approval=approved`), export to `.factory/workstreams/<slug>/docs/spec.md`; then invoke `superpowers:writing-plans` with the same preference; store `Plan` (`#planRev=1`), export `plan.md`; `stageBrainstorm=done`, `#wsStatus=design`.
- `uiux.md`, `api-design.md`: applicability decision first (AskUserQuestion with "Skip" option; `skipped` label on skip); mockup files to `.factory/mockups/<slug>/option-<n>.html` + `index.html` linking them; tell the user the URL `http://127.0.0.1:<port>/mockups/<repoSlug>/<slug>/`.
- `plan.md`: produce milestones/tasks with `#taskId=T-NNN` (zero-padded, globally unique within the workstream), `#order`, `#milestoneId=M<n>`, `#dependsOn` (comma list of task ids or empty), `#status=todo`, `#round=0`; task note body from `templates/task-spec.md` sections `Goal`, `Acceptance criteria`, `Files`, `Out of scope` (the spec-writer fills `Interfaces`/`Steps` later); realign procedure when tasks exist; approval; `stagePlan=done`, `#planRev` bump on realign, `#wsStatus=planned`.
- `validate.md`: dispatch six `plan-adversary` agents in ONE message with lenses `feasibility, missing-requirements, security, ux, sequencing, standards`; each gets `[task:none]`, the doc exports and the task list export (`.factory/workstreams/<slug>/tasks.md` written by the orchestrator from Trilium); write `Validation/Round N` note + six child notes; `pass` iff no `FAIL`; on fail: present findings, AskUserQuestion `Fix plan now (go to plan stage) / Accept risk and pass / Stop`; on pass `stageValidate=pass`, `#validatedPlanRev=<planRev>`, `#wsStatus=validated`.

- [ ] **Step 1: Write the five files. Step 2: Harness → PASS. Step 3: Commit** — `git commit -m "feat(stages): brainstorm, uiux, api-design, plan, validate"`

---

### Task 17: Stage `execute.md` (loop + human gate)

**Files:**
- Create: `skills/run/stages/execute.md`
- Test: harness + add rule: `execute.md` mentions every phase name from `execute-loop.md` (`SELECT SPEC BUILD REVIEW FIX APPROVE MERGE DONE NEEDS-HUMAN FINISH`) and every `factory-*` command (`factory-worktree`, `factory-review-package`, `factory-merge`, `factory-event`, `factory-config`).

**Interfaces:**
- Sections: `## Preconditions`, `## Ledger` (read/write `.factory/state.json` at every transition, schema from `execute-loop.md`), one `## <PHASE>` section per state with: the exact Trilium writes (tool, note, labels), the exact dispatch brief (from `agent-protocol.md`) including `[task:<noteId>]`, the exact bin command, the JSON-parse rule and the transition table; `## REVIEW` states "send the four Agent calls in a single assistant message, `run_in_background: false`, and do not proceed until all four results are in"; `## FIX` uses `SendMessage` to `state.agents.builder` with a consolidated findings list (critical+important only, grouped by file), falling back to a fresh builder dispatch when SendMessage errors; `## Human approve` (`/factory:run approve T-001`: require `#status=needs-human`, write Human Decision note, go to MERGE); `## Human reject` (write note, `#round=0`, go to FIX with the notes as findings); `## Loop control` (after DONE go to SELECT; stop on NEEDS-HUMAN, on FINISH, or when the user interrupts; print a one-line status after every transition).

- [ ] **Step 1: Add the harness rule; run → FAIL. Step 2: Write `execute.md` (≤ 16 000 chars). Step 3: Harness → PASS. Step 4: Commit** — `git commit -m "feat(stages): execute loop with human gate"`

---

### Task 18: README, design-doc link, first smoke run

**Files:**
- Modify: `README.md` (install via `/plugin marketplace add` + `/plugin install factory`, or `claude --plugin-dir`; prerequisites; Trilium MCP enablement steps; command list; "Known caveats"; development: `bun test`, `claude plugin validate . --strict`)
- Test: `bun test` (all), `claude plugin validate . --strict`.

- [ ] **Step 1: Write README.** 
- [ ] **Step 2: Run `bun test` and `claude plugin validate . --strict` → both pass.**
- [ ] **Step 3: Smoke run (needs the user's Trilium URL + token):** `mkdir /private/tmp/claude-501/-Users-kemo-Development-claude-sf/2548a053-b004-4686-b5d1-629fe496d578/scratchpad/factory-smoke && cd … && git init -b main && claude --plugin-dir /Users/kemo/Development/claude-sf`, then `/factory:run` → setup completes, `ClaudeProjects/factory-smoke` exists in Trilium with `#factoryProject`, `/mcp` shows `trilium`. Record any failure as a bug and fix before continuing to the dashboard plan's end-to-end run.
- [ ] **Step 4: Commit** — `git commit -m "docs: README and smoke-run notes"`
