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
  test("only dashboardPort in the file: no Trilium config, no throw, TLS verification off", () => {
    write({ dashboardPort: 9000 });
    const c = loadConfig({ FACTORY_CONFIG_DIR: dir, HOME: "/h" });
    expect(c).toEqual({ port: 9000, pollMs: 3000, gitPollMs: 5000, configDir: dir, homeDir: "/h", tlsVerify: false });
  });
  test("no file, no env: defaults", () => {
    expect(loadConfig({ FACTORY_CONFIG_DIR: dir })).toEqual({ port: 7777, pollMs: 3000, gitPollMs: 5000, configDir: dir, homeDir: "", tlsVerify: false });
    writeFileSync(join(dir, "config.json"), "{ broken");
    expect(loadConfig({ FACTORY_CONFIG_DIR: dir }).port).toBe(7777);
  });
  test("legacy file keys are still read (global fallback), trailing slash stripped", () => {
    write({ triliumUrl: "http://t:8080/", etapiToken: "tok", dashboardPort: 9000 });
    const c = loadConfig({ FACTORY_CONFIG_DIR: dir, HOME: "/h" });
    expect(c).toEqual({ triliumUrl: "http://t:8080", etapiToken: "tok", port: 9000, pollMs: 3000, gitPollMs: 5000, configDir: dir, homeDir: "/h", tlsVerify: false });
  });
  test("env overrides file", () => {
    write({ triliumUrl: "http://file", etapiToken: "ftok", dashboardPort: 9000 });
    const c = loadConfig({ FACTORY_CONFIG_DIR: dir, FACTORY_TRILIUM_URL: "http://env/", FACTORY_ETAPI_TOKEN: "etok", FACTORY_DASHBOARD_PORT: "8123", FACTORY_POLL_MS: "500" });
    expect(c.triliumUrl).toBe("http://env");
    expect(c.etapiToken).toBe("etok");
    expect(c.port).toBe(8123);
    expect(c.pollMs).toBe(500);
  });
  test("FACTORY_GIT_POLL_MS sets gitPollMs; unset or invalid falls back to 5000", () => {
    expect(loadConfig({ FACTORY_CONFIG_DIR: dir, FACTORY_GIT_POLL_MS: "250" }).gitPollMs).toBe(250);
    expect(loadConfig({ FACTORY_CONFIG_DIR: dir }).gitPollMs).toBe(5000);
    expect(loadConfig({ FACTORY_CONFIG_DIR: dir, FACTORY_GIT_POLL_MS: "x" }).gitPollMs).toBe(5000);
  });
  test("FACTORY_TLS_VERIFY=1 turns TLS verification on; anything else leaves it off", () => {
    expect(loadConfig({ FACTORY_CONFIG_DIR: dir, FACTORY_TLS_VERIFY: "1" }).tlsVerify).toBe(true);
    expect(loadConfig({ FACTORY_CONFIG_DIR: dir, FACTORY_TLS_VERIFY: "0" }).tlsVerify).toBe(false);
    expect(loadConfig({ FACTORY_CONFIG_DIR: dir, FACTORY_TLS_VERIFY: "" }).tlsVerify).toBe(false);
  });
});
