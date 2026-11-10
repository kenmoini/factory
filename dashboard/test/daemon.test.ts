import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFixtureNotes, startFakeEtapi, type FakeEtapi } from "./integration/fake-etapi";

const daemon = join(import.meta.dir, "../src/daemon.ts");
let etapi: FakeEtapi;
let dir: string;
let home: string;
let port: number;
let env: Record<string, string>;

function run(cmd: string, cwd?: string, script = daemon): { code: number; json: any } {
  const r = Bun.spawnSync([process.execPath, script, cmd], { env, cwd, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString().trim();
  let json: any = null;
  try { json = JSON.parse(out); } catch { /* leave null */ }
  return { code: r.exitCode ?? -1, json };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

beforeAll(() => {
  etapi = startFakeEtapi({ ...loadFixtureNotes(), token: "fake-token" }, { port: 0 });
  dir = mkdtempSync(join(tmpdir(), "factory-daemon-"));
  home = mkdtempSync(join(tmpdir(), "factory-daemon-home-")); // no ~/.claude.json: only a repo's .mcp.json names a Trilium
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
  port = probe.port as number;
  probe.stop(true);
  // no Trilium config at all in the env or the config dir: the daemon starts without it
  const { FACTORY_TRILIUM_URL: _u, FACTORY_ETAPI_TOKEN: _t, FACTORY_TLS_VERIFY: _v, NODE_TLS_REJECT_UNAUTHORIZED: _n, ...rest } = process.env as Record<string, string>;
  env = {
    ...rest,
    HOME: home,
    FACTORY_CONFIG_DIR: dir,
    FACTORY_DASHBOARD_PORT: String(port),
  };
});

afterAll(() => {
  try {
    const pid = Number(readFileSync(join(dir, "dashboard.pid"), "utf8").trim());
    if (pid && alive(pid)) process.kill(pid, "SIGKILL");
  } catch { /* no pidfile */ }
  etapi?.stop();
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("daemon lifecycle", () => {
  test("start / start / status / stop / status", async () => {
    const a = run("start");
    expect(a.code).toBe(0);
    expect(a.json.running).toBe(true);
    expect(a.json.port).toBe(port);
    expect(alive(a.json.pid)).toBe(true);
    const h = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(h.status).toBe(200);
    expect(((await h.json()) as any).trilium).toEqual({ ok: true }); // no repos yet, and no Trilium config needed to start

    const b = run("start");
    expect(b.code).toBe(0);
    expect(b.json.pid).toBe(a.json.pid);

    const s = run("status");
    expect(s.code).toBe(0);
    expect(s.json.running).toBe(true);
    expect(s.json.pid).toBe(a.json.pid);

    const st = run("stop");
    expect(st.code).toBe(0);
    expect(st.json).toEqual({ running: false, stopped: a.json.pid });
    expect(existsSync(join(dir, "dashboard.pid"))).toBe(false);
    expect(alive(a.json.pid)).toBe(false);
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();

    const s2 = run("status");
    expect(s2.code).toBe(0);
    expect(s2.json.running).toBe(false);
  }, 30000);

  test("start registers the factory repo it runs from, on a fresh spawn and when already running; Trilium creds come from its .mcp.json", async () => {
    const repo = (name: string, factory: boolean, mcp = false) => {
      const d = mkdtempSync(join(tmpdir(), `factory-daemon-${name}-`));
      if (factory) {
        mkdirSync(join(d, ".factory"));
        writeFileSync(join(d, ".factory/config.json"), JSON.stringify({ projectNoteId: "proj1", activeWorkstream: "demo", workstreams: { demo: { noteId: "ws1" } } }));
      }
      if (mcp) writeFileSync(join(d, ".mcp.json"), JSON.stringify({ mcpServers: { trilium: { type: "http", url: `${etapi.url}/mcp`, headers: { Authorization: `Bearer ${etapi.token}` } } } }));
      return realpathSync(d);
    };
    const a = repo("a", true, true), b = repo("b", true), plain = repo("plain", false);
    const base = `http://127.0.0.1:${port}`;
    const repos = async () => ((await (await fetch(`${base}/api/repos`)).json()) as any).repos;
    const listed = async () => (await repos()).map((r: any) => r.repoPath);
    try {
      const first = run("start", a);
      expect(first.code).toBe(0);
      expect(await listed()).toEqual([a]);
      expect((await repos())[0].trilium).toEqual({ baseUrl: etapi.url, placeholder: false, source: "project" });
      expect((await fetch(`${base}/api/state?repo=${encodeURIComponent(a)}`)).status).toBe(200);
      const again = run("start", b); // already running: registers b too
      expect(again.json.pid).toBe(first.json.pid);
      expect((await listed()).sort()).toEqual([a, b].sort());
      expect(run("start", plain).code).toBe(0); // no .factory/config.json: nothing to register
      expect((await listed()).sort()).toEqual([a, b].sort());
      // b has no .mcp.json and the home has no ~/.claude.json: registered, but not configured
      const sb = await fetch(`${base}/api/state?repo=${encodeURIComponent(b)}`);
      expect(sb.status).toBe(503);
      expect(await sb.json()).toEqual({ error: "trilium not configured" });
    } finally {
      run("stop"); // also when an assertion failed: a later test rewrites the pidfile, and afterAll could not find this server
      for (const d of [a, b, plain]) rmSync(d, { recursive: true, force: true });
    }
  }, 30000);

  test("start installs dashboard deps when node_modules is missing; a failed install exits 1", async () => {
    // a copy of the daemon in a dashboard dir without node_modules; server.ts is a stub that answers /api/health
    const root = mkdtempSync(join(tmpdir(), "factory-install-"));
    const dash = join(root, "dashboard");
    const cfg = join(root, "cfg");
    mkdirSync(join(dash, "src"), { recursive: true });
    for (const f of ["daemon.ts", "config.ts"]) copyFileSync(join(import.meta.dir, "../src", f), join(dash, "src", f));
    writeFileSync(join(dash, "src/server.ts"), `Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.FACTORY_DASHBOARD_PORT), fetch: () => Response.json({ ok: true }) });`);
    const saved = env;
    env = { ...env, FACTORY_CONFIG_DIR: cfg };
    try {
      writeFileSync(join(dash, "package.json"), "{ not json");
      const failed = run("start", undefined, join(dash, "src/daemon.ts"));
      expect(failed.code).toBe(1);
      expect(failed.json).toEqual({ running: false, error: "bun install failed", log: join(cfg, "dashboard.log") });
      expect(readFileSync(join(cfg, "dashboard.log"), "utf8")).toContain("package.json");
      expect(existsSync(join(cfg, "dashboard.pid"))).toBe(false);

      writeFileSync(join(dash, "package.json"), JSON.stringify({ name: "stub", private: true }));
      const ok = run("start", undefined, join(dash, "src/daemon.ts"));
      expect(ok.code).toBe(0);
      expect(ok.json.running).toBe(true);
      expect(existsSync(join(dash, "node_modules"))).toBe(true);
      expect(run("stop", undefined, join(dash, "src/daemon.ts")).json.stopped).toBe(ok.json.pid);
    } finally {
      env = saved;
      try { const pid = Number(readFileSync(join(cfg, "dashboard.pid"), "utf8")); if (pid && alive(pid)) process.kill(pid, "SIGKILL"); } catch { /* none */ }
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  test("the server is spawned with NODE_TLS_REJECT_UNAUTHORIZED=0 unless FACTORY_TLS_VERIFY=1, which removes an inherited one", async () => {
    // a copy of the daemon whose server.ts is a stub reporting the TLS env it was started with
    const root = mkdtempSync(join(tmpdir(), "factory-tls-"));
    const dash = join(root, "dashboard");
    const cfg = join(root, "cfg");
    mkdirSync(join(dash, "src"), { recursive: true });
    mkdirSync(join(dash, "node_modules")); // deps "installed": no bun install
    for (const f of ["daemon.ts", "config.ts"]) copyFileSync(join(import.meta.dir, "../src", f), join(dash, "src", f));
    writeFileSync(join(dash, "src/server.ts"),
      `Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.FACTORY_DASHBOARD_PORT), fetch: () => Response.json({ ok: true, tls: process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? null }) });`);
    const script = join(dash, "src/daemon.ts");
    const saved = env;
    const tlsEnv = async () => ((await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as any).tls;
    try {
      env = { ...saved, FACTORY_CONFIG_DIR: cfg };
      expect(run("start", undefined, script).json.running).toBe(true);
      expect(await tlsEnv()).toBe("0");
      expect(run("stop", undefined, script).code).toBe(0);

      // verification on: an inherited NODE_TLS_REJECT_UNAUTHORIZED=0 (e.g. from Claude Code's settings env) is dropped
      env = { ...saved, FACTORY_CONFIG_DIR: cfg, FACTORY_TLS_VERIFY: "1", NODE_TLS_REJECT_UNAUTHORIZED: "0" };
      expect(run("start", undefined, script).json.running).toBe(true);
      expect(await tlsEnv()).toBeNull();
      expect(run("stop", undefined, script).code).toBe(0);
    } finally {
      env = saved;
      try { const pid = Number(readFileSync(join(cfg, "dashboard.pid"), "utf8")); if (pid && alive(pid)) process.kill(pid, "SIGKILL"); } catch { /* none */ }
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  test("stale pidfile with an unrelated live pid is not killed", () => {
    const victim = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
    const pidFile = join(dir, "dashboard.pid");
    try {
      writeFileSync(pidFile, String(victim.pid));
      const st = run("stop");
      expect(st.code).toBe(0);
      expect(st.json).toEqual({ running: false, stale: true });
      expect(alive(victim.pid)).toBe(true);
      expect(existsSync(pidFile)).toBe(false);

      writeFileSync(pidFile, String(victim.pid));
      const s = run("start");
      expect(s.code).toBe(0);
      expect(s.json.running).toBe(true);
      expect(s.json.pid).not.toBe(victim.pid);
      expect(alive(victim.pid)).toBe(true);
      expect(run("stop").code).toBe(0);
    } finally {
      victim.kill("SIGKILL");
    }
  }, 30000);
});
