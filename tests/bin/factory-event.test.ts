import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string, repo: string, cfgDir: string, binDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fev-")); repo = join(dir, "repo"); cfgDir = join(dir, "cfg"); binDir = join(dir, "bin");
  mkdirSync(join(repo, ".factory"), { recursive: true }); mkdirSync(cfgDir); mkdirSync(binDir);
  writeFileSync(join(binDir, "curl"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/curl.args"\ncat > "${dir}/curl.body"\nexit 7\n`); chmodSync(join(binDir, "curl"), 0o755);
  writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ triliumUrl: "http://t", etapiToken: "x", dashboardPort: 7801 }));
});
async function run(args: string[], stdin: string, extraEnv: Record<string,string> = {}) {
  const p = Bun.spawn(["bin/factory-event", ...args], { stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, CLAUDE_PROJECT_DIR: repo, FACTORY_CONFIG_DIR: cfgDir, ...extraEnv } });
  return { code: await p.exited, out: await new Response(p.stdout).text() };
}
describe("factory-event", () => {
  test("no .factory/config.json → exit 0, no curl", async () => {
    const r = await run(["subagent-start"], "{}", { CLAUDE_PROJECT_DIR: dir });
    expect(r.code).toBe(0); expect(existsSync(join(dir, "curl.args"))).toBe(false);
  });
  test("posts wrapped body to configured port; curl failure still exits 0", async () => {
    writeFileSync(join(repo, ".factory/config.json"), JSON.stringify({ activeWorkstream: "demo" }));
    const r = await run(["subagent-start"], readFileSync("tests/fixtures/hooks/subagent-start.json", "utf8"));
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, "curl.args"), "utf8")).toContain("http://127.0.0.1:7801/api/events");
    const body = JSON.parse(readFileSync(join(dir, "curl.body"), "utf8"));
    expect(body.event).toBe("subagent-start"); expect(body.project).toBe(repo); expect(body.payload.agent_id).toBe("a1");
    expect(body.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  test("empty stdin → payload {} ; flags become fields", async () => {
    writeFileSync(join(repo, ".factory/config.json"), "{}");
    await run(["stage", "--stage", "execute", "--status", "started", "--task", "T-001"], "");
    const body = JSON.parse(readFileSync(join(dir, "curl.body"), "utf8"));
    expect(body.payload).toEqual({}); expect(body.stage).toBe("execute"); expect(body.status).toBe("started"); expect(body.task).toBe("T-001");
  });
  test("session-start prints context line with active workstream", async () => {
    writeFileSync(join(repo, ".factory/config.json"), JSON.stringify({ activeWorkstream: "demo" }));
    const r = await run(["session-start"], "{}");
    expect(r.out.trim()).toBe("Factory project detected (active workstream: demo). Run /factory:run status.");
  });
});
