import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForeignBranchError, ensureWorktree, removeWorktree, validateSlug, worktreePath } from "../../lib/worktree";
import { git } from "../../lib/git";
import { readRepoConfig } from "../../lib/config";

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
  });
  test("accepts good slugs", () => expect(validateSlug("a-b")).toBeNull());
});

describe("ensureWorktree", () => {
  test("creates, is idempotent, recovers, records config", async () => {
    const repo = await makeRepo();
    const a = await ensureWorktree(repo, "demo");
    expect(a).toEqual({ path: worktreePath(repo, "demo"), branch: "demo", created: true, branchCreated: true });
    expect((await git(a.path, "rev-parse", "--abbrev-ref", "HEAD")).out).toBe("demo");
    expect(readRepoConfig(repo)?.workstreams.demo).toEqual({ noteId: "", branch: "demo", worktree: ".factory/worktrees/demo" });

    const b = await ensureWorktree(repo, "demo");
    expect(b.created).toBe(false);
    expect(b.branchCreated).toBe(false);

    rmSync(a.path, { recursive: true, force: true });
    const c = await ensureWorktree(repo, "demo");
    expect(c.created).toBe(true);
    expect(c.branchCreated).toBe(false);
    expect(existsSync(c.path)).toBe(true);
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
});
