import type { AgentRun } from "./types";

/** The id in `[task:none]`: an agent dispatched without a task (examine, validate, set-standards). */
export const NO_TASK = "none";

/** The task note id from a `[task:<noteId>]` tag in an agent description; `[task:none]` and a missing tag give undefined. */
export function taskNoteIdOf(description?: string): string | undefined {
  const id = description?.match(/\[task:([^\]]+)\]/)?.[1].trim();
  return id && id !== NO_TASK ? id : undefined;
}

/**
 * Runs join tasks by `#taskId`, which repeats across workstreams (each starts at T-001): a run belongs to the workstream
 * on screen when its `#workstream` matches. Runs without the label (written before it existed) are kept.
 */
export function runInWorkstream(run: AgentRun, slug: string | undefined): boolean {
  return !run.workstream || run.workstream === slug;
}
