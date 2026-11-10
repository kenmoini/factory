import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForeignBranchError, ensureWorktree, removeWorktree, validateSlug, worktreePath } from "../../lib/worktree";
import { git } from "../../lib/git";
import { readRepoConfig, writeRepoConfig } from "../../lib/config";

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "factory-wt-"));
  await git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), ".factory/\n");
  await git(dir, "add", ".gitignore");
  const r = await git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  expect(r.code).toBe(0);
  return dir;
}

describe("validateSlug", () => {
  test("rejects bad slugs", () => {
    expect(validateSlug("My Slug")).toBeString();
    expect(validateSlug("")).toBeString();
    expect(validateSlug("-a")).toBeString();
    expect(validateSlug("a-")).toContain('must not end with "-"');
  });
  test("accepts good slugs", () => expect(validateSlug("a-b")).toBeNull());
});

describe("ensureWorktree", () => {
  test("creates, is idempotent, recovers, records config", async () => {
    const repo = await makeRepo();
    const a = await ensureWorktree(repo, "demo");
    expect(a).toEqual({ path: worktreePath(repo, "demo"), branch: "demo", created: true, branchCreated: true });
    expect((await git(a.path, "rev-parse", "--abbrev-ref", "HEAD")).out).toBe("demo");
    const entry = readRepoConfig(repo)?.workstreams.demo;
    expect(entry).toEqual({ branch: "demo", worktree: ".factory/worktrees/demo" });
    expect(entry && "noteId" in entry).toBe(false); // unknown note id: key omitted, so `factory-config get` misses

    const b = await ensureWorktree(repo, "demo");
    expect(b.created).toBe(false);
    expect(b.branchCreated).toBe(false);

    rmSync(a.path, { recursive: true, force: true });
    const c = await ensureWorktree(repo, "demo");
    expect(c.created).toBe(true);
    expect(c.branchCreated).toBe(false);
    expect(existsSync(c.path)).toBe(true);
  });

  test("keeps a cached noteId on re-ensure", async () => {
    const repo = await makeRepo();
    await ensureWorktree(repo, "demo");
    const cfg = readRepoConfig(repo)!;
    cfg.workstreams.demo.noteId = "n42";
    writeRepoConfig(repo, cfg);
    await ensureWorktree(repo, "demo");
    expect(readRepoConfig(repo)?.workstreams.demo).toEqual({ noteId: "n42", branch: "demo", worktree: ".factory/worktrees/demo" });
  });

  test("refuses foreign branch unless adopt", async () => {
    const repo = await makeRepo();
    await git(repo, "branch", "other");
    await expect(ensureWorktree(repo, "other")).rejects.toBeInstanceOf(ForeignBranchError);
    const r = await ensureWorktree(repo, "other", { adopt: true });
    expect(r.created).toBe(true);
    expect(r.branchCreated).toBe(false);
  });
});

describe("removeWorktree", () => {
  test("removes dir, keeps branch", async () => {
    const repo = await makeRepo();
    const a = await ensureWorktree(repo, "demo");
    expect((await removeWorktree(repo, "demo")).removed).toBe(true);
    expect(existsSync(a.path)).toBe(false);
    expect((await git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/demo")).code).toBe(0);
    expect(readRepoConfig(repo)?.workstreams.demo).toBeDefined();
  });
  test("deleteBranch drops branch and config entry", async () => {
    const repo = await makeRepo();
    await ensureWorktree(repo, "demo");
    await removeWorktree(repo, "demo", { deleteBranch: true });
    expect((await git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/demo")).code).not.toBe(0);
    expect(readRepoConfig(repo)?.workstreams.demo).toBeUndefined();
  });
  test("deleteBranch refuses a branch the factory does not own", async () => {
    const repo = await makeRepo();
    await git(repo, "branch", "other");
    expect((await git(repo, "worktree", "add", worktreePath(repo, "other"), "other")).code).toBe(0);
    await expect(removeWorktree(repo, "other", { deleteBranch: true })).rejects.toBeInstanceOf(ForeignBranchError);
    expect((await git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/other")).code).toBe(0);
  });
  test("branch -D failure throws and keeps config entry", async () => {
    const repo = await makeRepo();
    await ensureWorktree(repo, "demo");
    const extra = mkdtempSync(join(tmpdir(), "factory-wt-extra-")) + "/x";
    expect((await git(repo, "worktree", "add", "--force", extra, "demo")).code).toBe(0);
    await expect(removeWorktree(repo, "demo", { deleteBranch: true })).rejects.toThrow("git branch -D failed");
    expect(readRepoConfig(repo)?.workstreams.demo).toBeDefined();
  });
});

describe("bin/factory-worktree exit codes", () => {
  const BIN = join(import.meta.dir, "../../bin/factory-worktree");
  const cli = (...args: string[]) => {
    const p = Bun.spawnSync([BIN, ...args], { stdout: "pipe", stderr: "pipe" });
    const out = p.stdout.toString().trim();
    return { code: p.exitCode, json: out ? JSON.parse(out) : null };
  };

  test("ensure 0", async () => {
    const repo = await makeRepo();
    const r = cli("ensure", "demo", "--repo", repo);
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ path: worktreePath(repo, "demo"), branch: "demo", created: true, branchCreated: true });
  });

  test("foreign branch 2", async () => {
    const repo = await makeRepo();
    await git(repo, "branch", "other");
    const r = cli("ensure", "other", "--repo", repo);
    expect(r.code).toBe(2);
    expect(r.json.error).toContain("not a factory workstream");
  });

  test("invalid slug 3", async () => {
    const repo = await makeRepo();
    const r = cli("ensure", "Bad Slug", "--repo", repo);
    expect(r.code).toBe(3);
    expect(r.json.error).toContain("invalid slug");
  });
});
