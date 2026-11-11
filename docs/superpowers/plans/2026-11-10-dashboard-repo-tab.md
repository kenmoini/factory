# Dashboard Repo Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Repo" tab to the factory dashboard that draws the registered repo's branches, worktrees and commits as a rail graph and opens a commit drawer from the right, fed by local git through a polling reader and the existing SSE stream.

**Architecture:** A read-only `GitReader` (Bun.spawn around git plumbing) feeds a `GitPoller` per registered repo that publishes a `repo` stream event when refs, worktree heads or dirty counts change; two JSON routes serve the snapshot and a commit's detail. On the web side a pure lane-layout module turns the commit list into rows and links, `Repo.tsx` renders the rail and rows, and `CommitDrawer.tsx` mirrors the existing task drawer. One plugin-side line makes builders write a `Task: <slug>/<taskId>` git trailer so commits join to board tasks.

**Tech Stack:** Bun ≥ 1.2.10, TypeScript, React 19 (TSX bundled by `Bun.serve` HTML imports), hand-written SVG, `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-10-dashboard-repo-tab-design.md` (mockup `dashboard/mockup/repo.html`)

## Global Constraints

- No new runtime or dev dependencies in `dashboard/package.json`.
- git is run without a shell: `Bun.spawn(["git", "--no-pager", "-c", "core.quotepath=false", ...args], { cwd })` with env `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, a 10 000 ms timeout and an 8 MiB output cap; git ≥ 2.22 (the `%(trailers:…,separator=…)` format).
- Every git path comes from `git worktree list`; every sha from the client matches `/^[0-9a-f]{7,40}$/`; every branch name from the client must equal one the snapshot lists.
- New routes take `?repo=<path>` and answer 404 for a repo that is not registered, exactly like `/api/state`.
- The web app keeps the existing design tokens and class vocabulary of `dashboard/web/styles.css`; `dashboard/mockup/repo.html` is the visual contract.
- Tests never touch the network; git tests build temp repos under `tmpdir()` with `git -c user.name=t -c user.email=t@t`.
- Pushed snapshots are always the default view (all branches, limit 100); the view (branch filter, limit) is client state.
- Task ids repeat across workstreams: every task reference carries its slug (`Task: <slug>/<taskId>` trailer, `Merge <slug>: <taskId> …` subject).
- Run `cd dashboard && bun test` and `bunx tsc --noEmit -p dashboard/tsconfig.json` before every commit; both must be clean. Plugin files (`agents/*.md`, `tests/plugin`) are checked with `bun test tests/plugin` from the repo root.

## Review Focus

1. **Odd refs and worktrees:** an annotated tag (its `%(objectname)` is the tag object, not the commit) and a detached worktree must parse without crashing and never produce a branch named `HEAD`; pinned by Task 1 (`parseRefs` peels annotated tags, `parseWorktrees` keeps `detached`) and Task 2 (temp repo with an annotated tag).
2. **Paths with spaces and renames:** `git worktree list --porcelain` and `--numstat` output with spaces, and numstat rename forms `old => new` / `dir/{a => b}/f.ts` must keep the full path string and the counts; pinned by Task 1 fixtures.
3. **Malformed trailers:** `Task: T-003` (no slug), `Task: Foo/Bar`, two `Task:` trailers in one message, and a merge subject with the slug but no id must never throw and must yield only well-formed refs; pinned by Task 1 (`taskRefsOf`).
4. **git failures:** a registered directory that is not a git repository, a git binary that is missing, and a command that times out must end as `snapshot.error` with the poller still polling, the route still answering 200 with the error, and the panel showing a message; pinned by Tasks 2, 3, 4 and 7.
5. **A selected commit that disappears** (log rewritten, branch filter changed, a push arriving while a non-default view is shown) must leave the drawer on "commit no longer in the log" with a close button and never an unhandled fetch error; pinned by Tasks 5 and 8.

---

## File Structure

```
dashboard/src/shared/types.ts            + RepoWorktree, RepoBranch, TaskRef, RepoCommit, RepoSnapshot, CommitFile, CommitDetail; StreamEvent "repo"
dashboard/src/git/parse.ts               pure parsers: parseRefs, parseWorktrees, parseLog, taskRefsOf, parseStatusCount, parseNumstat, parseAheadBehind, toRepoCommit, fingerprintOf
dashboard/src/git/reader.ts              runGit (Bun.spawn), GitReader (isRepo, refs, worktrees, dirty, aheadBehind, log, detail, snapshot)
dashboard/src/git/poller.ts              GitPoller (start/stop/refresh/snapshot; publishes {type:"repo"})
dashboard/src/config.ts                  + gitPollMs (FACTORY_GIT_POLL_MS, default 5000)
dashboard/src/app.ts                     + gitPollers map, refreshGit, GitReader factory dep, SPA path /repo
dashboard/src/routes/api.ts              + GET /api/repo, GET /api/repo/commits/:sha
dashboard/src/routes/stream.ts           + repo frame on connect
dashboard/src/routes/events.ts           + refreshGit on stage/task/agent events
dashboard/web/lib/store.ts               + repo, selectedCommit, repoView, pendingTask; actions repo, select-commit, repo-view, open-task
dashboard/web/lib/stream.ts              + "repo" in EVENTS
dashboard/web/lib/clock.ts               + formatAgo
dashboard/web/lib/rail.ts                layoutRail (pure)
dashboard/web/components/Repo.tsx        tab panel: toolbar, rows, view refetch, keyboard
dashboard/web/components/Rail.tsx        the SVG rail
dashboard/web/components/CommitDrawer.tsx commit details drawer
dashboard/web/app.tsx                    + Repo tab, panel
dashboard/web/styles.css                 + rail tokens, .repo-panel, .rail, rows, chips
dashboard/test/git-parse.test.ts         parsers on captured fixtures
dashboard/test/git-reader.test.ts        GitReader on a temp repo
dashboard/test/git-poller.test.ts        GitPoller with a fake reader
dashboard/test/rail.test.ts              layoutRail cases
dashboard/test/clock.test.ts             formatAgo
dashboard/test/store.test.ts             + repo actions
dashboard/test/config.test.ts            + gitPollMs
dashboard/test/integration/server.test.ts + /api/repo routes, repo SSE frame, refresh on task event
dashboard/scripts/verify.md              + Repo tab checklist
agents/builder.md                        commit trailer rule
skills/run/references/agent-protocol.md  git guardrail mentions the trailer
tests/plugin/content.test.ts             + trailer assertion
README.md                                + Repo tab line
```

---

### Task 1: Shared types and pure git parsers

**Files:**
- Modify: `dashboard/src/shared/types.ts`
- Create: `dashboard/src/git/parse.ts`
- Test: `dashboard/test/git-parse.test.ts`

**Interfaces:**
- Produces (types.ts):
  ```ts
  export interface RepoWorktree { path: string; dirty: number }
  export interface RepoBranch { name: string; sha: string; isDefault: boolean; ahead: number; behind: number; worktree?: RepoWorktree }
  export interface TaskRef { slug: string; taskId: string }
  export interface RepoCommit { sha: string; short: string; parents: string[]; subject: string; author: string; authorTs: string; branches: string[]; tags: string[]; tasks: TaskRef[]; isMerge: boolean }
  export interface RepoSnapshot { repoPath: string; defaultBranch: string; branches: RepoBranch[]; commits: RepoCommit[]; limit: number; truncated: boolean; fingerprint: string; error?: string }
  export interface CommitFile { path: string; added: number; deleted: number; binary?: boolean }
  export interface CommitDetail { commit: RepoCommit; body: string; files: CommitFile[]; totals: { files: number; added: number; deleted: number }; parents: { sha: string; short: string; subject: string }[] }
  export type StreamEvent = … | { type: "repo"; data: RepoSnapshot };
  ```
- Produces (parse.ts):
  ```ts
  export interface Ref { name: string; sha: string; kind: "branch" | "tag" }
  export interface Worktree { path: string; head: string; branch?: string; detached: boolean; bare: boolean }
  export interface RawCommit { sha: string; parents: string[]; subject: string; author: string; authorTs: string; trailerTasks: string[] }
  export const LOG_FORMAT = "%H%x1f%P%x1f%s%x1f%an%x1f%aI%x1f%(trailers:key=Task,valueonly,separator=%x1d)%x1e";
  export function parseRefs(out: string): Ref[];            // for-each-ref --format='%(refname)%x1f%(objectname)%x1f%(*objectname)' refs/heads refs/tags
  export function parseWorktrees(out: string): Worktree[];  // worktree list --porcelain
  export function parseLog(out: string): RawCommit[];       // records split on \x1e, fields on \x1f, trailers on \x1d
  export function taskRefsOf(subject: string, trailerTasks: string[]): TaskRef[];
  export function parseStatusCount(out: string): number;    // non-empty lines of status --porcelain=v1
  export function parseNumstat(out: string): CommitFile[];  // "added\tdeleted\tpath"; "-" → binary:true, 0/0
  export function parseAheadBehind(out: string): { ahead: number; behind: number }; // "A\tB" from rev-list --left-right --count <branch>...<base>
  export function toRepoCommit(raw: RawCommit, tips: Map<string, { branches: string[]; tags: string[] }>): RepoCommit; // short = sha.slice(0, 7); isMerge = parents.length > 1
  export function fingerprintOf(refs: Ref[], worktrees: { path: string; head: string; dirty: number }[]): string; // Bun.hash of the sorted "name sha" and "path head dirty" lines, as hex
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// dashboard/test/git-parse.test.ts
import { describe, expect, test } from "bun:test";
import { fingerprintOf, LOG_FORMAT, parseAheadBehind, parseLog, parseNumstat, parseRefs, parseStatusCount, parseWorktrees, taskRefsOf, toRepoCommit } from "../src/git/parse";

const SHA_A = "a".repeat(40), SHA_B = "b".repeat(40), SHA_T = "c".repeat(40);

describe("parseRefs", () => {
  test("branches and lightweight tags; annotated tags are peeled to the commit", () => {
    const out = [`refs/heads/main\x1f${SHA_A}\x1f`, `refs/heads/checkout-flow\x1f${SHA_B}\x1f`, `refs/tags/v0.3.0\x1f${SHA_T}\x1f${SHA_A}`, `refs/tags/light\x1f${SHA_B}\x1f`].join("\n") + "\n";
    expect(parseRefs(out)).toEqual([
      { name: "main", sha: SHA_A, kind: "branch" }, { name: "checkout-flow", sha: SHA_B, kind: "branch" },
      { name: "v0.3.0", sha: SHA_A, kind: "tag" }, { name: "light", sha: SHA_B, kind: "tag" },
    ]);
  });
  test("empty output gives no refs", () => { expect(parseRefs("")).toEqual([]); });
});

describe("parseWorktrees", () => {
  test("main worktree, a branch worktree with spaces in its path, a detached one and a bare one", () => {
    const out = `worktree /r/acme shop\nHEAD ${SHA_A}\nbranch refs/heads/main\n\nworktree /r/acme shop/.factory/worktrees/checkout-flow\nHEAD ${SHA_B}\nbranch refs/heads/checkout-flow\n\nworktree /r/other\nHEAD ${SHA_T}\ndetached\n\nworktree /r/bare.git\nbare\n\n`;
    expect(parseWorktrees(out)).toEqual([
      { path: "/r/acme shop", head: SHA_A, branch: "main", detached: false, bare: false },
      { path: "/r/acme shop/.factory/worktrees/checkout-flow", head: SHA_B, branch: "checkout-flow", detached: false, bare: false },
      { path: "/r/other", head: SHA_T, detached: true, bare: false },
      { path: "/r/bare.git", head: "", detached: false, bare: true },
    ]);
  });
});

describe("parseLog", () => {
  test("records with parents, subject, author, date and Task trailers", () => {
    const out = `${SHA_A}\x1f${SHA_B} ${SHA_T}\x1fMerge checkout-flow: T-002 Address form\x1fFactory\x1f2026-11-10T10:00:00+00:00\x1f\x1e\n${SHA_B}\x1f${SHA_T}\x1ffeat(address): validation\x1fbuilder\x1f2026-11-10T09:00:00+00:00\x1fcheckout-flow/T-002\x1dcheckout-flow/T-009\x1e\n`;
    expect(parseLog(out)).toEqual([
      { sha: SHA_A, parents: [SHA_B, SHA_T], subject: "Merge checkout-flow: T-002 Address form", author: "Factory", authorTs: "2026-11-10T10:00:00+00:00", trailerTasks: [] },
      { sha: SHA_B, parents: [SHA_T], subject: "feat(address): validation", author: "builder", authorTs: "2026-11-10T09:00:00+00:00", trailerTasks: ["checkout-flow/T-002", "checkout-flow/T-009"] },
    ]);
  });
  test("root commit has no parents; empty output gives no records", () => {
    expect(parseLog(`${SHA_T}\x1f\x1finit\x1ft\x1f2026-11-10T08:00:00+00:00\x1f\x1e\n`)[0].parents).toEqual([]);
    expect(parseLog("")).toEqual([]);
  });
  test("LOG_FORMAT asks git for exactly those fields", () => {
    expect(LOG_FORMAT).toBe("%H%x1f%P%x1f%s%x1f%an%x1f%aI%x1f%(trailers:key=Task,valueonly,separator=%x1d)%x1e");
  });
});

describe("taskRefsOf", () => {
  test("trailers and merge subjects, deduplicated; malformed values ignored", () => {
    expect(taskRefsOf("Merge checkout-flow: T-002 Address form", ["checkout-flow/T-002", "T-003", "Foo/Bar", "billing-api/T-005 "]))
      .toEqual([{ slug: "checkout-flow", taskId: "T-002" }, { slug: "billing-api", taskId: "T-005" }]);
    expect(taskRefsOf("Merge checkout-flow: address", [])).toEqual([]);
    expect(taskRefsOf("feat: x", [])).toEqual([]);
  });
});

describe("parseStatusCount / parseNumstat / parseAheadBehind", () => {
  test("status counts entries", () => { expect(parseStatusCount(" M a.ts\n?? new dir/\n")).toBe(2); expect(parseStatusCount("")).toBe(0); });
  test("numstat keeps spaces and rename forms; binary files are flagged", () => {
    expect(parseNumstat("140\t2\tsrc/checkout/payment.ts\n3\t1\tdocs/my file.md\n0\t0\tsrc/{old => new}/x.ts\n-\t-\tlogo.png\n")).toEqual([
      { path: "src/checkout/payment.ts", added: 140, deleted: 2 }, { path: "docs/my file.md", added: 3, deleted: 1 },
      { path: "src/{old => new}/x.ts", added: 0, deleted: 0 }, { path: "logo.png", added: 0, deleted: 0, binary: true },
    ]);
  });
  test("ahead/behind", () => { expect(parseAheadBehind("2\t0\n")).toEqual({ ahead: 2, behind: 0 }); expect(parseAheadBehind("")).toEqual({ ahead: 0, behind: 0 }); });
});

describe("toRepoCommit / fingerprintOf", () => {
  test("tips become chips; short sha; merge flag; tasks from subject and trailers", () => {
    const raw = { sha: SHA_A, parents: [SHA_B, SHA_T], subject: "Merge checkout-flow: T-002 Address form", author: "Factory", authorTs: "2026-11-10T10:00:00+00:00", trailerTasks: [] };
    const c = toRepoCommit(raw, new Map([[SHA_A, { branches: ["main"], tags: ["v0.3.0"] }]]));
    expect(c).toEqual({ sha: SHA_A, short: "aaaaaaa", parents: [SHA_B, SHA_T], subject: raw.subject, author: "Factory", authorTs: raw.authorTs, branches: ["main"], tags: ["v0.3.0"], tasks: [{ slug: "checkout-flow", taskId: "T-002" }], isMerge: true });
    expect(toRepoCommit({ ...raw, parents: [SHA_B] }, new Map()).branches).toEqual([]);
  });
  test("fingerprint changes with refs, heads and dirty counts, and is order-independent", () => {
    const refs = [{ name: "main", sha: SHA_A, kind: "branch" as const }, { name: "cf", sha: SHA_B, kind: "branch" as const }];
    const wt = [{ path: "/r", head: SHA_A, dirty: 0 }];
    const fp = fingerprintOf(refs, wt);
    expect(fp).toMatch(/^[0-9a-f]+$/);
    expect(fingerprintOf([refs[1], refs[0]], wt)).toBe(fp);
    expect(fingerprintOf(refs, [{ path: "/r", head: SHA_A, dirty: 3 }])).not.toBe(fp);
    expect(fingerprintOf([refs[0]], wt)).not.toBe(fp);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd dashboard && bun test test/git-parse.test.ts`
Expected: FAIL (`Cannot find module "../src/git/parse"`).

- [ ] **Step 3: Add the types to `dashboard/src/shared/types.ts`** (the Interfaces block above, with one doc comment per interface in the file's style) and extend `StreamEvent` with `{ type: "repo"; data: RepoSnapshot }`.

- [ ] **Step 4: Implement `dashboard/src/git/parse.ts`**

Rules the tests pin: `parseRefs` strips `refs/heads/` / `refs/tags/`, uses the third field (peeled) when non-empty; `parseWorktrees` splits on blank lines, a block with `bare` has `head: ""`; `parseLog` splits records on `\x1e`, trims, skips empty, splits parents on spaces (filtering empties) and trailers on `\x1d`; `taskRefsOf` matches trailer values against `/^([a-z0-9][a-z0-9-]*)\/(T-\d{3,})$/` after `trim()` and the subject against `/^Merge ([a-z0-9][a-z0-9-]*): (T-\d{3,})\b/`, deduplicating on `slug/taskId` in first-seen order (subject first); `parseNumstat` splits each line on the first two tabs only, so a path may contain tabs or ` => `; `fingerprintOf` sorts the lines and hashes with `Bun.hash` → `.toString(16)`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd dashboard && bun test test/git-parse.test.ts && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS, tsc clean.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/shared/types.ts dashboard/src/git/parse.ts dashboard/test/git-parse.test.ts
git commit -m "feat(dashboard): repo snapshot types and git output parsers"
```

---

### Task 2: GitReader on a real repository

**Files:**
- Create: `dashboard/src/git/reader.ts`
- Test: `dashboard/test/git-reader.test.ts`

**Interfaces:**
- Consumes: everything in `parse.ts` (Task 1).
- Produces:
  ```ts
  export type GitRunner = (args: string[], cwd: string, opts?: { timeoutMs?: number }) => Promise<{ code: number; out: string; err: string }>;
  export const GIT_TIMEOUT_MS = 10_000; export const GIT_MAX_OUT = 8 * 1024 * 1024;
  export const runGit: GitRunner;   // Bun.spawn per the Global Constraints; timeout → kill + code 124; output over the cap → code 125; spawn failure (no git) → code 127 with err = message
  export class GitError extends Error { constructor(message: string, readonly code: number) }
  export class GitReader {
    constructor(readonly repoPath: string, private run: GitRunner = runGit) {}
    isRepo(): Promise<boolean>;                                  // rev-parse --is-inside-work-tree === "true"
    refs(): Promise<Ref[]>;
    worktrees(): Promise<Worktree[]>;
    dirty(worktreePath: string): Promise<number>;                // status --porcelain=v1 in that worktree
    aheadBehind(branch: string, base: string): Promise<{ ahead: number; behind: number }>;
    log(opts: { limit: number; branch?: string }): Promise<{ commits: RawCommit[]; truncated: boolean }>; // log --date-order -n <limit+1> --format=<LOG_FORMAT> (--branches | <branch> --)
    detail(sha: string): Promise<CommitDetail | null>;           // null when `git rev-parse --verify <sha>^{commit}` fails
    snapshot(opts?: { limit?: number; branch?: string }): Promise<RepoSnapshot>; // never throws: a GitError becomes { ...empty, error }
    static defaultBranch(refs: Ref[]): string;                   // "main" if present, else "master", else the first branch name, else "main"
  }
  ```
  `snapshot`: refs → default branch → worktrees (skip bare and detached entries for branch binding, but a detached worktree still counts nowhere) → for each branch: sha from refs, `worktree` when a worktree's `branch` equals it (`dirty` from `dirty(path)`), `ahead`/`behind` from `aheadBehind(name, default)` for non-default branches (0/0 for the default) → log (limit default 100; `truncated` = more than `limit` records came back; the extra record is dropped) → `toRepoCommit` with a tips map built from refs → `fingerprintOf(refs, worktrees with dirty)`. `detail`: `log -n1 --format=<LOG_FORMAT> <sha> --` for the commit, `show -s --format=%b <sha>` for the body (trimmed), files from `diff --numstat <sha>^1 <sha> --` when it has a parent else `diff-tree -r --root --numstat --no-commit-id <sha>` (merge commits: first-parent diff), `totals` summed, parents via `log -n1 --format=%H%x1f%s <parent> --` each; tips map from `refs()` so the drawer's chips match the list.

- [ ] **Step 1: Write the failing test**

```ts
// dashboard/test/git-reader.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitReader, runGit } from "../src/git/reader";

let root: string, wt: string;
// every commit gets its own increasing timestamp, so --date-order is deterministic
let tick = 0;
const git = (cwd: string, ...args: string[]) => {
  const ts = `2026-11-10T10:${String(tick++).padStart(2, "0")}:00Z`;
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_DATE: ts, GIT_COMMITTER_DATE: ts } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const commit = (cwd: string, file: string, msg: string) => { writeFileSync(join(cwd, file), `${msg}\n`); git(cwd, "add", "-A"); git(cwd, "commit", "-q", "-m", msg); return git(cwd, "rev-parse", "HEAD"); };
/** git prints real paths (`/private/var/…` on macOS), so the fixture paths are resolved the same way. */
const tempDir = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

