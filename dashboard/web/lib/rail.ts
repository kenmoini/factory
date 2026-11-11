import type { RepoCommit } from "../../src/shared/types";

export interface RailRow { sha: string; lane: number }
export interface RailLink { fromRow: number; toRow: number; fromLane: number; toLane: number; kind: "line" | "merge" | "fork" }
export interface RailLayout { rows: RailRow[]; links: RailLink[]; lanes: number; laneOf: Record<string, number> }

/**
 * Lane layout for a newest-first commit list. A commit takes the lane reserved for it by a child, else the
 * lowest free lane; it then reserves lanes for its parents (first parent keeps the lane, further parents get
 * the lowest free lane). The default branch tip is pre-reserved on lane 0 and, when a lane-0 commit finds its
 * first parent reserved elsewhere, that reservation moves to lane 0, so the default branch never leaves lane 0.
 * A lane stays occupied while an edge is in flight down it (git log --graph): when a commit's first parent is
 * already reserved on another lane, the commit's own lane stays taken until that parent's row, because the fork
 * runs down the child's lane and bends into the parent's lane only in the row above the parent. The lane-0 move
 * keeps the lane it moves away from occupied the same way, for the other child's fork. Merge links (further
 * parents) need no occupancy: they bend into the parent's reserved lane straight away.
 * Links go from each commit to each parent; a parent outside the list gets a stub to the bottom edge.
 */
export function layoutRail(commits: RepoCommit[], defaultBranch: string): RailLayout {
  const reserved = new Map<string, number>();
  /** lane → the parent sha whose row ends the fork edge running down that lane */
  const occupied = new Map<number, string>();
  const laneOf: Record<string, number> = {};
  const rowOf = new Map<string, number>(commits.map((c, i) => [c.sha, i]));

  const tip = commits.find((c) => c.branches.includes(defaultBranch));
  if (tip) reserved.set(tip.sha, 0);

  const lowestFreeLane = (extraOccupied: number): number => {
    const taken = new Set([...reserved.values(), ...occupied.keys(), extraOccupied]);
    let lane = 0;
    while (taken.has(lane)) lane++;
    return lane;
  };

  commits.forEach((commit) => {
    // fork edges that end at this row free their lanes
    for (const [l, sha] of occupied) if (sha === commit.sha) occupied.delete(l);
    const lane = reserved.get(commit.sha) ?? lowestFreeLane(-1);
    reserved.delete(commit.sha);
    laneOf[commit.sha] = lane;
    commit.parents.forEach((p, k) => {
      const at = reserved.get(p);
      if (!(p in laneOf) && at === undefined) { reserved.set(p, k === 0 ? lane : lowestFreeLane(lane)); return; }
      // a merge, a parent already laid out, or a straight line needs nothing more
      if (k !== 0 || at === undefined || at === lane) return;
      if (lane === 0) {
        // the default branch takes the parent; the other child's fork keeps running down the lane it leaves
        reserved.set(p, 0);
        occupied.set(at, p);
      } else {
        occupied.set(lane, p); // this commit's fork runs down its own lane to the parent's row
      }
    });
  });

  const links: RailLink[] = [];
  commits.forEach((commit, i) => {
    commit.parents.forEach((p, k) => {
      const j = rowOf.get(p);
      if (j === undefined) {
        links.push({ fromRow: i, toRow: commits.length, fromLane: laneOf[commit.sha], toLane: laneOf[commit.sha], kind: "line" });
        return;
      }
      const fromLane = laneOf[commit.sha], toLane = laneOf[p];
      links.push({ fromRow: i, toRow: j, fromLane, toLane, kind: fromLane === toLane ? "line" : k === 0 ? "fork" : "merge" });
    });
  });

  const lanes = commits.length === 0 ? 0 : 1 + Math.max(...Object.values(laneOf));
  return { rows: commits.map((c) => ({ sha: c.sha, lane: laneOf[c.sha] })), links, lanes, laneOf };
}
