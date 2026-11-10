import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflight } from "../../lib/preflight";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "pf-"));
}

function makeRepo(): string {
  const d = tmp();
  const run = (a: string[]) => Bun.spawnSync(["git", "-C", d, ...a]);
  run(["init", "-q"]);
  run(["-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"]);
  return d;
}

/** Global config dir under a fresh HOME; `global` = the config.json content, or null for none. */
function configDir(global: Record<string, unknown> | null = { dashboardPort: 7777 }): NodeJS.ProcessEnv {
  const home = tmp();
  const dir = join(home, "cfg");
  if (global) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify(global));
  }
  return { HOME: home, FACTORY_CONFIG_DIR: dir };
}

function mcpJson(dir: string, token = "tok", url = "https://trilium.test/mcp", file = ".mcp.json") {
  const servers = { trilium: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } };
  writeFileSync(join(dir, file), JSON.stringify({ mcpServers: servers }));
}

const gitExec = async (cmd: string[]) => {
  if (cmd[0] === "git") {
    const p = Bun.spawnSync(cmd);
    return { code: p.exitCode ?? 1, out: (p.stdout.toString() + p.stderr.toString()).trim() };
  }
  return { code: 0, out: "" };
};

type Call = { url: string; init?: RequestInit & { tls?: { rejectUnauthorized?: boolean } } };
function recordingFetch(calls: Call[]) {
  return (async (url: string, init?: Call["init"]) => {
    calls.push({ url, init });
    if (url.endsWith("/etapi/app-info")) return new Response(JSON.stringify({ appVersion: "0.107.0" }), { status: 200 });
    if (url.endsWith("/mcp")) return new Response("", { status: 405 });
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
}
const header = (c: Call | undefined, h: string) => (c?.init?.headers as Record<string, string> | undefined)?.[h];

describe("preflight", () => {
  test("happy path: project .mcp.json, TLS verification off on every fetch", async () => {
    const repo = makeRepo();
    mcpJson(repo);
    const calls: Call[] = [];
    const r = await preflight({ cwd: repo, env: configDir(), fetchImpl: recordingFetch(calls), exec: gitExec });
    expect(r.config.global).toBe(true);
    expect(r.config.legacyTriliumKeys).toBe(false);
    expect(r.trilium).toEqual({
      configured: true,
      placeholder: false,
      source: "project",
      ok: true,
      url: "https://trilium.test",
      version: "0.107.0",
      mcpEndpoint: true,
      mcpRegistered: true,
    });
    expect(r.dashboard.running).toBe(false);
    expect(r.git.isRepo).toBe(true);
    expect(r.git.hasCommits).toBe(true);
    expect(r.git.dirty).toBe(true); // the untracked .mcp.json
    const appInfo = calls.find((c) => c.url === "https://trilium.test/etapi/app-info");
    const mcp = calls.find((c) => c.url === "https://trilium.test/mcp");
    expect(header(appInfo, "Authorization")).toBe("tok");
    expect(header(mcp, "Authorization")).toBe("Bearer tok");
    expect(calls.length).toBe(3); // app-info, mcp, dashboard health
    for (const c of calls) expect(c.init?.tls).toEqual({ rejectUnauthorized: false });
  });

  test("FACTORY_TLS_VERIFY=1 turns verification on", async () => {
    const repo = tmp();
    mcpJson(repo);
    const calls: Call[] = [];
    await preflight({ cwd: repo, env: { ...configDir(), FACTORY_TLS_VERIFY: "1" }, fetchImpl: recordingFetch(calls), exec: gitExec });
    expect(calls.length).toBe(3);
    for (const c of calls) expect(c.init?.tls).toEqual({ rejectUnauthorized: true });
  });

  test("reads .mcp.json at the git root when run from a subdirectory", async () => {
    const repo = makeRepo();
    mcpJson(repo);
    const sub = join(repo, "src");
    mkdirSync(sub);
    const r = await preflight({ cwd: sub, env: configDir(), fetchImpl: recordingFetch([]), exec: gitExec });
    expect(r.trilium).toMatchObject({ configured: true, source: "project", ok: true });
  });

  test("user-scope fallback (~/.claude.json)", async () => {
    const env = configDir();
    mcpJson(env.HOME!, "utok", "http://user.test/mcp/", ".claude.json");
    const calls: Call[] = [];
    const r = await preflight({ cwd: tmp(), env, fetchImpl: recordingFetch(calls), exec: gitExec });
    expect(r.trilium).toMatchObject({ configured: true, placeholder: false, source: "user", ok: true, url: "http://user.test" });
    expect(header(calls.find((c) => c.url === "http://user.test/etapi/app-info"), "Authorization")).toBe("utok");
  });

  test("placeholder token: configured, no Trilium request is made", async () => {
    const repo = tmp();
    mcpJson(repo, "your-etapi-token");
    const calls: Call[] = [];
    const r = await preflight({ cwd: repo, env: configDir(), fetchImpl: recordingFetch(calls), exec: gitExec });
    expect(r.trilium.configured).toBe(true);
    expect(r.trilium.placeholder).toBe(true);
    expect(r.trilium.source).toBe("project");
    expect(r.trilium.ok).toBe(false);
    expect(r.trilium.url).toBe("https://trilium.test");
    expect(r.trilium.error).toBe("token placeholder");
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:7777/api/health"]);
  });

  test("legacy keys in the global config are flagged, never used", async () => {
    const env = configDir({ triliumUrl: "http://legacy.test", etapiToken: "legacy", dashboardPort: 7790 });
    const calls: Call[] = [];
    const r = await preflight({ cwd: tmp(), env, fetchImpl: recordingFetch(calls), exec: gitExec });
    expect(r.config.global).toBe(true);
    expect(r.config.legacyTriliumKeys).toBe(true);
    expect(r.dashboard.port).toBe(7790);
    expect(r.trilium).toEqual({ configured: false, placeholder: false, ok: false, error: "not configured" });
    expect(calls.some((c) => c.url.includes("legacy"))).toBe(false);
    const tokOnly = await preflight({ cwd: tmp(), env: configDir({ etapiToken: "x" }), fetchImpl: recordingFetch([]), exec: gitExec });
    expect(tokOnly.config.legacyTriliumKeys).toBe(true);
  });

  test("unreachable and hanging probes resolve within timeout", async () => {
    const env = configDir();
    const repo = tmp();
    mcpJson(repo);
    const rej = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r1 = await preflight({ cwd: repo, env, fetchImpl: rej, exec: gitExec });
    expect(r1.trilium.configured).toBe(true);
    expect(r1.trilium.ok).toBe(false);
    expect(r1.trilium.error).toContain("ECONNREFUSED");

    const hang = (() => new Promise(() => {})) as unknown as typeof fetch;
    const hangExec = () => new Promise<{ code: number; out: string }>(() => {});
    const t0 = Date.now();
    const r2 = await preflight({ cwd: repo, env, fetchImpl: hang, exec: hangExec, timeoutMs: 500 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r2.trilium.ok).toBe(false);
  });

  test("HTTP error from ETAPI is reported", async () => {
    const repo = tmp();
    mcpJson(repo);
    const f = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const r = await preflight({ cwd: repo, env: configDir(), fetchImpl: f, exec: gitExec });
    expect(r.trilium).toMatchObject({ configured: true, ok: false, error: "HTTP 401" });
  });

  test("no global config and no trilium entry", async () => {
    const r = await preflight({ cwd: tmp(), env: configDir(null), fetchImpl: (async () => { throw new Error("x"); }) as unknown as typeof fetch, exec: gitExec });
    expect(r.config.global).toBe(false);
    expect(r.config.legacyTriliumKeys).toBe(false);
    expect(r.trilium).toEqual({ configured: false, placeholder: false, ok: false, error: "not configured" });
  });

  test("throwing config read degrades instead of rejecting", async () => {
    const env = {
      HOME: tmp(),
      get FACTORY_CONFIG_DIR(): string {
        throw new Error("boom");
      },
    } as unknown as NodeJS.ProcessEnv;
    const r = await preflight({ cwd: tmp(), env, fetchImpl: (async () => { throw new Error("x"); }) as unknown as typeof fetch, exec: gitExec });
    expect(r.config.global).toBe(false);
    expect(r.config.legacyTriliumKeys).toBe(false);
    expect(r.trilium).toEqual({ configured: false, placeholder: false, ok: false, error: "not configured" });
    expect(Object.keys(r).sort()).toEqual(["config", "dashboard", "factory", "git", "graphify", "tools", "trilium"]);
  });
});
