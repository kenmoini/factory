import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("plugin manifest", () => {
  const manifest = JSON.parse(readFileSync(".claude-plugin/plugin.json", "utf8"));
  test("name is factory and kebab-case", () => {
    expect(manifest.name).toBe("factory");
    expect(manifest.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
  test("has version, description, author", () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof manifest.description).toBe("string");
    expect(manifest.author?.name).toBeTruthy();
  });
  test("claude plugin validate --strict passes", async () => {
    const proc = Bun.spawn(["claude", "plugin", "validate", ".", "--strict"], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    expect(code).toBe(0);
  });
});
