import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPlaceholderToken, readTriliumMcp } from "../src/trilium/mcp-config";

let repo: string;
let home: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "fmcp-repo-"));
  home = mkdtempSync(join(tmpdir(), "fmcp-home-"));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const server = (url: string, auth?: string) => ({ type: "http", url, ...(auth === undefined ? {} : { headers: { Authorization: auth } }) });
const project = (trilium: unknown, extra: Record<string, unknown> = {}) =>
  writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { other: { type: "stdio", command: "x" }, ...(trilium === undefined ? {} : { trilium }), ...extra } }));
const user = (trilium: unknown) =>
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ numStartups: 3, projects: {}, mcpServers: { trilium } }));

describe("readTriliumMcp", () => {
  test("project .mcp.json: base URL without /mcp, token without Bearer", () => {
    project(server("https://trilium.example.com/mcp", "Bearer tok-123"));
    expect(readTriliumMcp(repo, {}, home)).toEqual({ baseUrl: "https://trilium.example.com", token: "tok-123", placeholder: false, source: "project" });
  });

  test("trailing slashes around /mcp are dropped; a URL without /mcp is kept; a header without Bearer is the token", () => {
    project(server("http://127.0.0.1:8080/mcp/", "Bearer  tok "));
    expect(readTriliumMcp(repo, {}, home)).toMatchObject({ baseUrl: "http://127.0.0.1:8080", token: "tok" });
    project(server("http://127.0.0.1:8080/trilium/", "raw-tok"));
    expect(readTriliumMcp(repo, {}, home)).toMatchObject({ baseUrl: "http://127.0.0.1:8080/trilium", token: "raw-tok" });
    project(server("http://h/mcp", "bearer lower"));
    expect(readTriliumMcp(repo, {}, home)).toMatchObject({ token: "lower" });
  });

  test("the Authorization header is matched case-insensitively", () => {
    project({ type: "http", url: "http://h/mcp", headers: { authorization: "Bearer t1" } });
    expect(readTriliumMcp(repo, {}, home)?.token).toBe("t1");
  });

  test("placeholder: your-etapi-token, an empty token, or no Authorization header", () => {
    project(server("http://h/mcp", "Bearer your-etapi-token"));
    expect(readTriliumMcp(repo, {}, home)).toEqual({ baseUrl: "http://h", token: "your-etapi-token", placeholder: true, source: "project" });
    project(server("http://h/mcp", "Bearer "));
    expect(readTriliumMcp(repo, {}, home)).toMatchObject({ token: "", placeholder: true });
    project(server("http://h/mcp"));
    expect(readTriliumMcp(repo, {}, home)).toMatchObject({ token: "", placeholder: true });
    expect(isPlaceholderToken("your-etapi-token")).toBe(true);
    expect(isPlaceholderToken("")).toBe(true);
    expect(isPlaceholderToken("real")).toBe(false);
  });

  test("${VAR} and ${VAR:-default} in url and headers expand from env, as Claude Code does", () => {
    project(server("${TRILIUM_BASE:-http://fallback}/mcp", "Bearer ${TRILIUM_TOKEN}"));
    expect(readTriliumMcp(repo, { TRILIUM_TOKEN: "from-env" }, home)).toMatchObject({ baseUrl: "http://fallback", token: "from-env", placeholder: false, source: "project" });
    expect(readTriliumMcp(repo, { TRILIUM_BASE: "http://b" }, home)).toMatchObject({ baseUrl: "http://b", token: "", placeholder: true });
  });

  test("user scope ~/.claude.json when the project has no trilium server", () => {
    user(server("http://user-host:37840/mcp", "Bearer utok"));
    expect(readTriliumMcp(repo, {}, home)).toEqual({ baseUrl: "http://user-host:37840", token: "utok", placeholder: false, source: "user" });
    project(undefined); // a .mcp.json with other servers only
    expect(readTriliumMcp(repo, {}, home)?.source).toBe("user");
    project(server("http://proj/mcp", "Bearer ptok"));
    expect(readTriliumMcp(repo, {}, home)).toMatchObject({ baseUrl: "http://proj", source: "project" });
  });

  test("a project placeholder does not fall back to the user scope (Claude Code uses the project entry too)", () => {
    user(server("http://user/mcp", "Bearer utok"));
    project(server("http://proj/mcp", "Bearer your-etapi-token"));
    expect(readTriliumMcp(repo, {}, home)).toMatchObject({ baseUrl: "http://proj", placeholder: true, source: "project" });
  });

  test("unusable entries are skipped: no url, a stdio server, unparsable or non-object files", () => {
    user(server("http://user/mcp", "Bearer utok"));
    project({ type: "stdio", command: "trilium-mcp" });
    expect(readTriliumMcp(repo, {}, home)?.source).toBe("user");
    writeFileSync(join(repo, ".mcp.json"), "{ half");
    expect(readTriliumMcp(repo, {}, home)?.source).toBe("user");
    writeFileSync(join(repo, ".mcp.json"), "null");
    expect(readTriliumMcp(repo, {}, home)?.source).toBe("user");
    writeFileSync(join(home, ".claude.json"), "[]");
    expect(readTriliumMcp(repo, {}, home)).toBeNull();
  });

  test("nothing configured anywhere → null; an empty homeDir skips the user scope", () => {
    expect(readTriliumMcp(repo, {}, home)).toBeNull();
    expect(readTriliumMcp(repo, {}, "")).toBeNull();
  });

  test("env FACTORY_TRILIUM_URL / FACTORY_ETAPI_TOKEN win over the files, each on its own", () => {
    project(server("http://proj/mcp", "Bearer your-etapi-token"));
    const both = { FACTORY_TRILIUM_URL: "http://env:1/", FACTORY_ETAPI_TOKEN: "etok" };
    expect(readTriliumMcp(repo, both, home)).toEqual({ baseUrl: "http://env:1", token: "etok", placeholder: false, source: "env" });
    // the token alone overrides a placeholder; the URL stays the project's
    expect(readTriliumMcp(repo, { FACTORY_ETAPI_TOKEN: "etok" }, home)).toEqual({ baseUrl: "http://proj", token: "etok", placeholder: false, source: "project" });
    expect(readTriliumMcp(repo, { FACTORY_TRILIUM_URL: "http://env" }, home)).toMatchObject({ baseUrl: "http://env", placeholder: true, source: "project" });
    // env alone, no files
    rmSync(join(repo, ".mcp.json"));
    expect(readTriliumMcp(repo, both, "")).toMatchObject({ source: "env", token: "etok" });
    // half an env and no file is not enough; empty strings count as unset
    expect(readTriliumMcp(repo, { FACTORY_TRILIUM_URL: "http://env" }, home)).toBeNull();
    expect(readTriliumMcp(repo, { FACTORY_TRILIUM_URL: "", FACTORY_ETAPI_TOKEN: "" }, home)).toBeNull();
  });
});
