import { describe, expect, test } from "bun:test";
import { liveBranches } from "../web/components/Repo";
import type { LiveAgent, RepoBranch, WorkstreamSnapshot } from "../src/shared/types";
const ws = (slug: string, taskIds: string[]): WorkstreamSnapshot => ({ project: { id: "p", title: "p", repo: "p", repoPath: "/p", labels: {}, modified: "" }, workstream: { id: slug, slug, title: slug, status: "executing", labels: {}, modified: "" }, workstreams: [], milestones: [],
  tasks: taskIds.map((id) => ({ id, taskId: id, title: id, status: "building" as const, milestoneId: "M1", order: 1, round: 0, dependsOn: [], modified: "" })), docs: [], reviews: [], runs: [], live: [], fingerprint: "f" });
const agent = (id: string, taskNoteId?: string, finishedAt?: string): LiveAgent => ({ agentId: id, agentType: "factory:builder", cwd: "/p", startedAt: "2026-11-10T10:00:00Z", stepCount: 0, taskNoteId, finishedAt });
const branches: RepoBranch[] = [{ name: "main", sha: "a", isDefault: true, ahead: 0, behind: 0 }, { name: "demo", sha: "b", isDefault: false, ahead: 1, behind: 0 }];
describe("liveBranches", () => {
  test("the on-screen workstream's branch is live while an agent works on one of its tasks", () => {
    expect([...liveBranches({ a1: agent("a1", "t1") }, ws("demo", ["t1"]), branches)]).toEqual(["demo"]);
    expect(liveBranches({ a1: agent("a1", "t9") }, ws("demo", ["t1"]), branches).size).toBe(0);
    expect(liveBranches({ a1: agent("a1", "t1", "2026-11-10T11:00:00Z") }, ws("demo", ["t1"]), branches).size).toBe(0);
    expect(liveBranches({ a1: agent("a1", "t1") }, ws("main", ["t1"]), branches).size).toBe(0);   // the default branch never pulses
    expect(liveBranches({}, null, branches).size).toBe(0);
  });
});
