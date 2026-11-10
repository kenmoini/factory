import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  describe("migrate-trilium", () => {
    const TOKEN = "SECRET-CANARY-7f3a91";
    function setup(global: Record<string, unknown> | null = { triliumUrl: "https://t.example/", etapiToken: TOKEN, dashboardPort: 7790 }) {
      const env = { FACTORY_CONFIG_DIR: mkdtempSync(join(tmpdir(), "fcfg-")) };
      const cfg = join(env.FACTORY_CONFIG_DIR, "config.json");
      if (global) writeFileSync(cfg, JSON.stringify(global));
      const repo = mkdtempSync(join(tmpdir(), "frepo-"));
      return { env, cfg, repo, mcp: join(repo, ".mcp.json"), gi: join(repo, ".gitignore") };
    }
    const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));
    const noToken = (r: { out: string; err: string }) => expect(r.out + r.err).not.toContain(TOKEN);

    test("writes the legacy URL + real token into <repo>/.mcp.json (0600, merged), strips the legacy keys, gitignores it, never prints the token", async () => {
      const { env, cfg, repo, mcp, gi } = setup();
      writeFileSync(mcp, JSON.stringify({ mcpServers: { other: { type: "stdio", command: "o" } }, extra: 1 }));
      writeFileSync(gi, "node_modules/");
      const r = await run(["migrate-trilium", "--repo", repo], env);
      expect(r.code).toBe(0);
      noToken(r);
      expect(JSON.parse(r.out)).toEqual({ migrated: true, mcpJson: mcp });
      expect(statSync(mcp).mode & 0o777).toBe(0o600);
      expect(readJson(mcp)).toEqual({
        mcpServers: {
          other: { type: "stdio", command: "o" },
          trilium: { type: "http", url: "https://t.example/mcp", headers: { Authorization: `Bearer ${TOKEN}` } },
        },
        extra: 1,
      });
      expect(readJson(cfg)).toEqual({ dashboardPort: 7790 });
      expect(statSync(cfg).mode & 0o777).toBe(0o600);
      expect(readFileSync(gi, "utf8")).toBe("node_modules/\n.mcp.json\n");

      const before = readFileSync(mcp, "utf8");
      const again = await run(["migrate-trilium", "--repo", repo], env);
      expect(again.code).toBe(0);
      expect(JSON.parse(again.out)).toEqual({ migrated: false });
      expect(readFileSync(mcp, "utf8")).toBe(before);
      expect(readFileSync(gi, "utf8")).toBe("node_modules/\n.mcp.json\n");
      expect(readJson(cfg)).toEqual({ dashboardPort: 7790 });
    });

    test("creates .mcp.json and .gitignore when absent; .gitignore entry is not duplicated", async () => {
      const { env, repo, mcp, gi } = setup({ triliumUrl: "http://localhost:8080/etapi", etapiToken: TOKEN });
      writeFileSync(gi, "dist/\n.mcp.json\n");
      const r = await run(["migrate-trilium", "--repo", repo], env);
      expect(r.code).toBe(0);
      noToken(r);
      expect(readJson(mcp).mcpServers.trilium.url).toBe("http://localhost:8080/mcp");
      expect(readFileSync(gi, "utf8")).toBe("dist/\n.mcp.json\n");
      const { env: env2, repo: repo2 } = setup();
      await run(["migrate-trilium", "--repo", repo2], env2);
      expect(readFileSync(join(repo2, ".gitignore"), "utf8")).toBe(".mcp.json\n");
    });

    test("nothing to migrate → {migrated:false}, no files written", async () => {
      for (const g of [null, { dashboardPort: 7777 }]) {
        const { env, repo, mcp, gi } = setup(g);
        const r = await run(["migrate-trilium", "--repo", repo], env);
        expect(r.code).toBe(0);
        expect(JSON.parse(r.out)).toEqual({ migrated: false });
        expect(existsSync(mcp)).toBe(false);
        expect(existsSync(gi)).toBe(false);
      }
    });

    test("an existing trilium entry with a real token is kept; a placeholder one is replaced", async () => {
      const kept = setup();
      const real = { type: "http", url: "https://new.example/mcp", headers: { Authorization: "Bearer newer" } };
      writeFileSync(kept.mcp, JSON.stringify({ mcpServers: { trilium: real } }));
      const r = await run(["migrate-trilium", "--repo", kept.repo], kept.env);
      expect(r.code).toBe(0);
      noToken(r);
      expect(JSON.parse(r.out)).toEqual({ migrated: true, mcpJson: kept.mcp, kept: true });
      expect(readJson(kept.mcp).mcpServers.trilium).toEqual(real);
      expect(readJson(kept.cfg)).toEqual({ dashboardPort: 7790 });

      const ph = setup();
      writeFileSync(ph.mcp, JSON.stringify({ mcpServers: { trilium: { type: "http", url: "https://old/mcp", headers: { Authorization: "Bearer your-etapi-token" } } } }));
      expect((await run(["migrate-trilium", "--repo", ph.repo], ph.env)).code).toBe(0);
      expect(readJson(ph.mcp).mcpServers.trilium.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    });

    test("a URL without a token migrates with the placeholder token", async () => {
      const { env, cfg, repo, mcp } = setup({ triliumUrl: "http://t:8080", dashboardPort: 7777 });
      const r = await run(["migrate-trilium", "--repo", repo], env);
      expect(JSON.parse(r.out)).toEqual({ migrated: true, mcpJson: mcp });
      expect(readJson(mcp).mcpServers.trilium.headers.Authorization).toBe("Bearer your-etapi-token");
      expect(readJson(cfg)).toEqual({ dashboardPort: 7777 });
    });

    test("refuses (exit 1, nothing changed, token not printed): invalid .mcp.json, tracked .mcp.json, token without URL, missing repo dir", async () => {
      const bad = setup();
      writeFileSync(bad.mcp, `{"mcpServers": {"x": "${TOKEN}"`);
      const r1 = await run(["migrate-trilium", "--repo", bad.repo], bad.env);
      expect(r1.code).toBe(1);
      noToken(r1);
      expect(JSON.parse(r1.out)).toEqual({ migrated: false, error: ".mcp.json is not valid JSON; fix or delete it" });
      expect(readJson(bad.cfg).etapiToken).toBe(TOKEN);

      const tracked = setup();
      const git = (a: string[]) => Bun.spawnSync(["git", "-C", tracked.repo, ...a]);
      git(["init", "-q"]);
      writeFileSync(tracked.mcp, JSON.stringify({ mcpServers: {} }));
      git(["add", ".mcp.json"]);
      const r2 = await run(["migrate-trilium", "--repo", tracked.repo], tracked.env);
      expect(r2.code).toBe(1);
      noToken(r2);
      expect(JSON.parse(r2.out).error).toContain("tracked by git");
      expect(readJson(tracked.mcp)).toEqual({ mcpServers: {} });
      expect(readJson(tracked.cfg).etapiToken).toBe(TOKEN);

      const tokOnly = setup({ etapiToken: TOKEN, dashboardPort: 7777 });
      const r3 = await run(["migrate-trilium", "--repo", tokOnly.repo], tokOnly.env);
      expect(r3.code).toBe(1);
      noToken(r3);
      expect(JSON.parse(r3.out).migrated).toBe(false);
      expect(existsSync(tokOnly.mcp)).toBe(false);

      const gone = setup();
      const r4 = await run(["migrate-trilium", "--repo", join(gone.repo, "nope")], gone.env);
      expect(r4.code).toBe(1);
      noToken(r4);
      expect(readJson(gone.cfg).etapiToken).toBe(TOKEN);
    });

    test("migrate-trilium needs --repo (usage, exit 2)", async () => {
      const { env } = setup();
      const r = await run(["migrate-trilium"], env);
      expect(r.code).toBe(2);
      expect(r.err).toContain("migrate-trilium");
    });
  });
});
