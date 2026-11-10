import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwdSlug, readMeta, resolveTranscriptPath } from "../src/agents/transcript-path";

const home = mkdtempSync(join(tmpdir(), "factory-home-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

function place(cwd: string, session: string, id: string): string {
  const dir = join(home, ".claude/projects", cwdSlug(cwd), session, "subagents");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `agent-${id}.jsonl`);
  writeFileSync(p, "");
  return p;
}

describe("transcript-path", () => {
  test("cwdSlug", () => {
    expect(cwdSlug("/Users/kemo/.claude")).toBe("-Users-kemo--claude");
  });
  test("direct hit, glob hit, miss", () => {
    const p1 = place("/work/a", "s1", "x1");
    expect(resolveTranscriptPath({ homeDir: home, cwd: "/work/a", agentId: "x1", sessionId: "s1" })).toBe(p1);
    const p2 = place("/work/a", "s2", "x2");
    expect(resolveTranscriptPath({ homeDir: home, cwd: "/work/a", agentId: "x2" })).toBe(p2);
    expect(resolveTranscriptPath({ homeDir: home, cwd: "/work/a", agentId: "x2", sessionId: "other" })).toBe(p2);
    expect(resolveTranscriptPath({ homeDir: home, cwd: "/work/a", agentId: "nope" })).toBeNull();
    expect(resolveTranscriptPath({ homeDir: home, cwd: "/work/zzz", agentId: "x1" })).toBeNull();
  });
  test("rejects unsafe ids", () => {
    expect(resolveTranscriptPath({ homeDir: home, cwd: "/work/a", agentId: "../x1" })).toBeNull();
  });
  test("readMeta", () => {
    const p = place("/work/b", "s1", "m1");
    copyFileSync(join(import.meta.dir, "fixtures/transcripts/agent-sample.meta.json"), p.replace(/\.jsonl$/, ".meta.json"));
    expect(readMeta(p)?.description).toBe("builder T-001 [task:t001]");
    expect(readMeta(p)?.model).toBe("opus");
    expect(readMeta(join(home, "missing.jsonl"))).toBeNull();
    writeFileSync(p.replace(/\.jsonl$/, ".meta.json"), "{bad");
    expect(readMeta(p)).toBeNull();
  });
});
