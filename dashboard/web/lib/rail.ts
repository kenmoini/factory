import type { RepoCommit } from "../../src/shared/types";

export interface RailRow { sha: string; lane: number }
export interface RailLink { fromRow: number; toRow: number; fromLane: number; toLane: number; kind: "line" | "merge" | "fork" }
export interface RailLayout { rows: RailRow[]; links: RailLink[]; lanes: number; laneOf: Record<string, number> }

/**
 * Lane layout for a newest-first commit list. A commit takes the lane reserved for it by a child, else the
 * lowest free lane; it then reserves lanes for its parents (first parent keeps the lane, further parents get
 * the lowest free lane). The default branch tip is pre-reserved on lane 0 and, when a lane-0 commit finds its
 * first parent reserved elsewhere, that reservation moves to lane 0, so the default branch never leaves lane 0.
 * Links go from each commit to each parent; a parent outside the list gets a stub to the bottom edge.
 */
export function layoutRail(commits: RepoCommit[], defaultBranch: string): RailLayout {
  const reserved = new Map<string, number>();
  const laneOf: Record<string, number> = {};
  const rowOf = new Map<string, number>(commits.map((c, i) => [c.sha, i]));

  const tip = commits.find((c) => c.branches.includes(defaultBranch));
  if (tip) reserved.set(tip.sha, 0);

  const lowestFreeLane = (extraOccupied: number): number => {
    const taken = new Set(reserved.values());
    taken.add(extraOccupied);
    let lane = 0;
    while (taken.has(lane)) lane++;
    return lane;
  };

  commits.forEach((commit) => {
    const lane = reserved.get(commit.sha) ?? lowestFreeLane(-1);
    reserved.delete(commit.sha);
    laneOf[commit.sha] = lane;
    commit.parents.forEach((p, k) => {
      const known = p in laneOf || reserved.has(p);
      if (!known) reserved.set(p, k === 0 ? lane : lowestFreeLane(lane));
      else if (k === 0 && lane === 0 && !(p in laneOf) && reserved.get(p) !== 0) reserved.set(p, 0);
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
