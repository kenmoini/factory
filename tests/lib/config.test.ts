import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGlobalConfig, writeGlobalConfig, readRepoConfig, writeRepoConfig, globalConfigPath, getPath, setPath, hasLegacyTriliumKeys } from "../../lib/config";

const env = () => ({ FACTORY_CONFIG_DIR: mkdtempSync(join(tmpdir(), "fcfg-")), HOME: "/nonexistent" });

describe("global config", () => {
  test("missing file reads as null", () => expect(readGlobalConfig(env())).toBeNull());
  test("round-trips and is mode 0600", () => {
    const e = env();
    const p = writeGlobalConfig({ dashboardPort: 7777 }, e);
    expect(p).toBe(globalConfigPath(e));
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readGlobalConfig(e)).toEqual({ dashboardPort: 7777 });
  });
  test("legacy Trilium keys are still returned as read, and detected", () => {
    const e = env();
    mkdirSync(e.FACTORY_CONFIG_DIR, { recursive: true });
    writeFileSync(globalConfigPath(e), JSON.stringify({ triliumUrl: "http://t", etapiToken: "tok", dashboardPort: 7777 }));
    const g = readGlobalConfig(e);
    expect(g).toEqual({ triliumUrl: "http://t", etapiToken: "tok", dashboardPort: 7777 } as never);
    expect(hasLegacyTriliumKeys(g)).toBe(true);
    expect(hasLegacyTriliumKeys({ etapiToken: "x" })).toBe(true);
    expect(hasLegacyTriliumKeys({ dashboardPort: 7777 })).toBe(false);
    expect(hasLegacyTriliumKeys(null)).toBe(false);
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
