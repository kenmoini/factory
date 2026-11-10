import { describe, expect, test } from "bun:test";
import { COLUMN_ORDER, COLUMN_TITLES, columnFor, sortTasks } from "../src/shared/columns";
import type { Milestone, Task } from "../src/shared/types";

const cases: [string, string][] = [
  ["todo", "backlog"],
  ["spec", "spec-writer"],
  ["building", "builder"],
  ["fixing", "builder"],
  ["reviewing", "reviewers"],
  ["approving", "approver"],
  ["merging", "approver"],
  ["needs-human", "needs-human"],
  ["blocked", "needs-human"],
  ["done", "done"],
  ["bogus", "backlog"],
];

describe("columnFor", () => {
  for (const [status, col] of cases) {
    test(`${status} -> ${col}`, () => {
      expect(columnFor({ status: status as Task["status"] })).toBe(col as never);
    });
  }
});

test("column constants", () => {
  expect(COLUMN_ORDER).toEqual(["backlog", "spec-writer", "builder", "reviewers", "approver", "needs-human", "done"]);
  expect(COLUMN_TITLES["needs-human"]).toBe("Needs Human");
  expect(COLUMN_ORDER.map((c) => COLUMN_TITLES[c])).toEqual(["Backlog", "Spec Writer", "Builder", "Reviewers", "Approver", "Needs Human", "Done"]);
});

const ms = (milestoneId: string, order: number): Milestone => ({ id: milestoneId, milestoneId, title: milestoneId, order, status: "open", modified: "" });
const t = (taskId: string, milestoneId: string, order: number): Task => ({ id: taskId, taskId, title: taskId, status: "todo", milestoneId, order, round: 0, dependsOn: [], modified: "" });

test("sortTasks orders by milestone, order, taskId without mutating", () => {
  const milestones = [ms("m2", 2), ms("m1", 1)];
  const tasks = [t("c", "zzz", 0), t("b", "m2", 1), t("a", "m1", 5)];
  const snapshot = tasks.map((x) => x.taskId);
  const out = sortTasks(tasks, milestones);
  expect(out.map((x) => x.taskId)).toEqual(["a", "b", "c"]);
  expect(tasks.map((x) => x.taskId)).toEqual(snapshot);
  expect(out).not.toBe(tasks);
});

test("sortTasks tie-breaks by task order then taskId", () => {
  const out = sortTasks([t("b", "m1", 1), t("a", "m1", 1), t("z", "m1", 0)], [ms("m1", 1)]);
  expect(out.map((x) => x.taskId)).toEqual(["z", "a", "b"]);
});
