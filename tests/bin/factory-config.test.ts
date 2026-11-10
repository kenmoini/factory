import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function run(args: string[], env: Record<string, string>) {
  const p = Bun.spawn(["bin/factory-config", ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: await p.exited, out: (await new Response(p.stdout).text()).trim(), err: await new Response(p.stderr).text() };
}
describe("factory-config", () => {
  test("set then get global key; missing key exits 1", async () => {
    const env = { FACTORY_CONFIG_DIR: mkdtempSync(join(tmpdir(), "fcfg-")) };
    expect((await run(["set", "dashboardPort", "7788"], env)).code).toBe(0);
    expect((await run(["get", "dashboardPort"], env)).out).toBe("7788");
    expect((await run(["get", "etapiToken"], env)).code).toBe(1);
  });
  test("repo scope writes .factory/config.json", async () => {
    const repo = mkdtempSync(join(tmpdir(), "frepo-"));
    await run(["set", "activeWorkstream", "demo", "--repo", repo], {});
    expect((await run(["path", "--repo", repo], {})).out).toBe(join(repo, ".factory/config.json"));
    expect((await run(["get", "activeWorkstream", "--repo", repo], {})).out).toBe("demo");
  });
});
