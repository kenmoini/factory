import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeBranch } from "../../lib/merge";

const g = (dir: string, ...a: string[]) => {
  const p = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
};
function repo() {
  const d = mkdtempSync(join(tmpdir(), "merge-"));
  g(d, "init", "-q", "-b", "main");
  writeFileSync(join(d, "f.txt"), "base\nx\n");
  g(d, "add", "."); g(d, "commit", "-q", "-m", "A");
  return d;
}
const edit = (d: string, branch: string, line: string) => {
  g(d, "checkout", "-q", "-b", branch, "main");
  writeFileSync(join(d, "f.txt"), `${line}\nx\n`);
  g(d, "commit", "-qam", `edit ${branch}`);
  g(d, "checkout", "-q", "main");
};

test("merges with no-ff, then up-to-date", async () => {
  const d = repo();
  edit(d, "feat", "feat");
  const r = await mergeBranch({ repoDir: d, branch: "feat", message: "merge feat" });
  expect(r.result).toBe("merged");
  expect(g(d, "rev-list", "--parents", "-n1", "main").split(" ").length).toBe(3);
  expect(g(d, "log", "-1", "--format=%s", "main")).toBe("merge feat");
  expect(r.result === "merged" && r.sha).toBe(g(d, "rev-parse", "HEAD"));
  expect((await mergeBranch({ repoDir: d, branch: "feat", message: "again" })).result).toBe("up-to-date");
});

test("conflict aborts and reports files", async () => {
  const d = repo();
  edit(d, "feat", "feat");
  writeFileSync(join(d, "f.txt"), "mainline\nx\n");
  g(d, "commit", "-qam", "main edit");
  const before = g(d, "rev-parse", "main");
  const r = await mergeBranch({ repoDir: d, branch: "feat", message: "m" });
  expect(r).toEqual({ result: "conflict", files: ["f.txt"] });
  expect(g(d, "status", "--porcelain")).toBe("");
  expect(g(d, "rev-parse", "main")).toBe(before);
});

test("dirty tree is refused", async () => {
  const d = repo();
  edit(d, "feat", "feat");
  const before = g(d, "rev-parse", "main");
  writeFileSync(join(d, "f.txt"), "dirty\n");
  writeFileSync(join(d, "new.txt"), "n\n");
  const r = await mergeBranch({ repoDir: d, branch: "feat", message: "m" });
  expect(r.result).toBe("dirty");
  if (r.result === "dirty") expect(r.files.sort()).toEqual(["f.txt", "new.txt"]);
  expect(g(d, "rev-parse", "main")).toBe(before);
});

test("ignored untracked files are not dirty; missing branch errors", async () => {
  const d = repo();
  writeFileSync(join(d, ".gitignore"), "ign\n");
  g(d, "add", "."); g(d, "commit", "-q", "-m", "ig");
  edit(d, "feat", "feat");
  writeFileSync(join(d, "ign"), "x");
  expect((await mergeBranch({ repoDir: d, branch: "feat", message: "m" })).result).toBe("merged");
  const e = await mergeBranch({ repoDir: d, branch: "nope", message: "m" });
  expect(e).toEqual({ result: "error", message: "no such branch: nope" });
});
