import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  test("--repo with no value is a usage error (exit 2), never a silent fall-back to the global config", async () => {
    const env = { FACTORY_CONFIG_DIR: mkdtempSync(join(tmpdir(), "fcfg-")) };
    const r = await run(["set", "activeWorkstream", "demo", "--repo"], env);
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage:");
    expect((await run(["get", "activeWorkstream"], env)).code).toBe(1);
    expect((await run(["get", "activeWorkstream", "--repo"], env)).code).toBe(2);
    expect((await run(["path", "--repo", ""], env)).code).toBe(2);
  });
  test("set refuses to overwrite an existing config.json that is not valid JSON", async () => {
    const repo = mkdtempSync(join(tmpdir(), "frepo-"));
    mkdirSync(join(repo, ".factory"));
    const file = join(repo, ".factory/config.json");
    writeFileSync(file, '{"projectNoteId": "n1",');
    const r = await run(["set", "activeWorkstream", "demo", "--repo", repo], {});
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual({ error: "config.json is not valid JSON; fix or delete it" });
    expect(readFileSync(file, "utf8")).toBe('{"projectNoteId": "n1",');
    const env = { FACTORY_CONFIG_DIR: mkdtempSync(join(tmpdir(), "fcfg-")) };
    writeFileSync(join(env.FACTORY_CONFIG_DIR, "config.json"), "not json");
    const g = await run(["set", "dashboardPort", "7788"], env);
    expect(g.code).toBe(1);
    expect(JSON.parse(g.out)).toEqual({ error: "config.json is not valid JSON; fix or delete it" });
    expect(readFileSync(join(env.FACTORY_CONFIG_DIR, "config.json"), "utf8")).toBe("not json");
  });
});
