import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const config = JSON.parse(readFileSync(join(root, "hooks/hooks.json"), "utf8"));
const hooks = config.hooks;

type Hook = { type: string; command: string; async?: boolean; timeout?: number };
const entries = (event: string): Hook[] =>
  (hooks[event] ?? []).flatMap((g: { hooks: Hook[] }) => g.hooks);

describe("plugin hooks", () => {
  test("declares exactly the lifecycle events and no PostToolUse", () => {
    expect(hooks.SubagentStart).toBeDefined();
    expect(hooks.SubagentStop).toBeDefined();
    expect(hooks.SessionStart).toBeDefined();
    expect("PostToolUse" in hooks).toBe(false);
  });

  test("every hook is a command that references an existing executable script", () => {
    const all = Object.keys(hooks).flatMap(entries);
    expect(all.length).toBeGreaterThan(0);
    for (const h of all) {
      expect(h.type).toBe("command");
      expect(h.command).toContain("${CLAUDE_PLUGIN_ROOT}/bin/factory-event");
      const m = h.command.match(/^"([^"]+)"/);
      expect(m).not.toBeNull();
      const script = m![1].replace("${CLAUDE_PLUGIN_ROOT}/", root + "/");
      expect(existsSync(script)).toBe(true);
      expect(statSync(script).mode & 0o111).not.toBe(0);
    }
  });

  test("SubagentStart/Stop are async with timeout 5", () => {
    for (const [event, kind] of [["SubagentStart", "subagent-start"], ["SubagentStop", "subagent-stop"]]) {
      const e = entries(event);
      expect(e.length).toBe(1);
      expect(e[0].async).toBe(true);
      expect(e[0].timeout).toBe(5);
      expect(e[0].command.endsWith(` ${kind}`)).toBe(true);
    }
  });

  test("SessionStart is sync with matcher and timeout 3", () => {
    expect(hooks.SessionStart[0].matcher).toBe("startup|clear|compact");
    const e = entries("SessionStart");
    expect(e.length).toBe(1);
    expect(e[0].timeout).toBe(3);
    expect("async" in e[0]).toBe(false);
    expect(e[0].command.endsWith(" session-start")).toBe(true);
  });
});
