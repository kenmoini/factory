import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EtapiNote } from "../src/trilium/client";
import { fingerprint, labelsOf, toAgentRun, toDoc, toMilestone, toProject, toReview, toTask, toWorkstream } from "../src/trilium/mapper";

const load = (f: string): EtapiNote[] => JSON.parse(readFileSync(join(import.meta.dir, "fixtures/etapi", `${f}.json`), "utf8")).results;
const byId = (ns: EtapiNote[], id: string) => ns.find((n) => n.noteId === id)!;

describe("labelsOf", () => {
  test("last label wins, relations ignored", () => {
    const n = { ...load("project")[0], attributes: [
      { attributeId: "x1", noteId: "p", type: "label", name: "a", value: "1", position: 1, isInheritable: false },
      { attributeId: "x2", noteId: "p", type: "label", name: "a", value: "2", position: 2, isInheritable: false },
      { attributeId: "x3", noteId: "p", type: "relation", name: "rel", value: "zzz", position: 3, isInheritable: false },
    ] } as EtapiNote;
    expect(labelsOf(n)).toEqual({ a: "2" });
  });
});

describe("mappers", () => {
  test("toProject", () => {
    const p = toProject(load("project")[0]);
    expect(p).toMatchObject({ id: "proj1", title: "demo-repo", repo: "demo-repo", repoPath: "/work/demo-repo", modified: "2026-11-10 10:00:00.000Z" });
    expect(p.labels.projectKind).toBe("greenfield");
  });
  test("toWorkstream", () => {
    expect(toWorkstream(load("workstreams")[0])).toMatchObject({ id: "ws1", slug: "demo", title: "demo", status: "executing" });
  });
  test("toMilestone", () => {
    const [m1, m2] = load("milestones").map(toMilestone);
    expect(m1).toMatchObject({ id: "m1", milestoneId: "M1", order: 1, status: "active" });
    expect(m2).toMatchObject({ milestoneId: "M2", order: 2, status: "todo" });
  });
  test("toTask", () => {
    const ts = load("tasks");
    expect(toTask(byId(ts, "t001"))).toMatchObject({ taskId: "T-001", status: "done", milestoneId: "M1", order: 1, round: 0, dependsOn: [] });
    const t2 = toTask(byId(ts, "t002"));
    expect(t2).toMatchObject({ status: "reviewing", round: 1, agentId: "a1", builderAgentId: "a1", dependsOn: ["T-001"] });
    expect(t2.escalation).toBeUndefined();
    expect(toTask(byId(ts, "t003")).dependsOn).toEqual(["T-001", "T-002"]);
    const t4 = toTask(byId(ts, "t004"));
    expect(t4).toMatchObject({ status: "needs-human", escalation: "builder failed twice", dependsOn: ["T-002", "T-003"] });
    expect(t4.agentId).toBeUndefined();
  });
  test("toTask defaults for malformed task", () => {
    const t = toTask(byId(load("tasks"), "t005"));
    expect(t).toMatchObject({ status: "todo", order: 0, round: 0, dependsOn: [] });
  });
  test("toTask unknown status falls back to todo", () => {
    const n = structuredClone(byId(load("tasks"), "t001"));
    n.attributes.find((a) => a.name === "status")!.value = "bogus";
    expect(toTask(n).status).toBe("todo");
  });
  test("toDoc", () => {
    const [d1, d2, d3] = load("docs").map(toDoc);
    expect(d1).toMatchObject({ id: "d1", kind: "goal", format: "html", parentId: "proj1" });
    expect(d2).toMatchObject({ kind: "spec", format: "html" });
    expect(d3).toMatchObject({ kind: "api-design", format: "markdown" });
  });
  test("toDoc unknown kind", () => {
    const n = { ...load("docs")[0], attributes: [] };
    expect(toDoc(n).kind).toBe("unknown");
  });
  test("toReview", () => {
    const [r1, r2] = load("reviews").map(toReview);
    expect(r1).toMatchObject({ taskId: "T-002", round: 1, reviewer: "security", verdict: "PASS" });
    expect(r2).toMatchObject({ reviewer: "code", verdict: "CHANGES" });
    const n = structuredClone(load("reviews")[0]);
    n.attributes = n.attributes.filter((a) => a.name !== "verdict");
    expect(toReview(n).verdict).toBe("PENDING");
  });
  test("toAgentRun", () => {
    expect(toAgentRun(load("runs")[0])).toMatchObject({ id: "run1", agentType: "builder", agentId: "a1", status: "running", taskId: "T-002", startedAt: "2026-11-10T10:00:00Z" });
    expect(toAgentRun(load("runs")[0]).endedAt).toBeUndefined();
  });
});

describe("fingerprint", () => {
  const notes = [...load("tasks"), ...load("reviews")];
  test("order independent", () => {
    expect(fingerprint(notes)).toBe(fingerprint([...notes].reverse()));
    expect(fingerprint(notes)).toMatch(/^[0-9a-f]{64}$/);
  });
  test("changes when utcDateModified changes", () => {
    const changed = structuredClone(notes);
    changed[0].utcDateModified = "2026-11-10 11:00:00.000Z";
    expect(fingerprint(changed)).not.toBe(fingerprint(notes));
  });
  test("changes when status changes", () => {
    const changed = structuredClone(notes);
    changed[0].attributes.find((a) => a.name === "status")!.value = "blocked";
    expect(fingerprint(changed)).not.toBe(fingerprint(notes));
  });
});
