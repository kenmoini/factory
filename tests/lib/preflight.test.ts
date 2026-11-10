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

function configDir(withGlobal: boolean): NodeJS.ProcessEnv {
  const home = tmp();
  const dir = join(home, "cfg");
  if (withGlobal) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ triliumUrl: "http://trilium.test", etapiToken: "tok", dashboardPort: 7777 }));
  }
  return { HOME: home, FACTORY_CONFIG_DIR: dir };
}

const gitExec = async (cmd: string[]) => {
  if (cmd[0] === "git") {
    const p = Bun.spawnSync(cmd);
    return { code: p.exitCode ?? 1, out: (p.stdout.toString() + p.stderr.toString()).trim() };
  }
  return { code: 0, out: "" };
};

describe("preflight", () => {
  test("happy path", async () => {
    const repo = makeRepo();
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/etapi/app-info")) return new Response(JSON.stringify({ appVersion: "0.107.0" }), { status: 200 });
      if (url.endsWith("/mcp")) return new Response("", { status: 405 });
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await preflight({ cwd: repo, env: configDir(true), fetchImpl, exec: gitExec });
    expect(r.config.global).toBe(true);
    expect(r.trilium.ok).toBe(true);
    expect(r.trilium.version).toBe("0.107.0");
    expect(r.trilium.mcpEndpoint).toBe(true);
    expect(r.trilium.mcpRegistered).toBe(true);
    expect(r.dashboard.running).toBe(false);
    expect(r.git.isRepo).toBe(true);
    expect(r.git.hasCommits).toBe(true);
    expect(r.git.dirty).toBe(false);
  });

  test("unreachable and hanging probes resolve within timeout", async () => {
    const env = configDir(true);
    const rej = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const r1 = await preflight({ cwd: tmp(), env, fetchImpl: rej, exec: gitExec });
    expect(r1.trilium.ok).toBe(false);
    expect(r1.trilium.error).toContain("ECONNREFUSED");

    const hang = (() => new Promise(() => {})) as unknown as typeof fetch;
    const hangExec = () => new Promise<{ code: number; out: string }>(() => {});
    const t0 = Date.now();
    const r2 = await preflight({ cwd: tmp(), env, fetchImpl: hang, exec: hangExec, timeoutMs: 500 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r2.trilium.ok).toBe(false);
  });

  test("no global config", async () => {
    const r = await preflight({ cwd: tmp(), env: configDir(false), fetchImpl: (async () => { throw new Error("x"); }) as unknown as typeof fetch, exec: gitExec });
    expect(r.config.global).toBe(false);
    expect(r.trilium.ok).toBe(false);
    expect(r.trilium.error).toBe("no config");
  });
});
