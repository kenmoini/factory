import type { CSSProperties } from "react";
import type { RepoBranch, RepoCommit } from "../../src/shared/types";

/** A branch head: the rail colour through `--chip`, a worktree mark, and the worktree's uncommitted count. */
export function BranchChip({ name, colour, branch }: { name: string; colour: string; branch?: RepoBranch }) {
  const dirty = branch?.worktree?.dirty ?? 0;
  return (
    <span className={`chip chip-branch${branch?.worktree ? " chip-wt" : ""}`} style={{ "--chip": colour } as CSSProperties}>
      {name}
      {dirty > 0 && <span aria-hidden="true">·{dirty}</span>}
    </span>
  );
}

export interface CommitChipsProps { commit: RepoCommit; colour: string; branches: Map<string, RepoBranch>; live: Set<string>; workstream?: string }

/**
 * A commit's chips, shared by its row and the commit drawer: tip branches in the commit's rail colour (worktree mark,
 * dirty count), tags, task ids (`T-003` for the on-screen workstream, else `slug/T-003`), and the lamp pulse while an
 * agent works on one of its branches.
 */
export function CommitChips({ commit, colour, branches, live, workstream }: CommitChipsProps) {
  return (
    <>
      {commit.branches.map((name) => <BranchChip key={name} name={name} colour={colour} branch={branches.get(name)} />)}
      {commit.tags.map((t) => <span key={t} className="chip chip-tag"><span className="sr">tag </span>{t}</span>)}
      {commit.tasks.map((t) => (
        <span key={`${t.slug}/${t.taskId}`} className="chip chip-task">{t.slug === workstream ? t.taskId : `${t.slug}/${t.taskId}`}</span>
      ))}
      {commit.branches.some((b) => live.has(b)) && <span className="pulse" aria-hidden="true" />}
    </>
  );
}
