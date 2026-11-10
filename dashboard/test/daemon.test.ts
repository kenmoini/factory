import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFixtureNotes, startFakeEtapi, type FakeEtapi } from "./integration/fake-etapi";

const daemon = join(import.meta.dir, "../src/daemon.ts");
let etapi: FakeEtapi;
let dir: string;
let port: number;
let env: Record<string, string>;

function run(cmd: string): { code: number; json: any } {
  const r = Bun.spawnSync([process.execPath, daemon, cmd], { env, stdout: "pipe", stderr: "pipe" });
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
