import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../../lib/git";
import { buildReviewPackage } from "../../lib/review-package";

async function commit(dir: string, msg: string): Promise<string> {
  await git(dir, "add", "-A");
  const r = await git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg);
  expect(r.code).toBe(0);
  return (await git(dir, "rev-parse", "HEAD")).out;
}

async function makeRepo(): Promise<{ dir: string; a: string; b: string }> {
  const dir = mkdtempSync(join(tmpdir(), "factory-rp-"));
  await git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  const a = await commit(dir, "A");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(dir, "b.txt"), "new\n");
  const b = await commit(dir, "B");
  return { dir, a, b };
}

describe("buildReviewPackage", () => {
  test("writes package", async () => {
    const { dir, a, b } = await makeRepo();
    const outFile = join(dir, "out", "sub", "pkg.md");
    const r = await buildReviewPackage({ worktree: dir, base: a, head: b, outFile });
    expect(r).toEqual({ path: outFile, commits: 1, filesChanged: 2 });
    const text = readFileSync(outFile, "utf8");
    expect(text).toContain("# Review package");
    expect(text).toContain(`Range: ${a}..${b}`);
    expect(text).toContain("## Commits");
    expect(text).toContain("## Stat");
    expect(text).toContain("```diff");
    expect(text).toContain("b.txt");
    expect(text).toContain("@@");
  });

  test("invalid head rejects", async () => {
    const { dir, a } = await makeRepo();
    await expect(buildReviewPackage({ worktree: dir, base: a, head: "nope", outFile: join(dir, "x.md") })).rejects.toThrow("invalid range");
  });

  test("non-ancestor base rejects", async () => {
    const { dir, a, b } = await makeRepo();
    await expect(buildReviewPackage({ worktree: dir, base: b, head: a, outFile: join(dir, "x.md") })).rejects.toThrow("invalid range");
  });

  test("empty range is not an error", async () => {
    const { dir, b } = await makeRepo();
    const outFile = join(dir, "e.md");
    const r = await buildReviewPackage({ worktree: dir, base: b, head: b, outFile });
    expect(r.commits).toBe(0);
    expect(r.filesChanged).toBe(0);
    expect(readFileSync(outFile, "utf8")).toContain("(none)");
  });
});
