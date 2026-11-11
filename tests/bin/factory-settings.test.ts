import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = async (args: string[]) => { const p = Bun.spawn(["bin/factory-settings", ...args], { stdout: "pipe", stderr: "pipe" }); return { code: await p.exited, out: (await new Response(p.stdout).text()).trim(), err: await new Response(p.stderr).text() }; };
const tmp = () => mkdtempSync(join(tmpdir(), "fset-"));
const noTemp = (dir: string) => expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);

describe("factory-settings env", () => {
  test("creates the file, merges into an existing env, keeps other keys and order, is idempotent", async () => {
    const dir = tmp(); const f = join(dir, ".claude", "settings.local.json");
    expect(await run(["env", f, "NODE_TLS_REJECT_UNAUTHORIZED=0"])).toMatchObject({ code: 0, out: "written" });
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } });
    writeFileSync(f, JSON.stringify({ permissions: { allow: ["Bash"] }, env: { FOO: "1" } }));
    expect((await run(["env", f, "NODE_TLS_REJECT_UNAUTHORIZED=0", "BAR=2"])).out).toBe("written");
    expect(readFileSync(f, "utf8")).toBe(JSON.stringify({ permissions: { allow: ["Bash"] }, env: { FOO: "1", NODE_TLS_REJECT_UNAUTHORIZED: "0", BAR: "2" } }, null, 2) + "\n");
    const before = statSync(f).mtimeMs;
    expect(await run(["env", f, "NODE_TLS_REJECT_UNAUTHORIZED=0"])).toMatchObject({ code: 0, out: "unchanged" });
    expect(statSync(f).mtimeMs).toBe(before);
    noTemp(join(dir, ".claude"));
  });
  test("an invalid file is reported and left byte-identical", async () => {
    const dir = tmp(); const f = join(dir, "s.json");
    for (const text of ["{ broken", "[]", JSON.stringify({ env: 5 })]) {
      writeFileSync(f, text);
      expect(await run(["env", f, "A=1"])).toMatchObject({ code: 1, out: "invalid" });
      expect(readFileSync(f, "utf8")).toBe(text);
    }
    noTemp(dir);
  });
  test("usage errors exit 2", async () => {
    expect((await run(["env", join(tmp(), "s.json"), "NOEQUALS"])).code).toBe(2);
    expect((await run(["bogus"])).code).toBe(2);
  });
});
describe("factory-settings mcp", () => {
  test("writes the trilium entry with a normalised url and mode 0600; keeps other servers", async () => {
    const dir = tmp(); const f = join(dir, ".mcp.json");
    expect(await run(["mcp", f, "trilium", "https://t.example:8443/etapi/"])).toMatchObject({ code: 0, out: "written" });
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ mcpServers: { trilium: { type: "http", url: "https://t.example:8443/mcp", headers: { Authorization: "Bearer your-etapi-token" } } } });
    expect(statSync(f).mode & 0o777).toBe(0o600);
    writeFileSync(f, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    expect((await run(["mcp", f, "trilium", "http://localhost:8080/mcp"])).out).toBe("written");
    expect(JSON.parse(readFileSync(f, "utf8")).mcpServers.other).toEqual({ command: "x" });
    expect(JSON.parse(readFileSync(f, "utf8")).mcpServers.trilium.url).toBe("http://localhost:8080/mcp");
    noTemp(dir);
  });
  test("an existing entry of that name is never overwritten", async () => {
    const dir = tmp(); const f = join(dir, ".mcp.json");
    const text = JSON.stringify({ mcpServers: { trilium: { type: "http", url: "http://x/mcp", headers: { Authorization: "Bearer real" } } } });
    writeFileSync(f, text);
    expect(await run(["mcp", f, "trilium", "http://y"])).toMatchObject({ code: 1, out: "exists" });
    expect(readFileSync(f, "utf8")).toBe(text);
    writeFileSync(f, "{ nope");
    expect((await run(["mcp", f, "trilium", "http://y"])).out).toBe("invalid");
    noTemp(dir);
  });
});
