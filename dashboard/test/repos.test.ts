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

  test("reload re-parses a changed config in place and reports an activeWorkstream change", () => {
    write({ projectNoteId: "p1", activeWorkstream: "a", workstreams: { a: { noteId: "n1" } } });
    const reg = new RepoRegistry();
    const e = reg.register(dir)!;
    expect(reg.reload(dir)).toEqual({ entry: e, changed: false, activeChanged: false });
    write({ projectNoteId: "p1", activeWorkstream: "b", workstreams: { a: { noteId: "n1" }, b: {} } });
    const r = reg.reload(dir)!;
    expect(r.changed).toBe(true);
    expect(r.activeChanged).toBe(true);
    expect(r.entry).toBe(e); // same object: pollers holding the entry see the change
    expect(e.activeWorkstream).toBe("b");
    expect(e.workstreams).toEqual({ a: { noteId: "n1" }, b: {} });
    expect(reg.reload(dir)!.changed).toBe(false);
    write({ projectNoteId: "p1", activeWorkstream: "b", workstreams: { a: { noteId: "n1" }, b: { noteId: "n2" } } });
    expect(reg.reload(dir)).toMatchObject({ changed: true, activeChanged: false });
    expect(e.workstreams.b).toEqual({ noteId: "n2" });
  });

  test("reload keeps the entry when the config is unreadable, and retries next time", () => {
    write({ activeWorkstream: "a", workstreams: { a: {} } });
    const reg = new RepoRegistry();
    const e = reg.register(dir)!;
    writeFileSync(join(dir, ".factory", "config.json"), "{ half-writ");
    expect(reg.reload(dir)).toMatchObject({ changed: false });
    expect(e.activeWorkstream).toBe("a");
    write({ activeWorkstream: "c", workstreams: { c: {} } });
    expect(reg.reload(dir)).toMatchObject({ changed: true, activeChanged: true });
    expect(reg.reload(join(dir, "unregistered"))).toBeNull();
  });

  test("no config → null", () => {
    expect(new RepoRegistry().register(join(dir, "nope"))).toBeNull();
  });
});
