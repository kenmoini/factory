import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { RepoRegistry } from "../src/repos";

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "frepo-"));
  mkdirSync(join(dir, ".factory"));
  home = mkdtempSync(join(tmpdir(), "frepo-home-"));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
const write = (o: unknown) => writeFileSync(join(dir, ".factory", "config.json"), JSON.stringify(o));
const trilium = (url: string, token: string) => ({ mcpServers: { trilium: { type: "http", url: `${url}/mcp`, headers: { Authorization: `Bearer ${token}` } } } });
const writeMcp = (url: string, token: string) => writeFileSync(join(dir, ".mcp.json"), JSON.stringify(trilium(url, token)));

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
    expect(reg.reload(dir)).toEqual({ entry: e, changed: false, activeChanged: false, triliumChanged: false });
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

  describe("trilium credentials", () => {
    const reg = (fallback?: { baseUrl: string; token: string }, env: Record<string, string> = {}) => new RepoRegistry({ trilium: { env, homeDir: home, fallback } });

    test("register reads <repo>/.mcp.json: the entry carries baseUrl, placeholder and source, never the token", () => {
      write({ workstreams: {} });
      writeMcp("https://trilium.example", "secret-tok-1");
      const r = reg();
      const e = r.register(dir)!;
      expect(e.trilium).toEqual({ baseUrl: "https://trilium.example", placeholder: false, source: "project" });
      expect(JSON.stringify(e)).not.toContain("secret-tok-1");
      expect(r.credentials(dir)).toEqual({ baseUrl: "https://trilium.example", token: "secret-tok-1", placeholder: false, source: "project" });
    });

    test("a placeholder token registers the repo, marked placeholder", () => {
      write({ workstreams: {} });
      writeMcp("http://h", "your-etapi-token");
      const r = reg();
      expect(r.register(dir)!.trilium).toEqual({ baseUrl: "http://h", placeholder: true, source: "project" });
      expect(r.credentials(dir)?.placeholder).toBe(true);
    });

    test("no trilium server anywhere: registered without trilium; the legacy global config is the last fallback", () => {
      write({ workstreams: {} });
      const none = reg();
      expect(none.register(dir)!.trilium).toBeUndefined();
      expect(none.credentials(dir)).toBeNull();
      const legacy = reg({ baseUrl: "http://legacy/", token: "ltok" });
      expect(legacy.register(dir)!.trilium).toEqual({ baseUrl: "http://legacy", placeholder: false, source: "config" });
      expect(legacy.credentials(dir)?.token).toBe("ltok");
      writeFileSync(join(home, ".claude.json"), JSON.stringify(trilium("http://user", "utok")));
      expect(legacy.register(dir)!.trilium?.source).toBe("user"); // user scope comes before the legacy file
    });

    test("without trilium options the registry resolves nothing", () => {
      write({ workstreams: {} });
      writeMcp("http://h", "tok");
      const r = new RepoRegistry();
      expect(r.register(dir)!.trilium).toBeUndefined();
      expect(r.credentials(dir)).toBeNull();
    });

    test("reload re-reads .mcp.json and ~/.claude.json when their stamp changes; credentials are a new object only then", () => {
      write({ workstreams: {} });
      writeMcp("http://h", "your-etapi-token");
      const r = reg();
      const e = r.register(dir)!;
      const first = r.credentials(dir);
      expect(r.reload(dir)).toMatchObject({ changed: false, triliumChanged: false });
      expect(r.credentials(dir)).toBe(first);

      writeMcp("http://h", "real-token-22");
      expect(r.reload(dir)).toMatchObject({ entry: e, changed: false, triliumChanged: true });
      expect(e.trilium).toEqual({ baseUrl: "http://h", placeholder: false, source: "project" });
      expect(r.credentials(dir)).not.toBe(first);
      expect(r.credentials(dir)?.token).toBe("real-token-22");
      expect(r.reload(dir)).toMatchObject({ triliumChanged: false });

      // the project entry goes away: the user scope takes over
      writeFileSync(join(home, ".claude.json"), JSON.stringify(trilium("http://user", "utok")));
      rmSync(join(dir, ".mcp.json"));
      expect(r.reload(dir)).toMatchObject({ triliumChanged: true });
      expect(e.trilium).toEqual({ baseUrl: "http://user", placeholder: false, source: "user" });
      writeFileSync(join(home, ".claude.json"), JSON.stringify(trilium("http://user2", "utok")));
      expect(r.reload(dir)).toMatchObject({ triliumChanged: true });
      expect(e.trilium?.baseUrl).toBe("http://user2");

      // a rewrite with the same credentials is not a change
      writeFileSync(join(home, ".claude.json"), JSON.stringify({ ...trilium("http://user2", "utok"), numStartups: 9 }));
      expect(r.reload(dir)).toMatchObject({ triliumChanged: false });

      rmSync(join(home, ".claude.json"));
      expect(r.reload(dir)).toMatchObject({ triliumChanged: true });
      expect(e.trilium).toBeUndefined();
      expect(r.credentials(dir)).toBeNull();
    });

    test("env overrides win (FACTORY_TRILIUM_URL / FACTORY_ETAPI_TOKEN)", () => {
      write({ workstreams: {} });
      writeMcp("http://h", "your-etapi-token");
      const r = reg(undefined, { FACTORY_TRILIUM_URL: "http://env", FACTORY_ETAPI_TOKEN: "etok" });
      expect(r.register(dir)!.trilium).toEqual({ baseUrl: "http://env", placeholder: false, source: "env" });
    });
  });
});
