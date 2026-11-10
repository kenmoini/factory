import type { Column, Milestone, Task } from "./types";

export const COLUMN_ORDER: Column[] = ["backlog", "spec-writer", "builder", "reviewers", "approver", "needs-human", "done"];

export const COLUMN_TITLES: Record<Column, string> = {
  backlog: "Backlog",
  "spec-writer": "Spec Writer",
  builder: "Builder",
  reviewers: "Reviewers",
  approver: "Approver",
  "needs-human": "Needs Human",
  done: "Done",
};

export function columnFor(task: Pick<Task, "status">): Column {
  switch (task.status) {
    case "spec": return "spec-writer";
    case "building":
    case "fixing": return "builder";
    case "reviewing": return "reviewers";
    case "approving":
    case "merging": return "approver";
    case "needs-human":
    case "blocked": return "needs-human";
    case "done": return "done";
    default: return "backlog";
  }
}

export function sortTasks(tasks: Task[], milestones: Milestone[]): Task[] {
  const mo = new Map(milestones.map((m) => [m.milestoneId, m.order]));
  const rank = (t: Task) => mo.get(t.milestoneId) ?? Infinity;
  return [...tasks].sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra < rb ? -1 : 1;
    if (a.order !== b.order) return a.order - b.order;
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  });
}
