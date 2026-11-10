import { describe, expect, test } from "bun:test";
import type { Step } from "../src/shared/types";
import { mergeSteps, toRows } from "../web/lib/steps";

const ts = "2026-11-10T10:00:00Z";
const text = (seq: number, t = `t${seq}`): Step => ({ seq, ts, kind: "text", text: t });
const think = (seq: number): Step => ({ seq, ts, kind: "thinking" });
const tool = (seq: number, id: string, name = "Bash"): Step => ({ seq, ts, kind: "tool", tool: { name, summary: `s${seq}` }, toolUseId: id });
const result = (seq: number, id: string, isError = false): Step => ({ seq, ts, kind: "result", toolUseId: id, isError });

describe("toRows", () => {
  test("results mark their tool row instead of adding a row", () => {
    const rows = toRows([tool(0, "a"), tool(1, "b"), result(2, "b", true), result(3, "a")]);
    expect(rows).toEqual([
      { kind: "tool", key: 0, ts, name: "Bash", summary: "s0", toolUseId: "a", result: "ok" },
      { kind: "tool", key: 1, ts, name: "Bash", summary: "s1", toolUseId: "b", result: "err" },
    ]);
  });

  test("consecutive thinking blocks collapse into one counted row; a result does not break the run", () => {
    const rows = toRows([think(0), think(1), text(2), think(3), tool(4, "x"), think(5), result(6, "x"), think(7)]);
    expect(rows.map((r) => (r.kind === "thinking" ? `think×${r.count}` : r.kind))).toEqual(["think×2", "text", "think×1", "tool", "think×2"]);
  });

  test("blank text is skipped; a result with no matching tool is dropped", () => {
    expect(toRows([text(0, "  "), result(1, "nope")])).toEqual([]);
  });
});

describe("mergeSteps", () => {
  test("appends only steps newer than the last one held", () => {
    const a = [text(0), text(1), text(2)];
    expect(mergeSteps(a, [text(1), text(2), text(3), text(4)]).map((s) => s.seq)).toEqual([0, 1, 2, 3, 4]);
  });
  test("returns the first list itself when nothing is new", () => {
    const a = [text(0), text(1)];
    expect(mergeSteps(a, [text(1)])).toBe(a);
    expect(mergeSteps(a, [])).toBe(a);
  });
  test("an empty first list yields the second", () => {
    const b = [text(5)];
    expect(mergeSteps([], b)).toBe(b);
  });
});
