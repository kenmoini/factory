import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGlobalConfig, writeGlobalConfig, readRepoConfig, writeRepoConfig, globalConfigPath, getPath, setPath } from "../../lib/config";

const env = () => ({ FACTORY_CONFIG_DIR: mkdtempSync(join(tmpdir(), "fcfg-")), HOME: "/nonexistent" });

describe("global config", () => {
  test("missing file reads as null", () => expect(readGlobalConfig(env())).toBeNull());
  test("round-trips and is mode 0600", () => {
    const e = env();
    const p = writeGlobalConfig({ triliumUrl: "http://t:8080", etapiToken: "tok", dashboardPort: 7777 }, e);
    expect(p).toBe(globalConfigPath(e));
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readGlobalConfig(e)).toEqual({ triliumUrl: "http://t:8080", etapiToken: "tok", dashboardPort: 7777 });
  });
});
describe("repo config", () => {
  test("round-trips under .factory/", () => {
    const repo = mkdtempSync(join(tmpdir(), "frepo-"));
    writeRepoConfig(repo, { projectNoteId: "n1", workstreams: { a: { noteId: "w1", branch: "a", worktree: ".factory/worktrees/a" } } });
    expect(readRepoConfig(repo)?.workstreams.a.noteId).toBe("w1");
  });
});
describe("dotted paths", () => {
  test("get/set nested", () => {
    const o: Record<string, unknown> = {};
    setPath(o, "workstreams.a.noteId", "x");
    expect(getPath(o, "workstreams.a.noteId")).toBe("x");
    expect(getPath(o, "nope.deeper")).toBeUndefined();
  });
});
