import { describe, expect, test } from "bun:test";
import { layoutRail } from "../web/lib/rail";
import type { RepoCommit } from "../src/shared/types";

const c = (sha: string, parents: string[], branches: string[] = []): RepoCommit =>
  ({ sha, short: sha.slice(0, 7), parents, subject: sha, author: "t", authorTs: "2026-11-10T10:00:00Z", branches, tags: [], tasks: [], isMerge: parents.length > 1 });

describe("layoutRail", () => {
  test("empty and linear histories use one lane", () => {
    expect(layoutRail([], "main")).toEqual({ rows: [], links: [], lanes: 0, laneOf: {} });
    const l = layoutRail([c("c3", ["c2"], ["main"]), c("c2", ["c1"]), c("c1", [])], "main");
    expect(l.lanes).toBe(1);
    expect(l.rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(l.links).toEqual([{ fromRow: 0, toRow: 1, fromLane: 0, toLane: 0, kind: "line" }, { fromRow: 1, toRow: 2, fromLane: 0, toLane: 0, kind: "line" }]);
  });
  test("a --no-ff merge: main keeps lane 0, the branch takes lane 1, with fork and merge links", () => {
    const l = layoutRail([c("M", ["m1", "b2"], ["main"]), c("b2", ["b1"], ["cf"]), c("b1", ["m1"]), c("m1", [])], "main");
    expect(l.lanes).toBe(2);
    expect(l.laneOf).toEqual({ M: 0, b2: 1, b1: 1, m1: 0 });
    expect(l.links).toEqual([
      { fromRow: 0, toRow: 3, fromLane: 0, toLane: 0, kind: "line" }, { fromRow: 0, toRow: 1, fromLane: 0, toLane: 1, kind: "merge" },
      { fromRow: 1, toRow: 2, fromLane: 1, toLane: 1, kind: "line" }, { fromRow: 2, toRow: 3, fromLane: 1, toLane: 0, kind: "fork" },
    ]);
  });
  test("two concurrent branches need three lanes and main stays on lane 0 even when it is not the newest commit", () => {
    const l = layoutRail([c("b2", ["b1"], ["cf"]), c("x1", ["m1"], ["billing"]), c("b1", ["m1"]), c("m2", ["m1"], ["main"]), c("m1", [])], "main");
    expect(l.lanes).toBe(3);
    expect(l.laneOf.m2).toBe(0); expect(l.laneOf.m1).toBe(0);
    expect(new Set([l.laneOf.b2, l.laneOf.x1]).size).toBe(2);
  });
  test("a parent outside the list gets a stub link to the bottom edge", () => {
    const l = layoutRail([c("c2", ["c1"], ["main"])], "main");
    expect(l.links).toEqual([{ fromRow: 0, toRow: 1, fromLane: 0, toLane: 0, kind: "line" }]);
  });
  test("300 linear commits stay on one lane", () => {
    const commits = Array.from({ length: 300 }, (_, i) => c(`c${300 - i}`, i < 299 ? [`c${299 - i}`] : [], i === 0 ? ["main"] : []));
    expect(layoutRail(commits, "main").lanes).toBe(1);
  });
});
