import { describe, expect, test } from "bun:test";
import { AgentRegistry } from "../src/agents/registry";

const base = { agentType: "factory:builder", cwd: "/r1" };

describe("AgentRegistry", () => {
  test("start parses task note id", () => {
    const r = new AgentRegistry();
    const a = r.start({ ...base, agentId: "a1", description: "builder T-001 [task:n1]" });
    expect(a.taskNoteId).toBe("n1");
    expect(a.stepCount).toBe(0);
    expect(r.list().live).toHaveLength(1);
    expect(r.get("a1")).toBe(a);
  });
  test("stop moves to recent, touch merges", () => {
    const r = new AgentRegistry();
    r.start({ ...base, agentId: "a1" });
    r.touch("a1", { stepCount: 3 });
    const s = r.stop("a1", { transcriptPath: "/t.jsonl" })!;
    expect(s.finishedAt).toBeTruthy();
    expect(s.stepCount).toBe(3);
    expect(s.transcriptPath).toBe("/t.jsonl");
    const l = r.list();
    expect(l.live).toHaveLength(0);
    expect(l.recent.map((x) => x.agentId)).toEqual(["a1"]);
    expect(r.get("a1")?.finishedAt).toBeTruthy();
    expect(r.stop("nope")).toBeUndefined();
  });
  test("recent cap drops oldest, TTL prunes", () => {
    let t = 1_000_000;
    const r = new AgentRegistry({ recentCap: 2, recentTtlMs: 1000, now: () => t });
    for (const id of ["a", "b", "c"]) { r.start({ ...base, agentId: id }); t += 10; r.stop(id); t += 10; }
    expect(r.list().recent.map((x) => x.agentId)).toEqual(["c", "b"]);
    t += 2000;
    r.prune();
    expect(r.list().recent).toHaveLength(0);
    expect(r.get("b")).toBeUndefined();
  });
  test("list(cwd) filters", () => {
    const r = new AgentRegistry();
    r.start({ ...base, agentId: "a1" });
    r.start({ ...base, cwd: "/r2", agentId: "a2" });
    r.stop("a2");
    expect(r.list("/r1").live.map((x) => x.agentId)).toEqual(["a1"]);
    expect(r.list("/r1").recent).toHaveLength(0);
    expect(r.list("/r2").recent).toHaveLength(1);
  });
  test("onEvict fires for cap and TTL evictions", () => {
    let t = 1_000_000;
    const r = new AgentRegistry({ recentCap: 1, recentTtlMs: 1000, now: () => t });
    const ev: string[] = [];
    r.onEvict((id) => ev.push(id));
    for (const id of ["a", "b"]) { r.start({ ...base, agentId: id }); r.stop(id); t += 10; }
    expect(ev).toEqual(["a"]);
    t += 2000;
    r.prune();
    expect(ev).toEqual(["a", "b"]);
  });
});
