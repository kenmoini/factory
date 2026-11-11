import type { JSX } from "react";
import type { RepoBranch, RepoCommit } from "../../src/shared/types";
import type { RailLayout, RailLink } from "../lib/rail";

export const ROW_H = 36;
export const LANE_W = 28;
export const RAIL_PAD = 18;

/** Six rail colours (`--rail-0` … `--rail-5` in styles.css), repeating past the sixth lane. */
export const laneColour = (lane: number) => `var(--rail-${lane % 6})`;

const laneX = (lane: number) => RAIL_PAD + lane * LANE_W;
const rowY = (row: number) => ROW_H / 2 + row * ROW_H;

/**
 * Git-graph links: a `line` runs straight down its lane; a `fork` (child to a first parent on another lane) runs down
 * the child's lane and bends into the parent's lane in the row above the parent; a `merge` (child to a further parent)
 * bends into the parent's lane in the row below the child, then runs down. A stub (parent outside the list) runs to
 * the bottom edge.
 */
function linkPath(l: RailLink, rows: number): string {
  const x1 = laneX(l.fromLane), x2 = laneX(l.toLane), y1 = rowY(l.fromRow);
  const y2 = l.toRow === rows ? ROW_H * rows : rowY(l.toRow);
  if (l.kind === "line" || l.toRow === rows) return `M ${x1} ${y1} V ${y2}`;
  if (l.kind === "fork") {
    const bend = y2 - ROW_H;
    return `M ${x1} ${y1} V ${bend} C ${x1} ${y2 - ROW_H / 2}, ${x2} ${y2 - ROW_H / 2}, ${x2} ${y2}`;
  }
  return `M ${x1} ${y1} C ${x1} ${y1 + ROW_H / 2}, ${x2} ${y1 + ROW_H / 2}, ${x2} ${y1 + ROW_H} V ${y2}`;
}

interface RailProps {
  layout: RailLayout;
  commits: RepoCommit[];
  branches: RepoBranch[];
  defaultBranch: string;
  live: Set<string>;
  selected?: string;
}

/** The branch rails beside the commit rows: one row of `ROW_H` per commit, lanes `LANE_W` apart. */
export function Rail({ layout, commits, branches, defaultBranch, live, selected }: RailProps): JSX.Element {
  const { rows, links } = layout;
  const lanes = Math.max(1, layout.lanes);
  const width = RAIL_PAD * 2 + LANE_W * (lanes - 1);
  const height = ROW_H * rows.length;
  const dirty = new Set(branches.filter((b) => (b.worktree?.dirty ?? 0) > 0).map((b) => b.name));

  return (
    <svg className="rail-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <g fill="none" strokeWidth={2} strokeLinecap="round">
        {links.map((l, i) => (
          <path key={i} d={linkPath(l, rows.length)} stroke={laneColour(Math.max(l.fromLane, l.toLane))} />
        ))}
      </g>
      {rows.map((row, i) => {
        const commit = commits[i];
        const colour = laneColour(row.lane);
        const cx = laneX(row.lane), cy = rowY(i);
        const isSelected = commit.sha === selected;
        const isDefaultTip = commit.branches.includes(defaultBranch);
        return (
          <g key={commit.sha}>
            {commit.branches.some((b) => dirty.has(b)) && (
              <circle cx={cx} cy={cy} r={9} fill="none" stroke={colour} strokeWidth={1} strokeDasharray="3 2" />
            )}
            {commit.branches.some((b) => live.has(b)) && (
              <circle cx={cx} cy={cy} r={10} fill="none" stroke="var(--lamp)" strokeWidth={1} opacity={0.5} />
            )}
            <circle
              cx={cx}
              cy={cy}
              r={isSelected || commit.isMerge ? 6 : 5}
              fill={isDefaultTip ? colour : "var(--floor)"}
              stroke={isSelected ? "var(--ink)" : colour}
              strokeWidth={2}
            />
          </g>
        );
      })}
    </svg>
  );
}
