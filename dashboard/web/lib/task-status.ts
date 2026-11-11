import { COLUMN_TITLES, columnFor } from "../../src/shared/columns";
import type { Task } from "../../src/shared/types";

/** A task's column, with the review round, fix round or merge where the status has one (the drawers' status line). */
export function statusLine(t: Task): string {
  const col = COLUMN_TITLES[columnFor(t)];
  if (t.status === "reviewing") return `${col}, round ${t.round}`;
  if (t.status === "fixing") return `${col}, fixing round ${t.round} findings`;
  if (t.status === "merging") return `${col}, merging`;
  return col;
}
