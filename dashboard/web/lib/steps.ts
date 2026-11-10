import type { Step } from "../../src/shared/types";

/** One line of a step list. `key` is the seq of the step that opened the row. */
export type StepRow =
  | { kind: "text"; key: number; ts: string; text: string }
  | { kind: "tool"; key: number; ts: string; name: string; summary: string; toolUseId?: string; result?: "ok" | "err" }
  | { kind: "thinking"; key: number; ts: string; count: number };

/**
 * Folds steps into display rows. A result marks its tool row (matched by `toolUseId`) instead of adding a row,
 * and consecutive thinking blocks collapse into one row with a count.
 */
export function toRows(steps: Step[]): StepRow[] {
  const rows: StepRow[] = [];
  const tools = new Map<string, Extract<StepRow, { kind: "tool" }>>();
  for (const s of steps) {
    if (s.kind === "result") {
      const row = s.toolUseId ? tools.get(s.toolUseId) : undefined;
      if (row) row.result = s.isError ? "err" : "ok";
    } else if (s.kind === "thinking") {
      const last = rows[rows.length - 1];
      if (last?.kind === "thinking") last.count++;
      else rows.push({ kind: "thinking", key: s.seq, ts: s.ts, count: 1 });
    } else if (s.kind === "text") {
      const text = s.text?.trim();
      if (text) rows.push({ kind: "text", key: s.seq, ts: s.ts, text });
    } else {
      const row: Extract<StepRow, { kind: "tool" }> = { kind: "tool", key: s.seq, ts: s.ts, name: s.tool?.name || "tool", summary: s.tool?.summary ?? "", toolUseId: s.toolUseId };
      rows.push(row);
      if (s.toolUseId) tools.set(s.toolUseId, row);
    }
  }
  return rows;
}

/**
 * Adds the steps of `b` that are newer than the last step of `a` (both ordered by seq).
 * Returns `a` itself when nothing is new, so callers can skip a state update.
 */
export function mergeSteps(a: Step[], b: Step[]): Step[] {
  if (b.length === 0) return a;
  if (a.length === 0) return b;
  const last = a[a.length - 1].seq;
  const i = b.findIndex((s) => s.seq > last);
  return i < 0 ? a : a.concat(b.slice(i));
}
