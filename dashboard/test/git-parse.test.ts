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
