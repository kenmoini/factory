// dashboard/test/git-reader.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitReader, runGit, type GitRunner } from "../src/git/reader";

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
  test("probe: refs, live worktrees with dirty counts and the snapshot's fingerprint; no log, no ahead/behind", async () => {
    const ran: string[] = [];
    const r = new GitReader(root, (args, cwd, opts) => { ran.push(args[0]); return runGit(args, cwd, opts); });
    const p = await r.probe();
    if ("error" in p) throw new Error(p.error);
    expect(p.refs.map((x) => x.name).sort()).toEqual(["checkout-flow", "main", "v0.1.0"]);
    expect(p.worktrees.map((w) => [w.path, w.dirty])).toEqual([[root, 1], [wt, 1]]); // the root sees the untracked .factory/
    expect(ran).not.toContain("log"); expect(ran).not.toContain("rev-list");
    expect(p.fingerprint).toBe((await r.snapshot()).fingerprint);
    expect(await r.build(p, { limit: 2 })).toMatchObject({ fingerprint: p.fingerprint, limit: 2, truncated: true });
  });
  test("build: six branches get their ahead/behind, at most four rev-list processes at a time", async () => {
    const dir = tempDir("factory-git-pool-");
    try {
      git(dir, "init", "-q", "-b", "main"); commit(dir, "a.txt", "init");
      for (let i = 1; i <= 6; i++) {
        git(dir, "checkout", "-q", "-b", `b${i}`, "main");
        for (let k = 0; k < i; k++) commit(dir, `b${i}-${k}.txt`, `b${i} ${k}`);
      }
      git(dir, "checkout", "-q", "main"); commit(dir, "m.txt", "main moves on");
      let running = 0, peak = 0;
      const counted: GitRunner = async (args, cwd, opts) => {
        if (args[0] !== "rev-list") return runGit(args, cwd, opts);
        running++; peak = Math.max(peak, running);
        try { return await runGit(args, cwd, opts); } finally { running--; }
      };
      const snap = await new GitReader(dir, counted).snapshot();
      expect(snap.error).toBeUndefined();
      expect(snap.branches.map((b) => [b.name, b.ahead, b.behind])).toEqual([
        ["b1", 1, 1], ["b2", 2, 1], ["b3", 3, 1], ["b4", 4, 1], ["b5", 5, 1], ["b6", 6, 1], ["main", 0, 0],
      ]);
      expect(snap.commits.length).toBe(23);
      expect(peak).toBe(4);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("branch filter and limit", async () => {
    const snap = await new GitReader(root).snapshot({ limit: 2, branch: "checkout-flow" });
    expect(snap.commits.length).toBe(2);
    expect(snap.limit).toBe(2);
    expect(snap.truncated).toBe(true);                                      // d, c shown; b and a left out
    expect(snap.commits.map((c) => c.subject)).toEqual(["feat(address): validation", "test(cart): totals"]);
    const main = await new GitReader(root).snapshot({ limit: 10, branch: "main" });
    expect(main.commits.length).toBe(4);
    expect(main.truncated).toBe(false);
    expect(main.commits.map((c) => c.subject)).not.toContain("feat(address): validation"); // only on checkout-flow
  });
  test("detail: body, numstat files, totals, parents; unknown sha is null", async () => {
    const r = new GitReader(root);
    const head = (await r.snapshot()).commits[0];
    const d = (await r.detail(head.sha))!;
    expect(d.commit.sha).toBe(head.sha);
    expect(d.body).toBe("Task: checkout-flow/T-002");
    expect(d.files).toEqual([{ path: "d.txt", added: 3, deleted: 0 }]);
    expect(d.totals).toEqual({ files: 1, added: 3, deleted: 0 });
    expect(d.parents[0].subject).toBe("test(cart): totals"); // d sits on checkout-flow after c, not after the merge
    expect(await r.detail("0".repeat(40))).toBeNull();
    expect(await r.detail(head.sha.slice(0, 7))).not.toBeNull();
  });
  test("not a repository and a missing git binary (runner code 127: \"git not found\") become snapshot.error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-nogit-"));
    try {
      expect((await new GitReader(dir).snapshot()).error).toMatch(/not a git repository/i);
      expect(await new GitReader(dir).probe()).toEqual({ error: expect.stringMatching(/not a git repository/) });
    } finally { rmSync(dir, { recursive: true, force: true }); }
    const broken = new GitReader(root, async () => ({ code: 127, out: "", err: "spawn git ENOENT" }));
    expect((await broken.snapshot()).error).toBe("git not found");
  });
  test("detail: a git failure is an error, only an unknown sha is null", async () => {
    const down = new GitReader(root, async () => ({ code: 127, out: "", err: "spawn git ENOENT" }));
    await expect(down.detail("abc1234")).rejects.toThrow("git not found");
  });
  test("a deleted worktree folder does not break the snapshot", async () => {
    const gone = join(root, ".factory/worktrees/gone");
    git(root, "worktree", "add", "-q", "-b", "gone", gone);
    rmSync(gone, { recursive: true, force: true });
    try {
      const snap = await new GitReader(root).snapshot();
      expect(snap.error).toBeUndefined();
      const b = snap.branches.find((x) => x.name === "gone")!;
      expect(b).toBeDefined();
      expect(b.worktree).toBeUndefined();
    } finally { git(root, "worktree", "prune"); git(root, "branch", "-q", "-D", "gone"); }
  });
  test("a tag named like the branch does not hijack the branch filter", async () => {
    git(root, "tag", "checkout-flow", "main");
    try {
      const snap = await new GitReader(root).snapshot({ limit: 10, branch: "checkout-flow" });
      expect(snap.error).toBeUndefined();
      expect(snap.commits.map((c) => c.subject)[0]).toBe("feat(address): validation");
      expect(snap.branches.find((b) => b.name === "checkout-flow")).toMatchObject({ ahead: 1, behind: 1 });
    } finally { git(root, "tag", "-d", "checkout-flow"); }
  });
  test("runGit kills a command whose output passes maxOut (code 125)", async () => {
    const r = await runGit(["log", "--all"], root, { maxOut: 16 });
    expect(r.code).toBe(125);
    expect((await runGit(["log", "--all"], root)).code).toBe(0);
  });
  test("runGit runs git, and kills a command that outlives its timeout (code 124)", async () => {
    expect((await runGit(["--version"], root)).code).toBe(0);
    // a throwaway repo: the killed `commit --amend` may leave a lock behind
    const dir = tempDir("factory-git-timeout-");
    try {
      git(dir, "init", "-q", "-b", "main"); commit(dir, "a.txt", "init");
      // an editor with spaces runs through sh: `sleep 30 #` ignores the file name git appends and blocks until killed
      const r = await runGit(["commit", "--amend"], dir, { timeoutMs: 300, env: { GIT_EDITOR: "sleep 30 #" } });
      expect(r.code).toBe(124);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
