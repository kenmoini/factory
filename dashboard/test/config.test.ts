import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fcfg-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const write = (o: object) => writeFileSync(join(dir, "config.json"), JSON.stringify(o));

describe("loadConfig", () => {
  test("reads file, strips trailing slash, applies defaults", () => {
    write({ triliumUrl: "http://t:8080/", etapiToken: "tok", dashboardPort: 9000 });
    const c = loadConfig({ FACTORY_CONFIG_DIR: dir, HOME: "/h" });
    expect(c).toEqual({ triliumUrl: "http://t:8080", etapiToken: "tok", port: 9000, pollMs: 3000, configDir: dir, homeDir: "/h" });
  });
  test("env overrides file", () => {
    write({ triliumUrl: "http://file", etapiToken: "ftok", dashboardPort: 9000 });
    const c = loadConfig({ FACTORY_CONFIG_DIR: dir, FACTORY_TRILIUM_URL: "http://env/", FACTORY_ETAPI_TOKEN: "etok", FACTORY_DASHBOARD_PORT: "8123", FACTORY_POLL_MS: "500" });
    expect(c.triliumUrl).toBe("http://env");
    expect(c.etapiToken).toBe("etok");
    expect(c.port).toBe(8123);
    expect(c.pollMs).toBe(500);
  });
  test("env alone suffices; default port 7777", () => {
    const c = loadConfig({ FACTORY_CONFIG_DIR: dir, FACTORY_TRILIUM_URL: "http://e", FACTORY_ETAPI_TOKEN: "t" });
    expect(c.port).toBe(7777);
  });
  test("missing config throws no config", () => {
    expect(() => loadConfig({ FACTORY_CONFIG_DIR: dir })).toThrow("no config");
    write({ triliumUrl: "http://x" });
    expect(() => loadConfig({ FACTORY_CONFIG_DIR: dir })).toThrow("no config");
  });
});