beforeAll(() => {
  root = tempDir("factory-git-");
  git(root, "init", "-q", "-b", "main");
  commit(root, "a.txt", "chore: enforce standards");
  git(root, "tag", "-a", "v0.1.0", "-m", "first");                       // annotated: must peel to the commit
  wt = join(root, ".factory/worktrees/checkout-flow");
  git(root, "worktree", "add", "-q", "-b", "checkout-flow", wt);
  commit(wt, "b.txt", "feat(cart): summary\n\nTask: checkout-flow/T-001");
  commit(wt, "c.txt", "test(cart): totals\n\nTask: checkout-flow/T-001");
  git(root, "merge", "--no-ff", "-q", "-m", "Merge checkout-flow: T-001 Cart summary", "checkout-flow");
  commit(wt, "d.txt", "feat(address): validation\n\nTask: checkout-flow/T-002");
  writeFileSync(join(wt, "e.txt"), "dirty\n");                            // untracked → dirty 1
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("GitReader", () => {
  test("snapshot: branches, worktree, ahead/behind, dirty, tips, tasks, merge flag", async () => {
    const snap = await new GitReader(root).snapshot();
    expect(snap.error).toBeUndefined();
    expect(snap.defaultBranch).toBe("main");
    const main = snap.branches.find((b) => b.name === "main")!, cf = snap.branches.find((b) => b.name === "checkout-flow")!;
    expect(main).toMatchObject({ isDefault: true, ahead: 0, behind: 0 });
    expect(main.worktree?.path).toBe(root);
    expect(cf).toMatchObject({ isDefault: false, ahead: 1, behind: 1, worktree: { path: wt, dirty: 1 } }); // d ahead; the merge commit behind
    expect(snap.commits.length).toBe(5);
    expect(snap.truncated).toBe(false);
    const merge = snap.commits.find((c) => c.isMerge)!;
    expect(merge.subject).toBe("Merge checkout-flow: T-001 Cart summary");
    expect(merge.branches).toEqual(["main"]);
    expect(merge.tasks).toEqual([{ slug: "checkout-flow", taskId: "T-001" }]);
    expect(snap.commits[0].branches).toEqual(["checkout-flow"]);           // newest: the address commit
    expect(snap.commits[0].tasks).toEqual([{ slug: "checkout-flow", taskId: "T-002" }]);
    expect(snap.commits.at(-1)!.tags).toEqual(["v0.1.0"]);
    expect(snap.fingerprint).toMatch(/^[0-9a-f]+$/);
  });
  test("branch filter and limit", async () => {
    const snap = await new GitReader(root).snapshot({ limit: 2, branch: "checkout-flow" });
    expect(snap.commits.length).toBe(2);
    expect(snap.limit).toBe(2);
    expect(snap.truncated).toBe(true);                                      // d, c shown; b and a left out
    expect(snap.commits.map((c) => c.subject)).toEqual(["feat(address): validation", "test(cart): totals"]);
    expect((await new GitReader(root).snapshot({ limit: 2, branch: "main" })).truncated).toBe(false); // main has exactly two
  });
  test("detail: body, numstat files, totals, parents; unknown sha is null", async () => {
    const r = new GitReader(root);
    const head = (await r.snapshot()).commits[0];
    const d = (await r.detail(head.sha))!;
    expect(d.commit.sha).toBe(head.sha);
    expect(d.body).toBe("Task: checkout-flow/T-002");
    expect(d.files).toEqual([{ path: "d.txt", added: 1, deleted: 0 }]);
    expect(d.totals).toEqual({ files: 1, added: 1, deleted: 0 });
    expect(d.parents[0].subject).toBe("Merge checkout-flow: T-001 Cart summary");
    expect(await r.detail("0".repeat(40))).toBeNull();
    expect(await r.detail(head.sha.slice(0, 7))).not.toBeNull();
  });
  test("not a repository and a missing git binary become snapshot.error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-nogit-"));
    try {
      expect((await new GitReader(dir).snapshot()).error).toMatch(/not a git repository/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    const broken = new GitReader(root, async () => ({ code: 127, out: "", err: "spawn git ENOENT" }));
    expect((await broken.snapshot()).error).toMatch(/ENOENT/);
  });
  test("runGit runs git, and kills a command that outlives its timeout (code 124)", async () => {
    expect((await runGit(["--version"], root)).code).toBe(0);
    // a throwaway repo: the killed `commit --amend` may leave a lock behind
    const dir = tempDir("factory-git-timeout-");
    try {
      git(dir, "init", "-q", "-b", "main"); commit(dir, "a.txt", "init");
      // core.editor runs through sh: `sleep 30 #` ignores the file name git appends and blocks until killed
      const r = await runGit(["-c", "core.editor=sleep 30 #", "commit", "--amend"], dir, { timeoutMs: 300 });
      expect(r.code).toBe(124);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd dashboard && bun test test/git-reader.test.ts`
Expected: FAIL (`Cannot find module "../src/git/reader"`).

- [ ] **Step 3: Implement `dashboard/src/git/reader.ts`** per the Interfaces block. `runGit` reads stdout fully with `await new Response(proc.stdout).text()` while a `setTimeout` kills the process at `GIT_TIMEOUT_MS`; wrap `Bun.spawn` in try/catch for the ENOENT case. Every public method throws `GitError(stderr || "git failed", code)` on a non-zero exit, except `snapshot` (catches and returns the error string) and `detail` (returns `null` only for the unknown-sha check, otherwise throws).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd dashboard && bun test test/git-reader.test.ts test/git-parse.test.ts && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/git/reader.ts dashboard/test/git-reader.test.ts
git commit -m "feat(dashboard): GitReader over git plumbing with a temp-repo test"
```

---

### Task 3: GitPoller and config

**Files:**
- Create: `dashboard/src/git/poller.ts`
- Modify: `dashboard/src/config.ts`
- Test: `dashboard/test/git-poller.test.ts`, `dashboard/test/config.test.ts`

**Interfaces:**
- Consumes: `GitReader.snapshot` (Task 2), `EventHub.publish` (`src/hub.ts`).
- Produces:
  ```ts
  export interface GitPollerDeps { reader: Pick<GitReader, "snapshot">; hub: EventHub }
  export class GitPoller {
    constructor(private repoPath: string, private deps: GitPollerDeps, opts: { intervalMs?: number; limit?: number } = {}) // defaults 5000, 100
    start(): void; stop(): void; snapshot(): RepoSnapshot | null; lastError(): string | null;
    refresh(): Promise<boolean>;   // single-flight like Poller.refresh; true when a new snapshot was published
  }
  ```
  `DashboardConfig` gains `gitPollMs: number` (`FACTORY_GIT_POLL_MS`, default 5000, same `num` rule as `pollMs`).

  Refresh rule: call `reader.snapshot({ limit })`; when `error` is set keep the previous snapshot, store the error, publish nothing, return false; when the fingerprint equals the current one return false; else store, `hub.publish(repoPath, { type: "repo", data })`, return true. The first successful snapshot is always published (no previous fingerprint).

- [ ] **Step 1: Write the failing tests**

```ts
// dashboard/test/git-poller.test.ts
import { describe, expect, test } from "bun:test";
import { GitPoller } from "../src/git/poller";
import { EventHub } from "../src/hub";
import type { RepoSnapshot, StreamEvent } from "../src/shared/types";

const snap = (fingerprint: string, error?: string): RepoSnapshot => ({ repoPath: "/r", defaultBranch: "main", branches: [], commits: [], limit: 100, truncated: false, fingerprint, ...(error ? { error } : {}) });

describe("GitPoller", () => {
  test("publishes on the first snapshot and on fingerprint change only; errors keep the last snapshot", async () => {
    const queue: RepoSnapshot[] = [snap("1"), snap("1"), snap("2"), snap("2", "boom"), snap("3")];
    const calls: unknown[] = [];
    const reader = { snapshot: async (o: unknown) => { calls.push(o); return queue.shift()!; } };
    const hub = new EventHub(); const events: StreamEvent[] = []; hub.subscribe("/r", (e) => events.push(e));
    const p = new GitPoller("/r", { reader, hub }, { limit: 50 });
    expect(await p.refresh()).toBe(true); expect(await p.refresh()).toBe(false); expect(await p.refresh()).toBe(true);
    expect(await p.refresh()).toBe(false); expect(p.lastError()).toBe("boom"); expect(p.snapshot()?.fingerprint).toBe("2");
    expect(await p.refresh()).toBe(true); expect(p.lastError()).toBeNull();
    expect(events.map((e) => e.type)).toEqual(["repo", "repo", "repo"]);
    expect(calls[0]).toEqual({ limit: 50 });
  });
  test("refresh is single-flight and start/stop drive the interval", async () => {
    let n = 0; let release!: () => void;
    const reader = { snapshot: () => new Promise<RepoSnapshot>((res) => { n++; release = () => res(snap(String(n))); }) };
    const p = new GitPoller("/r", { reader, hub: new EventHub() }, { intervalMs: 10 });
    const a = p.refresh(), b = p.refresh();
    expect(n).toBe(1); release(); expect(await a).toBe(true); expect(await b).toBe(true);
    p.start(); await Bun.sleep(35); p.stop(); const seen = n; await Bun.sleep(30);
    expect(seen).toBeGreaterThanOrEqual(2); expect(n).toBe(seen);
    release();
  });
});
```

Add to `dashboard/test/config.test.ts`, in the same style as its `pollMs` assertions: `FACTORY_GIT_POLL_MS=250` → `gitPollMs: 250`; unset → `5000`; `"x"` → `5000`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd dashboard && bun test test/git-poller.test.ts test/config.test.ts`
Expected: FAIL (module missing; `gitPollMs` undefined).

- [ ] **Step 3: Implement `GitPoller` and the config field.** Mirror `Poller` (`src/trilium/poller.ts`): `timer` with `unref`, `inFlight` promise, `start()` runs one refresh immediately.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd dashboard && bun test test/git-poller.test.ts test/config.test.ts && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/git/poller.ts dashboard/src/config.ts dashboard/test/git-poller.test.ts dashboard/test/config.test.ts
git commit -m "feat(dashboard): GitPoller publishes repo snapshots on change; FACTORY_GIT_POLL_MS"
```

---

### Task 4: Routes, app wiring and the SSE frame

**Files:**
- Modify: `dashboard/src/app.ts`, `dashboard/src/routes/api.ts`, `dashboard/src/routes/stream.ts`, `dashboard/src/routes/events.ts`
- Test: `dashboard/test/integration/server.test.ts`

**Interfaces:**
- Consumes: `GitReader`, `GitPoller` (Tasks 2–3); `Ctx`, `routes[]`, `json`, `resolveRepo` in `api.ts`; `StreamDeps` in `stream.ts`; `EventDeps` in `events.ts`.
- Produces:
  - `AppDeps.gitReader?: (repoPath: string) => GitReader` (default `(p) => new GitReader(p)`); `App.gitPollers: Map<string, GitPoller>`.
  - `createApp`: `addRepo` creates `new GitPoller(repoPath, { reader: gitReader(repoPath), hub }, { intervalMs: config.gitPollMs })` after stopping an old one, and starts it; `stop()` stops them; `refreshGit(repoKey)` debounced 250 ms like `refresh`.
  - `Ctx` gains `gitPollers` and `gitReader(repoKey): GitReader`; `EventDeps.refreshGit?: (repoKey: string) => void`, called in the `stage | task | agent` case next to `deps.refresh`.
  - `StreamDeps.repo: (repoKey: string) => RepoSnapshot | null`; the route sends `frame("repo", snap)` right after the Trilium snapshot frame when non-null.
  - Routes (added to `routes[]`):
    - `GET /api/repo`: unknown repo → 404 `{error:"unknown repo"}`; `limit` = `Number(url.searchParams.get("limit"))`, default 100, non-integer or out of 1–500 → 400 `{error:"limit must be 1-500"}`; `branch` (optional) must be in `poller.snapshot()?.branches` names (refresh first when there is no snapshot yet), else 400 `{error:"unknown branch"}`; default view (`limit === 100`, no branch) → the poller's snapshot (`await poller.refresh()` when null); otherwise `await ctx.gitReader(repoKey).snapshot({ limit, branch })`. Always 200 with the `RepoSnapshot` (its `error` field carries git failures).
    - `GET /api/repo/commits/:sha`: unknown repo → 404; sha not matching `/^[0-9a-f]{7,40}$/` → 400 `{error:"invalid sha"}`; `detail` null → 404 `{error:"unknown commit"}`; else 200 `CommitDetail`.
  - `SPA_PATHS` gains `"/repo"`.

- [ ] **Step 1: Write the failing tests** (append to `server.test.ts`, inside its existing `describe`, using `boot`, `readUntil`, `postJson`; create the git repo inside `repoDir` in a new `beforeAll` that runs the same commands as Task 2's test (same dated `git` helper) on `repoDir` itself, which already holds `.factory/config.json`; the existing suite registers repos with `app.addRepo(repoDir)` after `boot()`):

```ts
describe("repo routes", () => {
  test("/api/repo serves the registered repo's snapshot; validates limit and branch; unknown repo is 404", async () => {
    const { base, app } = boot(); app.addRepo(repoDir); const q = encodeURIComponent(repoDir);
    expect((await fetch(`${base}/api/repo?repo=nope`)).status).toBe(404);
    const snap = (await (await fetch(`${base}/api/repo?repo=${q}`)).json()) as any;
    expect(snap.defaultBranch).toBe("main");
    expect(snap.branches.map((b: any) => b.name).sort()).toEqual(["checkout-flow", "main"]);
    expect(snap.commits.length).toBeGreaterThanOrEqual(4);
    expect((await fetch(`${base}/api/repo?repo=${q}&limit=0`)).status).toBe(400);
    expect((await fetch(`${base}/api/repo?repo=${q}&limit=501`)).status).toBe(400);
    expect((await fetch(`${base}/api/repo?repo=${q}&branch=nope`)).status).toBe(400);
    const filtered = (await (await fetch(`${base}/api/repo?repo=${q}&branch=checkout-flow&limit=2`)).json()) as any;
    expect(filtered.commits.length).toBe(2); expect(filtered.truncated).toBe(true); expect(filtered.limit).toBe(2);
  });
  test("/api/repo/commits/:sha serves detail, rejects bad shas, 404s unknown ones", async () => {
    const { base, app } = boot(); app.addRepo(repoDir); const q = encodeURIComponent(repoDir);
    const snap = (await (await fetch(`${base}/api/repo?repo=${q}`)).json()) as any;
    const sha = snap.commits[0].sha;
    const d = (await (await fetch(`${base}/api/repo/commits/${sha}?repo=${q}`)).json()) as any;
    expect(d.commit.sha).toBe(sha); expect(Array.isArray(d.files)).toBe(true); expect(d.totals.files).toBe(d.files.length);
    expect((await fetch(`${base}/api/repo/commits/zzz?repo=${q}`)).status).toBe(400);
    expect((await fetch(`${base}/api/repo/commits/${"0".repeat(40)}?repo=${q}`)).status).toBe(404);
    expect((await fetch(`${base}/api/repo/commits/${sha}?repo=nope`)).status).toBe(404);
  });
  test("the stream sends a repo frame on connect and after a task event that changed git", async () => {
    const { base, app } = boot(); app.addRepo(repoDir); const q = encodeURIComponent(repoDir);
    await app.gitPollers.get(repoDir)!.refresh();
    const ac = new AbortController();
    const res = await fetch(`${base}/api/stream?repo=${q}`, { signal: ac.signal });
    const reader = res.body!.getReader();
    await readUntil(reader, (a) => a.includes("event: repo"), 2000);
    // a new commit on main, then the hook's task event: the poller refreshes and pushes
    writeFileSync(join(repoDir, "z.txt"), "z\n");
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: repoDir });
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "chore: z"], { cwd: repoDir, env: { ...process.env, GIT_AUTHOR_DATE: "2027-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2027-01-01T00:00:00Z" } }); // newer than every fixture commit
    await postJson(`${base}/api/events`, { event: "task", ts: "x", project: repoDir, task: "T-001", status: "done", payload: {} });
    const acc = await readUntil(reader, (a) => a.split("event: repo").length > 2, 3000);
    ac.abort();
    const last = acc.split("\n\n").filter((f) => f.startsWith("event: repo")).at(-1)!;
    expect(JSON.parse(last.slice(last.indexOf("data: ") + 6)).commits[0].subject).toBe("chore: z");
  });
});
```

Also extend the Host-guard test's `paths` array with `` `/api/repo?repo=${q}` `` so the new routes are covered by the 403 check.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd dashboard && bun test test/integration/server.test.ts`
Expected: FAIL on the new tests (404 "not found" for `/api/repo`, `gitPollers` undefined).

- [ ] **Step 3: Implement the wiring and routes** per the Interfaces block. Keep `api.ts` handlers in its existing style (`Handler`, `json`, `resolveRepo`).

- [ ] **Step 4: Run the full dashboard suite**

Run: `cd dashboard && bun test && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS (including the console canary test: no token in any log line).

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/app.ts dashboard/src/routes/api.ts dashboard/src/routes/stream.ts dashboard/src/routes/events.ts dashboard/test/integration/server.test.ts
git commit -m "feat(dashboard): /api/repo and /api/repo/commits routes, repo SSE frame, git poller per repo"
```

---

### Task 5: Store and stream client

**Files:**
- Modify: `dashboard/web/lib/store.ts`, `dashboard/web/lib/stream.ts`
- Test: `dashboard/test/store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RepoView { branch?: string; limit: number }
  export const DEFAULT_REPO_VIEW: RepoView = { limit: 100 };
  // State additions
  repo: RepoSnapshot | null; selectedCommit?: string; repoView: RepoView; pendingTask?: { ws: string; taskId: string };
  // Action additions
  | { type: "select-commit"; data?: string }           // toggles like select-task
  | { type: "repo-view"; data: RepoView }
  | { type: "open-task"; data: { ws: string; taskId: string } }
  ```
  Reducer rules: `repo` → `{ ...state, repo: e.data }`; `select-commit` mirrors `select-task`; `repo-view` → same object when equal (`branch` and `limit` both equal), else `{ ...state, repoView }`; `open-task`: when `state.snapshot?.workstream?.slug === ws` and a task with that `taskId` exists → `{ ...state, tab: "board", selectedTask: task.id, pendingTask: undefined }`; otherwise → `{ ...state, tab: "board", ws, selectedTask: undefined, pendingTask: { ws, taskId } }`; `snapshot` with a `pendingTask` whose `ws` equals `e.data.workstream?.slug` → `selectedTask` = the matching task's id (or undefined when absent) and `pendingTask` cleared; `select-ws` clears `pendingTask` and `selectedCommit`; `select-repo` resets to `initialState` (which now holds `repo: null`, `repoView: DEFAULT_REPO_VIEW`) keeping `tab` as today. `stream.ts`: `EVENTS` gains `"repo"`.

- [ ] **Step 1: Write the failing tests** (append to `test/store.test.ts`; `rsnap(fp)` builds a `RepoSnapshot` like `snap` builds a workstream snapshot):

```ts
describe("repo tab state", () => {
  const rsnap = (fingerprint: string): RepoSnapshot => ({ repoPath: "/w", defaultBranch: "main", branches: [], commits: [], limit: 100, truncated: false, fingerprint });
  const wsSnap = (slug: string, tasks: { id: string; taskId: string }[]) => ({ ...snap("x"), workstream: { id: slug, slug, title: slug, status: "executing", labels: {}, modified: "" },
    tasks: tasks.map((t) => ({ ...t, title: t.taskId, status: "todo" as const, milestoneId: "M1", order: 1, round: 0, dependsOn: [], modified: "" })) });
  test("initial state has no repo snapshot and the default view", () => { expect(initialState.repo).toBeNull(); expect(initialState.repoView).toEqual({ limit: 100 }); });
  test("repo events replace the snapshot; select-commit toggles", () => {
    let s = run([{ type: "repo", data: rsnap("a") }, { type: "repo", data: rsnap("b") }]);
    expect(s.repo?.fingerprint).toBe("b");
    s = reduce(s, { type: "select-commit", data: "abc" }); expect(s.selectedCommit).toBe("abc");
    s = reduce(s, { type: "select-commit", data: "abc" }); expect(s.selectedCommit).toBeUndefined();
    s = reduce(s, { type: "select-commit", data: "abc" }); s = reduce(s, { type: "select-commit" }); expect(s.selectedCommit).toBeUndefined();
  });
  test("repo-view returns the same state for an equal view", () => {
    const s = reduce(initialState, { type: "repo-view", data: { limit: 100 } });
    expect(s).toBe(initialState);
    expect(reduce(s, { type: "repo-view", data: { limit: 200, branch: "main" } }).repoView).toEqual({ limit: 200, branch: "main" });
  });
  test("open-task in the current workstream selects the task on the board", () => {
    const s = reduce({ ...initialState, snapshot: wsSnap("demo", [{ id: "t1", taskId: "T-001" }]), tab: "repo" }, { type: "open-task", data: { ws: "demo", taskId: "T-001" } });
    expect(s).toMatchObject({ tab: "board", selectedTask: "t1" }); expect(s.pendingTask).toBeUndefined();
  });
  test("open-task in another workstream switches and completes on that workstream's snapshot", () => {
    let s = reduce({ ...initialState, snapshot: wsSnap("demo", []), tab: "repo" }, { type: "open-task", data: { ws: "next", taskId: "T-001" } });
    expect(s).toMatchObject({ tab: "board", ws: "next", pendingTask: { ws: "next", taskId: "T-001" } }); expect(s.selectedTask).toBeUndefined();
    s = reduce(s, { type: "snapshot", data: wsSnap("demo", []) });            // a stale push for the old workstream: still pending
    expect(s.pendingTask).toBeDefined();
    s = reduce(s, { type: "snapshot", data: wsSnap("next", [{ id: "tn1", taskId: "T-001" }]) });
    expect(s.selectedTask).toBe("tn1"); expect(s.pendingTask).toBeUndefined();
  });
  test("a pending task missing from its workstream's snapshot is dropped, and select-ws / select-repo clear repo selections", () => {
    let s = reduce({ ...initialState, pendingTask: { ws: "next", taskId: "T-009" } }, { type: "snapshot", data: wsSnap("next", []) });
    expect(s.pendingTask).toBeUndefined(); expect(s.selectedTask).toBeUndefined();
    s = run([{ type: "repo", data: rsnap("a") }, { type: "select-commit", data: "abc" }, { type: "open-task", data: { ws: "n", taskId: "T-001" } }, { type: "select-ws", data: "other" }]);
    expect(s.pendingTask).toBeUndefined(); expect(s.selectedCommit).toBeUndefined();
    s = reduce(s, { type: "select-repo", data: { repo: "/x" } });
    expect(s.repo).toBeNull(); expect(s.repoView).toEqual({ limit: 100 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd dashboard && bun test test/store.test.ts`
Expected: FAIL (`repo` undefined on initial state, unknown actions ignored).

- [ ] **Step 3: Implement the reducer changes and add `"repo"` to `EVENTS` in `stream.ts`.** Update the existing "initial state" assertion in `store.test.ts` to the new shape.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd dashboard && bun test test/store.test.ts && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/web/lib/store.ts dashboard/web/lib/stream.ts dashboard/test/store.test.ts
git commit -m "feat(dashboard): store holds the repo snapshot, commit selection, view and cross-workstream task opening"
```

---

### Task 6: Rail layout and relative time

**Files:**
- Create: `dashboard/web/lib/rail.ts`
- Modify: `dashboard/web/lib/clock.ts`
- Test: `dashboard/test/rail.test.ts`, `dashboard/test/clock.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // rail.ts
  export interface RailRow { sha: string; lane: number }
  export interface RailLink { fromRow: number; toRow: number; fromLane: number; toLane: number; kind: "line" | "merge" | "fork" }
  export interface RailLayout { rows: RailRow[]; links: RailLink[]; lanes: number; laneOf: Record<string, number> }
  export function layoutRail(commits: RepoCommit[], defaultBranch: string): RailLayout;
  // clock.ts
  export function formatAgo(iso: string, now: number): string; // "now" < 60 s, "Nm" < 60 min, "Nh" < 24 h, "Nd" < 7 d, else "YYYY-MM-DD"; invalid date → ""
  ```
  Layout rule (commits newest first): a `reserved` map from sha to lane and an `occupied` set of lanes. Before the loop, reserve lane 0 for the commit whose `branches` includes `defaultBranch`, when it is in the list. For each commit at row `i`: `lane = reserved.get(sha)`, else the lowest lane that is neither occupied nor reserved by another sha; delete the reservation; record `laneOf[sha] = lane`. Then for each parent `p` with index `k`: if `k === 0` and `p` is neither laid out nor reserved → `reserved.set(p, lane)` (the lane stays occupied); if `k > 0` and `p` is neither laid out nor reserved → `reserved.set(p, lowest free lane)`; if `k === 0`, the current lane is 0 and `p` is already reserved in another lane → move that reservation to lane 0 (the other lane frees; the other child's link to `p` becomes a fork), so the default branch's chain never leaves lane 0; otherwise nothing. A lane is occupied while some sha is reserved for it; when the first parent was already reserved elsewhere or does not exist, the lane frees after this row. Links: for every parent `p`: if `p` has a row `j` → `{ fromRow: i, toRow: j, fromLane: laneOf[sha], toLane: laneOf[p], kind }` with `kind = "line"` when the lanes are equal, `"fork"` when `k === 0`, `"merge"` when `k > 0`; if `p` is not in the list → `{ fromRow: i, toRow: commits.length, fromLane: laneOf[sha], toLane: laneOf[sha], kind: "line" }` (a stub to the bottom edge). `lanes` = 1 + max lane used (0 for an empty list).

- [ ] **Step 1: Write the failing tests**

```ts
// dashboard/test/rail.test.ts
import { describe, expect, test } from "bun:test";
import { layoutRail } from "../web/lib/rail";
import type { RepoCommit } from "../src/shared/types";

const c = (sha: string, parents: string[], branches: string[] = []): RepoCommit =>
  ({ sha, short: sha.slice(0, 7), parents, subject: sha, author: "t", authorTs: "2026-11-10T10:00:00Z", branches, tags: [], tasks: [], isMerge: parents.length > 1 });

describe("layoutRail", () => {
  test("empty and linear histories use one lane", () => {
    expect(layoutRail([], "main")).toEqual({ rows: [], links: [], lanes: 0, laneOf: {} });
    const l = layoutRail([c("c3", ["c2"], ["main"]), c("c2", ["c1"]), c("c1", [])], "main");
    expect(l.lanes).toBe(1);
    expect(l.rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(l.links).toEqual([{ fromRow: 0, toRow: 1, fromLane: 0, toLane: 0, kind: "line" }, { fromRow: 1, toRow: 2, fromLane: 0, toLane: 0, kind: "line" }]);
  });
  test("a --no-ff merge: main keeps lane 0, the branch takes lane 1, with fork and merge links", () => {
    const l = layoutRail([c("M", ["m1", "b2"], ["main"]), c("b2", ["b1"], ["cf"]), c("b1", ["m1"]), c("m1", [])], "main");
    expect(l.lanes).toBe(2);
    expect(l.laneOf).toEqual({ M: 0, b2: 1, b1: 1, m1: 0 });
    expect(l.links).toEqual([
      { fromRow: 0, toRow: 3, fromLane: 0, toLane: 0, kind: "line" }, { fromRow: 0, toRow: 1, fromLane: 0, toLane: 1, kind: "merge" },
      { fromRow: 1, toRow: 2, fromLane: 1, toLane: 1, kind: "line" }, { fromRow: 2, toRow: 3, fromLane: 1, toLane: 0, kind: "fork" },
    ]);
  });
  test("two concurrent branches need three lanes and main stays on lane 0 even when it is not the newest commit", () => {
    const l = layoutRail([c("b2", ["b1"], ["cf"]), c("x1", ["m1"], ["billing"]), c("b1", ["m1"]), c("m2", ["m1"], ["main"]), c("m1", [])], "main");
    expect(l.lanes).toBe(3);
    expect(l.laneOf.m2).toBe(0); expect(l.laneOf.m1).toBe(0);
    expect(new Set([l.laneOf.b2, l.laneOf.x1]).size).toBe(2);
  });
  test("a parent outside the list gets a stub link to the bottom edge", () => {
    const l = layoutRail([c("c2", ["c1"], ["main"])], "main");
    expect(l.links).toEqual([{ fromRow: 0, toRow: 1, fromLane: 0, toLane: 0, kind: "line" }]);
  });
  test("300 linear commits stay on one lane", () => {
    const commits = Array.from({ length: 300 }, (_, i) => c(`c${300 - i}`, i < 299 ? [`c${299 - i}`] : [], i === 0 ? ["main"] : []));
    expect(layoutRail(commits, "main").lanes).toBe(1);
  });
});
```

```ts
// dashboard/test/clock.test.ts
import { describe, expect, test } from "bun:test";
import { formatAgo, formatElapsed } from "../web/lib/clock";
const now = Date.parse("2026-11-10T12:00:00Z");
describe("formatAgo", () => {
  test("buckets", () => {
    expect(formatAgo("2026-11-10T11:59:30Z", now)).toBe("now");
    expect(formatAgo("2026-11-10T11:48:00Z", now)).toBe("12m");
    expect(formatAgo("2026-11-10T09:00:00Z", now)).toBe("3h");
    expect(formatAgo("2026-11-08T12:00:00Z", now)).toBe("2d");
    expect(formatAgo("2026-10-01T12:00:00Z", now)).toBe("2026-10-01");
    expect(formatAgo("nope", now)).toBe("");
  });
  test("formatElapsed still works", () => { expect(formatElapsed(61_000)).toBe("01:01"); });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd dashboard && bun test test/rail.test.ts test/clock.test.ts`
Expected: FAIL (module missing; `formatAgo` not exported).

- [ ] **Step 3: Implement `layoutRail` and `formatAgo`** per the rules above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd dashboard && bun test test/rail.test.ts test/clock.test.ts && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/web/lib/rail.ts dashboard/web/lib/clock.ts dashboard/test/rail.test.ts dashboard/test/clock.test.ts
git commit -m "feat(dashboard): rail lane layout and relative time formatting"
```

---

### Task 7: Repo tab panel, rail and rows

**Files:**
- Create: `dashboard/web/components/Repo.tsx`, `dashboard/web/components/Rail.tsx`
- Modify: `dashboard/web/app.tsx`, `dashboard/web/styles.css`

**Interfaces:**
- Consumes: `layoutRail`, `formatAgo` (Task 6); store state and actions (Task 5); `RepoSnapshot` (Task 1); `/api/repo` (Task 4).
- Produces:
  ```tsx
  // Repo.tsx
  export function Repo({ repoPath, snapshot }: { repoPath: string | undefined; snapshot: WorkstreamSnapshot | null }): JSX.Element;
  export function liveBranches(live: Record<string, LiveAgent>, snapshot: WorkstreamSnapshot | null, branches: RepoBranch[]): Set<string>;
  // a branch name is in the set when a live agent (no finishedAt) has a taskNoteId matching a task of snapshot.workstream, and that workstream's slug equals the branch name; the default branch never
  // Rail.tsx
  export const ROW_H = 36; export const LANE_W = 28; export const RAIL_PAD = 18;
  export function Rail({ layout, commits, branches, defaultBranch, live, selected }: { layout: RailLayout; commits: RepoCommit[]; branches: RepoBranch[]; defaultBranch: string; live: Set<string>; selected?: string }): JSX.Element;
  ```
  Behaviour of `Repo`:
  - Reads `repo`, `repoView`, `selectedCommit`, `live`, `connected` from the store. `shown` = when `repoView` equals `DEFAULT_REPO_VIEW` → `repo`; otherwise a local `viewSnapshot` state fetched from `/api/repo?repo=&limit=&branch=` on mount and whenever `repo?.fingerprint` or `repoView` changes (300 ms debounce, `AbortController`, errors shown as a status line while the previous view stays).
  - Toolbar: `<select>` branch (`All branches` → `branch` undefined, then each `shown.branches` name) and `<select>` limit (50, 100, 200) both dispatching `repo-view`; a legend chip per branch in its rail colour (`.rail-legend`); a `Load more` button when `shown.truncated` that dispatches `repo-view` with `limit * 2` capped at 500.
  - Empty states: no `repoPath` → nothing; `shown === null` → `connected ? "Reading the repository…" : "Connecting to the dashboard server…"`; `shown.error` → the error text in a `.board-status` paragraph; no commits → "No commits yet".
  - Rows: `<ul className="rail-rows" role="listbox" aria-label="Commits">` with one `<li role="option" aria-selected>` per commit holding a `<button className="row-open" data-sha>`; row content: `.row-sha` (`short`), `.row-subject`, `.row-chips` (branch chips with class `chip chip-branch` and `style={{ '--chip': colour }}`, `chip-wt` when the branch has a worktree with the dirty count as `·N` when `> 0`, `chip-tag` for tags, `chip-task` for tasks reading `T-003` or `slug/T-003` when the slug is not the on-screen workstream, `.pulse` after the chips of a live branch), `.row-time` (`formatAgo(authorTs, useNow())`). Click → `select-commit`; ArrowUp/ArrowDown on the list move focus and selection to the neighbour row; Escape → `select-commit` with no data.
  - The panel: `<section className={`repo-panel${selectedCommit ? " drawer-open" : ""}`} id="panel-repo" role="tabpanel" aria-labelledby="tab-repo">` with `.repo-scroll` (toolbar + the rail grid) and, in Task 8, the `CommitDrawer`.
  `Rail`: an `<svg width={RAIL_PAD * 2 + LANE_W * (lanes - 1)} height={ROW_H * rows.length} aria-hidden>`; lane x = `RAIL_PAD + lane * LANE_W`, row y = `ROW_H / 2 + row * ROW_H`; links as `<path>` (`line` → `M x y V y2`; `fork`/`merge` → `M x1 y1 C x1 ym, x2 ym, x2 y2` with `ym = (y1 + y2) / 2`), stroke = the colour of `toLane` for forks and of `fromLane`… no: use the colour of the non-default lane of the pair (`max(fromLane, toLane)`), width 2; nodes: `<circle r=5>` filled `var(--floor)` with the lane colour stroke, `r=6` for merges, the tip of the default branch filled; a dashed `<circle r=9>` around the head of a branch whose worktree is dirty; a `<circle r=10 stroke=var(--lamp) opacity=.5>` around the tip of a live branch; the selected row's node gets `r=6` and a `var(--ink)` stroke. Colours: `var(--rail-0)` … `var(--rail-5)` by `lane % 6`.
  `app.tsx`: `TABS` gains `{ id: "repo", label: "Repo" }` after `validation`; `SEPARATOR_AFTER` unchanged; the `main` switch renders `<Repo repoPath={current?.repoPath} snapshot={snapshot} />` for `def.id === "repo"`.
  `styles.css` additions (tokens in section 1): `--rail-0: #8FB7E8; --rail-1: #D9A066; --rail-2: #C79CF0; --rail-3: #6FC2C8; --rail-4: #E58FB3; --rail-5: #A3B86C;` then `.repo-panel { position: relative; height: 100%; overflow: hidden }`, `.repo-scroll { height: 100%; overflow: auto; padding: 10px var(--pad) 20px }`, `.drawer-open .repo-scroll { margin-right: var(--drawer-w) }`, `.repo-toolbar` (flex, gap 8px, 12.5px text, selects styled like `.pick`), `.rail { display: grid; grid-template-columns: auto 1fr }`, `.rail-rows li` (height `36px`, grid `1fr auto auto`, border-bottom `var(--rule-soft)`), `.rail-rows li[aria-selected="true"]` (background `var(--plate)`, `box-shadow: inset 3px 0 0 var(--lamp)`), `.row-open` (full-size transparent button), `.row-sha` (mono 12px `var(--ink-3)`), `.row-subject` (ellipsis), `.chip` (pill with `border: 1px solid var(--chip, var(--rule))`, `color: var(--chip, var(--ink-2))`, 11px), `.chip-task` (`color: var(--ink)`, `background: var(--bay)`), `.chip-tag` (dashed border), `.row-time` (11px `var(--ink-3)`, tabular), `.rail-legend` chips.

- [ ] **Step 1: Write a smoke test for `liveBranches`** in `dashboard/test/repo-live.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { liveBranches } from "../web/components/Repo";
import type { LiveAgent, RepoBranch, WorkstreamSnapshot } from "../src/shared/types";
const ws = (slug: string, taskIds: string[]): WorkstreamSnapshot => ({ project: { id: "p", title: "p", repo: "p", repoPath: "/p", labels: {}, modified: "" }, workstream: { id: slug, slug, title: slug, status: "executing", labels: {}, modified: "" }, workstreams: [], milestones: [],
  tasks: taskIds.map((id) => ({ id, taskId: id, title: id, status: "building" as const, milestoneId: "M1", order: 1, round: 0, dependsOn: [], modified: "" })), docs: [], reviews: [], runs: [], live: [], fingerprint: "f" });
const agent = (id: string, taskNoteId?: string, finishedAt?: string): LiveAgent => ({ agentId: id, agentType: "factory:builder", cwd: "/p", startedAt: "2026-11-10T10:00:00Z", stepCount: 0, taskNoteId, finishedAt });
const branches: RepoBranch[] = [{ name: "main", sha: "a", isDefault: true, ahead: 0, behind: 0 }, { name: "demo", sha: "b", isDefault: false, ahead: 1, behind: 0 }];
describe("liveBranches", () => {
  test("the on-screen workstream's branch is live while an agent works on one of its tasks", () => {
    expect([...liveBranches({ a1: agent("a1", "t1") }, ws("demo", ["t1"]), branches)]).toEqual(["demo"]);
    expect(liveBranches({ a1: agent("a1", "t9") }, ws("demo", ["t1"]), branches).size).toBe(0);
    expect(liveBranches({ a1: agent("a1", "t1", "2026-11-10T11:00:00Z") }, ws("demo", ["t1"]), branches).size).toBe(0);
    expect(liveBranches({ a1: agent("a1", "t1") }, ws("main", ["t1"]), branches).size).toBe(0);   // the default branch never pulses
    expect(liveBranches({}, null, branches).size).toBe(0);
  });
});
```

Run: `cd dashboard && bun test test/repo-live.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement `Rail.tsx`, `Repo.tsx`, the `app.tsx` tab and panel, and the styles.** Keep `liveBranches` free of React imports at call time (a plain exported function) so the test can import the module under Bun.

- [ ] **Step 3: Run the tests and type-check**

Run: `cd dashboard && bun test && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 4: Look at it.** `cd dashboard && FACTORY_REPOS=/Users/kemo/Development/claude-sf bun src/server.ts` (this repo is itself a git repo with `.factory/`? If not, point `FACTORY_REPOS` at a temp repo built like Task 2's test with a `.factory/config.json` containing `{}`), open `http://127.0.0.1:7777/#/repo`, compare with `dashboard/mockup/repo.html`: rails, chips, selected row mark, legend, branch filter, Load more. Fix spacing until it matches; stop the server.

- [ ] **Step 5: Commit**

```bash
git add dashboard/web/components/Repo.tsx dashboard/web/components/Rail.tsx dashboard/web/app.tsx dashboard/web/styles.css dashboard/test/repo-live.test.ts
git commit -m "feat(dashboard): Repo tab with branch rails, commit rows, filters and live branch pulse"
```

---

### Task 8: Commit drawer

**Files:**
- Create: `dashboard/web/components/CommitDrawer.tsx`
- Modify: `dashboard/web/components/Repo.tsx`, `dashboard/web/styles.css`, `dashboard/scripts/verify.md`

**Interfaces:**
- Consumes: `/api/repo/commits/:sha?repo=` (Task 4), `CommitDetail`, store actions `select-commit`, `open-task` (Task 5), `liveBranches` (Task 7), `toSafeHtml` is not needed (message bodies render as `<pre className="commit-body">` text, never HTML).
- Produces: `export function CommitDrawer({ repoPath, shown, snapshot }: { repoPath: string; shown: RepoSnapshot; snapshot: WorkstreamSnapshot | null }): JSX.Element`, rendered inside `.repo-panel` after `.repo-scroll`.
  Behaviour, mirroring `TaskDrawer`: `useCommitDetail(sha, repoPath, attempt)` with the same `Load` union, `cache: "no-store"`, `AbortController`, refetch when `shown.fingerprint` changes while open (a new commit on the branch changes nothing in an old commit's detail, but ahead/behind in the facts do); `aside.drawer` with `aria-labelledby="commit-drawer-title"`, `is-live` when any of the commit's tip branches is live, Escape closes, focus moves into the drawer on open and back to the row's button (`.row-open[data-sha]`) on close.
  Content when the commit is in `shown.commits`: head: `<strong>{short}</strong>`, chips (branches with colours, tags, tasks, `.pulse` when live), close button; `<h2 id="commit-drawer-title">{subject}</h2>`; facts: author, `formatAgo`, and for a tip branch with a worktree: `path`, `N ahead · M behind main`, `K files changed, not committed` when `dirty > 0`. Body: section **Message** (`<pre class="commit-body">` with `detail.body`, "No further message." when empty); **Changes · N files · +A −D** (`<ul class="files">` rows: path, `+added` in `.plus`, `−deleted` in `.minus`, `binary` label; "No changes recorded." when empty); **Factory**: one block per `commit.tasks` entry: same workstream → `taskId`, title (`stripId`), milestone chip, status and round, button `Open on board` → `dispatch({ type: "open-task", data })`; other workstream → `slug/taskId` and the same button; no tasks → "Not linked to a task."; **Parents**: a button per parent (`short` + subject) dispatching `select-commit` with the parent sha; a root commit shows "Root commit."; footer buttons: `Copy sha` (`navigator.clipboard.writeText(sha)`, label flips to `Copied` for 1.5 s), `Show diff` (scrolls the Changes section into view).
  When the selected sha is not in `shown.commits`: head with the close button, `<h2>Commit not in the log</h2>` and `<p class="drawer-state">This commit is outside the commits shown. Widen the limit or clear the branch filter to find it.</p>`; no fetch. Fetch error → `.empty.drawer-error` with a `Try again` button (`.doc-retry`), like the task drawer.
  Styles: `.commit-body { white-space: pre-wrap; font: 12.5px/1.5 var(--f-code); color: var(--ink-2) }`, `.files li { display: flex; gap: 8px; font: 12px var(--f-code) }`, `.files .path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }`, `.plus { color: var(--pass) } .minus { color: var(--changes) }`, `.drawer-btns { display: flex; gap: 6px; margin-top: 12px }` reusing `.doc-retry` for the buttons' look.
  `verify.md` gains a numbered **Repo tab** section: open `#/repo`; rails and chips match the mockup; click a row → drawer; Escape closes and focus returns to the row; while a builder runs, its branch chip pulses and the drawer header shows the pulse; `Open on board` lands on the task card (and switches workstream for a `slug/T-xxx` chip); `Copy sha` copies; `Load more` extends the list; a branch filter survives a new commit arriving; a non-git directory registered via `FACTORY_REPOS` shows "not a git repository" on the tab and the board still works.

- [ ] **Step 1: Implement `CommitDrawer.tsx`, mount it in `Repo.tsx`, add the styles and the checklist.**

- [ ] **Step 2: Run the suite and type-check**

Run: `cd dashboard && bun test && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS.

- [ ] **Step 3: Walk the verify.md Repo section** against the server from Task 7 step 4 (a second branch with a worktree and an uncommitted file makes the dirty ring and facts visible; post a `subagent-start` event with a description `builder T-001 [task:<task note id>]` to see the pulse, as `verify.md` step 5 shows). Fix what does not match.

- [ ] **Step 4: Commit**

```bash
git add dashboard/web/components/CommitDrawer.tsx dashboard/web/components/Repo.tsx dashboard/web/styles.css dashboard/scripts/verify.md
git commit -m "feat(dashboard): commit drawer with message, changed files, factory context and parents"
```

---

### Task 9: Builder commit trailer and docs

**Files:**
- Modify: `agents/builder.md`, `skills/run/references/agent-protocol.md`, `README.md`
- Test: `tests/plugin/content.test.ts`

**Interfaces:**
- Produces: builder commits end with the git trailer `Task: <slug>/<taskId>`; nothing else changes in the briefs (the builder knows `<branch>` = the slug and the task id from its `Task:` brief line).

- [ ] **Step 1: Write the failing test** (append to `tests/plugin/content.test.ts`):

```ts
// ---------- rule 13: builder commits carry the task trailer the dashboard joins on ----------
test("builder: commit messages end with the Task: <slug>/<taskId> trailer", () => {
  const problems: string[] = [];
  if (!read("agents/builder.md").includes("Task: <slug>/<taskId>")) problems.push("agents/builder.md: no Task trailer rule");
  if (!read("skills/run/references/agent-protocol.md").includes("Task: <slug>/<taskId>")) problems.push("agent-protocol.md: git guardrail lacks the trailer");
  expect(problems, problems.join("\n")).toEqual([]);
});
```

Run: `bun test tests/plugin/content.test.ts` → FAIL.

- [ ] **Step 2: Edit the two files.** `agents/builder.md` step 7 becomes: "Commit in small logical steps with conventional messages (`feat(scope): …`, `fix: …`, `test: …`, `refactor: …`, `chore: …`) on `<branch>` only; every commit message ends, after a blank line, with the git trailer `Task: <slug>/<taskId>` (the branch name and the task id from your brief, e.g. `Task: checkout-flow/T-003`), which the dashboard uses to link commits to tasks. End with a clean `git status`." `agent-protocol.md` line 153–154: "… inside the worktree, with conventional commit messages ending in a `Task: <slug>/<taskId>` trailer." Keep both files under their size budgets (`bun test tests/plugin` checks). README: add a bullet under the dashboard description: "Repo tab: branches, worktrees and commits as a rail graph; click a commit for its message, changed files and the task it belongs to."

- [ ] **Step 3: Run the plugin tests and strict validation**

Run: `bun test tests/plugin && claude plugin validate . --strict`
Expected: PASS, validation passed.

- [ ] **Step 4: Commit**

```bash
git add agents/builder.md skills/run/references/agent-protocol.md README.md tests/plugin/content.test.ts
git commit -m "feat(plugin): builder commits carry a Task: <slug>/<taskId> trailer for the dashboard's Repo tab"
```

---

### Task 10: Whole-feature check

**Files:** none new.

- [ ] **Step 1: Full suite from the repo root**

Run: `bun test && bunx tsc --noEmit -p dashboard/tsconfig.json && bunx tsc --noEmit -p tsconfig.json && claude plugin validate . --strict`
Expected: all pass.

- [ ] **Step 2: Walk `dashboard/scripts/verify.md` end to end** (daemon start, board, Repo tab section, stop) with `bin/factory-dashboard start` against a temp factory repo; note any mismatch with the mockup as a follow-up rather than widening scope.

- [ ] **Step 3: Commit anything the walk fixed** with `fix(dashboard): …`.
