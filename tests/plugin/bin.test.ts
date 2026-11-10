import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
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

describe("bin/", () => {
  const binDir = join(root, "bin");
  const files = readdirSync(binDir);

  test("contains all expected scripts", () => {
    for (const f of ["factory-config", "factory-event", "factory-preflight", "factory-worktree", "factory-review-package", "factory-merge", "factory-dashboard"]) {
      expect(files).toContain(f);
    }
  });

  test("every script is executable, starts with #!/bin/sh, and shims exec bun", () => {
    for (const f of files) {
      const p = join(binDir, f);
      expect(statSync(p).mode & 0o111).not.toBe(0);
      const text = readFileSync(p, "utf8");
      expect(text.split("\n")[0]).toBe("#!/bin/sh");
      if (f !== "factory-event") expect(text).toContain("exec bun");
    }
  });

  test("factory-dashboard status reports not running when nothing listens", () => {
    const cfg = mkdtempSync(join(tmpdir(), "factory-bin-"));
    try {
      const r = Bun.spawnSync([join(binDir, "factory-dashboard"), "status"], {
        env: { ...process.env, FACTORY_CONFIG_DIR: cfg, FACTORY_DASHBOARD_PORT: "59871" },
      });
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout.toString());
      expect(out.running).toBe(false);
      expect(typeof out.port).toBe("number");
    } finally {
      rmSync(cfg, { recursive: true, force: true });
    }
  });
});
