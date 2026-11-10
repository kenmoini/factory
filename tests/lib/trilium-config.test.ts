import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLACEHOLDER_TOKEN, readTriliumMcp, tlsRejectUnauthorized } from "../../lib/trilium-config";

const tmp = (p = "tcfg-") => mkdtempSync(join(tmpdir(), p));
const entry = (url: string, auth?: string) => ({ type: "http", url, ...(auth === undefined ? {} : { headers: { Authorization: auth } }) });
function project(dir: string, trilium: unknown, other: Record<string, unknown> = {}) {
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { ...other, trilium } }));
}
function user(home: string, trilium: unknown) {
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ numStartups: 3, mcpServers: { trilium } }));
}

describe("readTriliumMcp", () => {
  test("project .mcp.json: base URL derived from <base>/mcp, Bearer prefix stripped", () => {
    const repo = tmp();
    project(repo, entry("https://t.example:8443/mcp", "Bearer s3cret"), { other: { type: "stdio", command: "x" } });
    expect(readTriliumMcp(repo, { HOME: tmp() })).toEqual({
      baseUrl: "https://t.example:8443",
      mcpUrl: "https://t.example:8443/mcp",
      token: "s3cret",
      placeholder: false,
      source: "project",
    });
  });

  test("baseUrl derivation strips trailing / and /mcp, keeps a sub-path", () => {
    const repo = tmp();
    const home = tmp();
    const base = (url: string) => {
      project(repo, entry(url, "Bearer t"));
      return readTriliumMcp(repo, { HOME: home })?.baseUrl;
    };
    expect(base("https://t.example/mcp/")).toBe("https://t.example");
    expect(base("https://t.example/trilium/mcp")).toBe("https://t.example/trilium");
    expect(base("http://localhost:8080/")).toBe("http://localhost:8080");
    expect(base("http://localhost:8080")).toBe("http://localhost:8080");
  });

  test("a raw token (no Bearer prefix) and a lower-case header name are accepted", () => {
    const repo = tmp();
    project(repo, { type: "http", url: "http://t/mcp", headers: { authorization: "rawtok" } });
    expect(readTriliumMcp(repo, { HOME: tmp() })?.token).toBe("rawtok");
  });

  test("placeholder token or empty/missing token → placeholder: true", () => {
    const repo = tmp();
    const home = tmp();
    project(repo, entry("http://t/mcp", `Bearer ${PLACEHOLDER_TOKEN}`));
    expect(PLACEHOLDER_TOKEN).toBe("your-etapi-token");
    expect(readTriliumMcp(repo, { HOME: home })).toMatchObject({ token: "your-etapi-token", placeholder: true, source: "project" });
    project(repo, entry("http://t/mcp", "Bearer "));
    expect(readTriliumMcp(repo, { HOME: home })).toMatchObject({ token: "", placeholder: true });
    project(repo, entry("http://t/mcp"));
    expect(readTriliumMcp(repo, { HOME: home })).toMatchObject({ token: "", placeholder: true });
  });

  test("falls back to user scope ~/.claude.json top-level mcpServers.trilium", () => {
    const repo = tmp();
    const home = tmp();
    user(home, entry("http://user.example/mcp", "Bearer utok"));
    expect(readTriliumMcp(repo, { HOME: home })).toEqual({
      baseUrl: "http://user.example",
      mcpUrl: "http://user.example/mcp",
      token: "utok",
      placeholder: false,
      source: "user",
    });
  });

  test("project scope wins over user scope", () => {
    const repo = tmp();
    const home = tmp();
    user(home, entry("http://user.example/mcp", "Bearer utok"));
    project(repo, entry("http://proj.example/mcp", "Bearer ptok"));
    expect(readTriliumMcp(repo, { HOME: home })).toMatchObject({ baseUrl: "http://proj.example", token: "ptok", source: "project" });
  });

  test("missing, invalid or non-http entries → user fallback, else null", () => {
    const repo = tmp();
    const home = tmp();
    expect(readTriliumMcp(repo, { HOME: home })).toBeNull();
    writeFileSync(join(repo, ".mcp.json"), '{"mcpServers": {"trilium": ');
    expect(readTriliumMcp(repo, { HOME: home })).toBeNull();
    project(repo, { type: "stdio", command: "trilium-mcp" });
    expect(readTriliumMcp(repo, { HOME: home })).toBeNull();
    writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { other: entry("http://o/mcp", "Bearer o") } }));
    expect(readTriliumMcp(repo, { HOME: home })).toBeNull();
    user(home, entry("http://user.example/mcp", "Bearer utok"));
    expect(readTriliumMcp(repo, { HOME: home })?.source).toBe("user");
    expect(readTriliumMcp(repo, {})).toBeNull();
  });

  test("${VAR} and ${VAR:-default} in url and header expand from env, as Claude Code does", () => {
    const repo = tmp();
    project(repo, entry("${TRILIUM_BASE:-http://fallback}/mcp", "Bearer ${TRILIUM_TOKEN}"));
    expect(readTriliumMcp(repo, { HOME: tmp(), TRILIUM_TOKEN: "fromenv" })).toMatchObject({ baseUrl: "http://fallback", token: "fromenv", placeholder: false });
    expect(readTriliumMcp(repo, { HOME: tmp(), TRILIUM_BASE: "https://b" })).toMatchObject({ baseUrl: "https://b", token: "", placeholder: true });
  });

  test("env FACTORY_TRILIUM_URL / FACTORY_ETAPI_TOKEN win (source env)", () => {
    const repo = tmp();
    const home = tmp();
    project(repo, entry("http://proj.example/mcp", "Bearer ptok"));
    expect(readTriliumMcp(repo, { HOME: home, FACTORY_TRILIUM_URL: "http://env.example/", FACTORY_ETAPI_TOKEN: "etok" })).toEqual({
      baseUrl: "http://env.example",
      mcpUrl: "http://env.example/mcp",
      token: "etok",
      placeholder: false,
      source: "env",
    });
    expect(readTriliumMcp(repo, { HOME: home, FACTORY_ETAPI_TOKEN: "etok" })).toMatchObject({ baseUrl: "http://proj.example", token: "etok", source: "env" });
    expect(readTriliumMcp(repo, { HOME: home, FACTORY_TRILIUM_URL: "http://env.example/mcp" })).toMatchObject({ baseUrl: "http://env.example", token: "ptok", source: "env" });
    expect(readTriliumMcp(tmp(), { HOME: home, FACTORY_TRILIUM_URL: "http://env.example", FACTORY_ETAPI_TOKEN: "etok" })?.source).toBe("env");
    expect(readTriliumMcp(tmp(), { HOME: home, FACTORY_ETAPI_TOKEN: "etok" })).toBeNull();
  });
});

describe("tlsRejectUnauthorized", () => {
  test("verification is off unless FACTORY_TLS_VERIFY=1", () => {
    expect(tlsRejectUnauthorized({})).toBe(false);
    expect(tlsRejectUnauthorized({ FACTORY_TLS_VERIFY: "0" })).toBe(false);
    expect(tlsRejectUnauthorized({ FACTORY_TLS_VERIFY: "true" })).toBe(false);
    expect(tlsRejectUnauthorized({ FACTORY_TLS_VERIFY: "1" })).toBe(true);
  });
});
