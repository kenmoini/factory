import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFixtureNotes, startFakeEtapi, type FakeEtapi } from "./integration/fake-etapi";

const daemon = join(import.meta.dir, "../src/daemon.ts");
let etapi: FakeEtapi;
let dir: string;
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
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
  port = probe.port as number;
  probe.stop(true);
  env = {
    ...(process.env as Record<string, string>),
    FACTORY_CONFIG_DIR: dir,
    FACTORY_TRILIUM_URL: etapi.url,
    FACTORY_ETAPI_TOKEN: etapi.token,
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

  test("start registers the factory repo it runs from, on a fresh spawn and when already running", async () => {
    const repo = (name: string, factory: boolean) => {
      const d = mkdtempSync(join(tmpdir(), `factory-daemon-${name}-`));
      if (factory) {
        mkdirSync(join(d, ".factory"));
        writeFileSync(join(d, ".factory/config.json"), JSON.stringify({ projectNoteId: "proj1", activeWorkstream: "demo", workstreams: { demo: { noteId: "ws1" } } }));
      }
      return realpathSync(d);
    };
    const a = repo("a", true), b = repo("b", true), plain = repo("plain", false);
    const listed = async () => ((await (await fetch(`http://127.0.0.1:${port}/api/repos`)).json()) as any).repos.map((r: any) => r.repoPath);
    try {
      const first = run("start", a);
      expect(first.code).toBe(0);
      expect(await listed()).toEqual([a]);
      const again = run("start", b); // already running: registers b too
      expect(again.json.pid).toBe(first.json.pid);
      expect((await listed()).sort()).toEqual([a, b].sort());
      expect(run("start", plain).code).toBe(0); // no .factory/config.json: nothing to register
      expect((await listed()).sort()).toEqual([a, b].sort());
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
