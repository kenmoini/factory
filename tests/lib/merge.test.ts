import { describe, expect, test } from "bun:test";
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

// ---------- bin/factory-merge exit codes ----------
const BIN = join(import.meta.dir, "../../bin/factory-merge");
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const cli = (...args: string[]) => {
  const p = Bun.spawnSync([BIN, ...args], { env: { ...process.env, ...GIT_ENV }, stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString().trim();
  return { code: p.exitCode, out, json: out ? JSON.parse(out) : null };
};
const USAGE = "usage: factory-merge <repo> <branch> (<message> | --message-file <path>) [--into <branch>]";

describe("bin/factory-merge", () => {
  test("merged 0, then up-to-date 0", () => {
    const d = repo();
    edit(d, "feat", "feat");
    const a = cli(d, "feat", "merge feat");
    expect(a.code).toBe(0);
    expect(a.json.result).toBe("merged");
    const b = cli(d, "feat", "again");
    expect(b.code).toBe(0);
    expect(b.json).toEqual({ result: "up-to-date" });
  });

  test("conflict 2", () => {
    const d = repo();
    edit(d, "feat", "feat");
    writeFileSync(join(d, "f.txt"), "mainline\nx\n");
    g(d, "commit", "-qam", "main edit");
    const r = cli(d, "feat", "m");
    expect(r.code).toBe(2);
    expect(r.json).toEqual({ result: "conflict", files: ["f.txt"] });
  });

  test("dirty 3", () => {
    const d = repo();
    edit(d, "feat", "feat");
    writeFileSync(join(d, "f.txt"), "dirty\n");
    const r = cli(d, "feat", "m");
    expect(r.code).toBe(3);
    expect(r.json.result).toBe("dirty");
  });

  test("error 1", () => {
    const d = repo();
    const r = cli(d, "nope", "m");
    expect(r.code).toBe(1);
    expect(r.json).toEqual({ result: "error", message: "no such branch: nope" });
  });

  test("usage errors exit 1 with a JSON error (never 2, which means conflict)", () => {
    const d = repo();
    for (const args of [[], [d], [d, "feat"], [d, "feat", "m", "extra"], [d, "feat", "m", "--into"], [d, "feat", "--message-file"]]) {
      const r = cli(...args);
      expect(r.code).toBe(1);
      expect(r.json).toEqual({ result: "error", message: USAGE });
    }
  });

  test("--message-file supplies the message and wins over the positional", () => {
    const d = repo();
    edit(d, "feat", "feat");
    const f = join(d, "..", `${d.split("/").pop()}-msg.txt`);
    writeFileSync(f, "Merge feat: T-001 \"quoted\" `title` $(nope)\n");
    const r = cli(d, "feat", "positional", "--message-file", f);
    expect(r.code).toBe(0);
    expect(r.json.result).toBe("merged");
    expect(g(d, "log", "-1", "--format=%s", "main")).toBe("Merge feat: T-001 \"quoted\" `title` $(nope)");
  });

  test("--message-file alone (no positional) merges; unreadable file is an error 1", () => {
    const d = repo();
    edit(d, "feat", "feat");
    const missing = cli(d, "feat", "--message-file", join(d, "no-such-file.txt"));
    expect(missing.code).toBe(1);
    expect(missing.json.result).toBe("error");
    const f = join(d, "..", `${d.split("/").pop()}-msg2.txt`);
    writeFileSync(f, "from file\n");
    const r = cli(d, "feat", "--message-file", f);
    expect(r.code).toBe(0);
    expect(g(d, "log", "-1", "--format=%s", "main")).toBe("from file");
  });
});
