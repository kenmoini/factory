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
      // an editor with spaces runs through sh: `sleep 30 #` ignores the file name git appends and blocks until killed
      const r = await runGit(["commit", "--amend"], dir, { timeoutMs: 300, env: { GIT_EDITOR: "sleep 30 #" } });
      expect(r.code).toBe(124);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
