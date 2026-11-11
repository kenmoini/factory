import { describe, expect, test } from "bun:test";
import { LANE_W, linkPath, RAIL_PAD, ROW_H } from "../web/components/Rail";
import { layoutRail } from "../web/lib/rail";
import type { RepoCommit } from "../src/shared/types";

const c = (sha: string, parents: string[], branches: string[] = []): RepoCommit =>
  ({ sha, short: sha.slice(0, 7), parents, subject: sha, author: "t", authorTs: "2026-11-10T10:00:00Z", branches, tags: [], tasks: [], isMerge: parents.length > 1 });

describe("linkPath", () => {
  test("the rail geometry is pinned: ROW_H 36, LANE_W 28, RAIL_PAD 18", () => {
    expect([ROW_H, LANE_W, RAIL_PAD]).toEqual([36, 28, 18]);
  });
  test("line: straight down its lane", () => {
    expect(linkPath({ fromRow: 0, toRow: 2, fromLane: 1, toLane: 1, kind: "line" }, 5)).toBe("M 46 18 V 90");
  });
  test("fork: down the child's lane, bending into the parent's lane in the row above the parent", () => {
    expect(linkPath({ fromRow: 0, toRow: 3, fromLane: 2, toLane: 0, kind: "fork" }, 5)).toBe("M 74 18 V 90 C 74 108, 18 108, 18 126");
  });
  test("merge: bends into the parent's lane in the row below the child, then down", () => {
    expect(linkPath({ fromRow: 1, toRow: 4, fromLane: 0, toLane: 1, kind: "merge" }, 5)).toBe("M 18 54 C 18 72, 46 72, 46 90 V 162");
  });
  test("stub: a parent outside the list runs to the bottom edge", () => {
    expect(linkPath({ fromRow: 2, toRow: 5, fromLane: 1, toLane: 1, kind: "line" }, 5)).toBe("M 46 90 V 180");
  });
  test("sibling branches: neither fork's vertical run passes through the other's node", () => {
    const commits = [c("a1", ["P"], ["a"]), c("b1", ["P"], ["b"]), c("P", [], ["main"])];
    const layout = layoutRail(commits, "main");
    const node = (row: number) => ({ x: RAIL_PAD + layout.rows[row].lane * LANE_W, y: ROW_H / 2 + row * ROW_H });
    for (const [self, other] of [[0, 1], [1, 0]]) {
      const link = layout.links.find((l) => l.fromRow === self && l.kind === "fork")!;
      const [, x, y1, y2] = linkPath(link, commits.length).match(/^M (\d+) (\d+) V (\d+)/)!.map(Number);
      const o = node(other);
      const onRun = x === o.x && o.y >= Math.min(y1, y2) && o.y <= Math.max(y1, y2);
      expect(onRun).toBe(false);
    }
  });
});
