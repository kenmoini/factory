import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { RepoRegistry } from "../src/repos";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "frepo-")); mkdirSync(join(dir, ".factory")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const write = (o: unknown) => writeFileSync(join(dir, ".factory", "config.json"), JSON.stringify(o));

describe("RepoRegistry", () => {
  test("reads .factory/config.json", () => {
    write({ projectNoteId: "p1", activeWorkstream: "a", workstreams: { a: { noteId: "n1" } } });
    const e = new RepoRegistry().register(dir)!;
    expect(e).toEqual({ repoPath: dir, repoSlug: basename(dir), projectNoteId: "p1", activeWorkstream: "a", workstreams: { a: { noteId: "n1" } } });
  });

  test("lists workstreams whose noteId is not cached yet", () => {
    // the plugin writes { branch, worktree } and adds noteId only once brainstorm has created the note
    write({ activeWorkstream: "b", workstreams: { a: { noteId: "n1" }, b: { branch: "b", worktree: ".factory/worktrees/b" }, c: {}, d: { noteId: "" }, bad: null, worse: "x" } });
    const e = new RepoRegistry().register(dir)!;
    expect(e.workstreams).toEqual({ a: { noteId: "n1" }, b: {}, c: {}, d: {} });
  });

  test("no config → null", () => {
    expect(new RepoRegistry().register(join(dir, "nope"))).toBeNull();
  });
});
