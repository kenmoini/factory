import { describe, expect, test } from "bun:test";
import { runInWorkstream, taskNoteIdOf } from "../src/shared/agents";
import type { AgentRun } from "../src/shared/types";

describe("taskNoteIdOf", () => {
  test("reads [task:<noteId>]; [task:none] and no tag give undefined", () => {
    expect(taskNoteIdOf("builder T-001 [task:t001]")).toBe("t001");
    expect(taskNoteIdOf("plan-adversary validate R1 [task:none]")).toBeUndefined();
    expect(taskNoteIdOf("no tag")).toBeUndefined();
    expect(taskNoteIdOf(undefined)).toBeUndefined();
  });
});

describe("runInWorkstream", () => {
  const run = (workstream?: string): AgentRun => ({ id: "r", title: "r", agentType: "builder", status: "done", taskId: "T-001", ...(workstream ? { workstream } : {}) });
  test("keeps the workstream's runs and unlabelled ones, drops other workstreams'", () => {
    expect(runInWorkstream(run("demo"), "demo")).toBe(true);
    expect(runInWorkstream(run("next"), "demo")).toBe(false);
    expect(runInWorkstream(run(), "demo")).toBe(true);
  });
});
