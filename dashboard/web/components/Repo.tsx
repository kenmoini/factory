import { memo, useEffect, useMemo, useState, type CSSProperties, type FocusEvent, type JSX, type KeyboardEvent, type ReactNode } from "react";
import type { LiveAgent, RepoBranch, RepoCommit, RepoSnapshot, WorkstreamSnapshot } from "../../src/shared/types";
import { formatAgo, useNow } from "../lib/clock";
import { layoutRail, type RailLayout } from "../lib/rail";
import { DEFAULT_REPO_VIEW, dispatch, useStore, type RepoView } from "../lib/store";
import { CommitDrawer } from "./CommitDrawer";
import { laneColour, Rail } from "./Rail";

const LIMITS = [50, 100, 200];
/** The server's cap on `limit`; `Load more` doubles up to it. */
const MAX_LIMIT = 500;
const VIEW_DEBOUNCE_MS = 300;

/**
 * Branches an agent is working on right now: the on-screen workstream's branch (its slug) while a live agent (no
 * `finishedAt`) runs on one of that workstream's tasks. The default branch never pulses.
 */
export function liveBranches(live: Record<string, LiveAgent>, snapshot: WorkstreamSnapshot | null, branches: RepoBranch[]): Set<string> {
  const out = new Set<string>();
  const slug = snapshot?.workstream?.slug;
  const branch = slug ? branches.find((b) => b.name === slug) : undefined;
  if (!snapshot || !branch || branch.isDefault) return out;
  const tasks = new Set(snapshot.tasks.map((t) => t.id));
  if (Object.values(live).some((a) => !a.finishedAt && !!a.taskNoteId && tasks.has(a.taskNoteId))) out.add(branch.name);
  return out;
}

const isDefaultView = (v: RepoView) => v.branch === undefined && v.limit === DEFAULT_REPO_VIEW.limit;

/** A branch's rail colour: the lane of its tip; a tip outside the list gets lane 0's colour if default, else neutral. */
function branchColour(b: RepoBranch, layout: RailLayout | null): string {
  const lane = layout?.laneOf[b.sha];
  return lane !== undefined ? laneColour(lane) : b.isDefault ? laneColour(0) : "var(--ink-3)";
}

interface ViewLoad { repoPath: string; snap: RepoSnapshot | null; failed: boolean }

/**
 * The snapshot for a non-default view (a branch filter or another limit) from `/api/repo`, fetched on mount and again
 * whenever the view or the live snapshot's fingerprint changes, 300 ms after the last change. A failed fetch keeps the
 * previous view on screen and sets `failed`. Returns nothing for the default view (the stream's snapshot is that view)
 * and forgets the last view then, so a later filter never starts from an older one.
 */
function useViewSnapshot(repoPath: string | undefined, view: RepoView, fingerprint: string | undefined): { snap: RepoSnapshot | null; failed: boolean } {
  const [load, setLoad] = useState<ViewLoad>();
  const active = !!repoPath && !isDefaultView(view);
  const { branch, limit } = view;
  useEffect(() => {
    if (!repoPath || !active) { setLoad(undefined); return; }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      const query = new URLSearchParams({ repo: repoPath, limit: String(limit) });
      if (branch !== undefined) query.set("branch", branch);
      try {
        const res = await fetch(`/api/repo?${query}`, { cache: "no-store", signal: ctrl.signal });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const snap = (await res.json()) as RepoSnapshot;
        if (!ctrl.signal.aborted) setLoad({ repoPath, snap, failed: false });
      } catch {
        if (!ctrl.signal.aborted) setLoad((prev) => ({ repoPath, snap: prev?.repoPath === repoPath ? prev.snap : null, failed: true }));
      }
    }, VIEW_DEBOUNCE_MS);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [repoPath, active, branch, limit, fingerprint]);
  return active && load?.repoPath === repoPath ? { snap: load.snap, failed: load.failed } : { snap: null, failed: false };
}

function Toolbar({ view, branches, layout, truncated }: { view: RepoView; branches: RepoBranch[]; layout: RailLayout | null; truncated: boolean }) {
  const setView = (next: RepoView) => dispatch({ type: "repo-view", data: next });
  const names = branches.map((b) => b.name);
  // a filter on a branch that has since gone stays selectable, so the select still shows what is applied
  if (view.branch !== undefined && !names.includes(view.branch)) names.push(view.branch);
  const limits = LIMITS.includes(view.limit) ? LIMITS : [...LIMITS, view.limit].sort((a, b) => a - b);
  return (
    <div className="repo-toolbar">
      <label className="pick"><span className="sr">Branch</span>
        <select value={view.branch ?? ""} onChange={(e) => setView({ branch: e.target.value || undefined, limit: view.limit })}>
          <option value="">All branches</option>
          {names.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <label className="pick"><span className="sr">Commits shown</span>
        <select value={view.limit} onChange={(e) => setView({ branch: view.branch, limit: Number(e.target.value) })}>
          {limits.map((n) => <option key={n} value={n}>Last {n} commits</option>)}
        </select>
      </label>
      {truncated && view.limit < MAX_LIMIT && (
        <button className="doc-retry" type="button" onClick={() => setView({ branch: view.branch, limit: Math.min(MAX_LIMIT, view.limit * 2) })}>
          Load more
        </button>
      )}
      {branches.length > 0 && (
        <ul className="repo-legend" aria-label="Branch colours">
          {branches.map((b) => (
            <li key={b.name} className="rail-legend" style={{ "--chip": branchColour(b, layout) } as CSSProperties}>
              <i aria-hidden="true" />{b.name}{b.worktree ? " · worktree" : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BranchChip({ name, colour, branch }: { name: string; colour: string; branch?: RepoBranch }) {
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

/** What the row's chips show that a screen reader should hear on focus: tip branches, worktree state, a live agent. */
function rowNote(commit: RepoCommit, branches: Map<string, RepoBranch>, live: Set<string>): string {
  const parts = commit.branches.map((name) => {
    const dirty = branches.get(name)?.worktree?.dirty;
    if (dirty === undefined) return `branch ${name}`;
    return dirty > 0 ? `branch ${name}, worktree with ${dirty} uncommitted ${dirty === 1 ? "change" : "changes"}` : `branch ${name}, worktree`;
  });
  if (commit.branches.some((b) => live.has(b))) parts.push("an agent is working on this branch");
  return parts.length > 0 ? `, ${parts.join("; ")}` : "";
}

interface RowProps {
  commit: RepoCommit; colour: string; ago: string; selected: boolean; tabbable: boolean;
  branches: Map<string, RepoBranch>; live: Set<string>; workstream?: string;
}

const Row = memo(function Row({ commit, colour, ago, selected, tabbable, branches, live, workstream }: RowProps) {
  const note = rowNote(commit, branches, live);
  return (
    <li className={selected ? "is-selected" : undefined}>
      <button
        className="row-open"
        type="button"
        data-sha={commit.sha}
        aria-current={selected || undefined}
        tabIndex={tabbable ? 0 : -1}
        onClick={() => dispatch({ type: "select-commit", data: commit.sha })}
      >
        <span className="row-sha">{commit.short}</span>
        <span className="row-subject">{commit.subject}</span>
        {note && <span className="sr">{note}</span>}
      </button>
      <span className="row-chips">
        <CommitChips commit={commit} colour={colour} branches={branches} live={live} workstream={workstream} />
      </span>
      <time className="row-time" dateTime={commit.authorTs}>{ago}</time>
    </li>
  );
});

interface RowsProps {
  commits: RepoCommit[]; layout: RailLayout; branches: Map<string, RepoBranch>; live: Set<string>; selected?: string; workstream?: string;
}

/** The commit list (the board's card pattern: one button per row); ArrowUp/ArrowDown move focus and the selection, Escape clears it. */
function Rows({ commits, layout, branches, live, selected, workstream }: RowsProps) {
  const now = useNow();
  const [focused, setFocused] = useState<string>();
  const has = (sha?: string) => !!sha && commits.some((c) => c.sha === sha);
  // one tab stop for the list: the selected row, else the row last focused, else the first
  const tabStop = has(selected) ? selected : has(focused) ? focused : commits[0]?.sha;

  const onFocus = (e: FocusEvent<HTMLUListElement>) => {
    const sha = (e.target as HTMLElement).dataset.sha;
    if (sha) setFocused(sha);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key === "Escape") {
      if (selected) { e.preventDefault(); dispatch({ type: "select-commit" }); }
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const i = commits.findIndex((c) => c.sha === (e.target as HTMLElement).dataset.sha);
    if (i < 0) return;
    e.preventDefault();
    const next = commits[i + (e.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    e.currentTarget.querySelector<HTMLButtonElement>(`.row-open[data-sha="${CSS.escape(next.sha)}"]`)?.focus();
    if (next.sha !== selected) dispatch({ type: "select-commit", data: next.sha });
  };

  return (
    <ul className="rail-rows" aria-label="Commits" onKeyDown={onKeyDown} onFocus={onFocus}>
      {commits.map((c) => (
        <Row
          key={c.sha}
          commit={c}
          colour={laneColour(layout.laneOf[c.sha] ?? 0)}
          ago={formatAgo(c.authorTs, now)}
          selected={c.sha === selected}
          tabbable={c.sha === tabStop}
          branches={branches}
          live={live}
          workstream={workstream}
        />
      ))}
    </ul>
  );
}

const status = (text: ReactNode) => <p className="board-status" role="status">{text}</p>;

/** The Repo tab: branch rails beside the commit rows, with a branch filter, a commit limit and a colour legend. */
export function Repo({ repoPath, snapshot }: { repoPath: string | undefined; snapshot: WorkstreamSnapshot | null }): JSX.Element {
  const repoSnapshot = useStore((s) => s.repoSnapshot);
  const view = useStore((s) => s.repoView);
  const selectedCommit = useStore((s) => s.selectedCommit);
  const live = useStore((s) => s.live);
  const connected = useStore((s) => s.connected);

  const defaultView = isDefaultView(view);
  const fetched = useViewSnapshot(repoPath, view, repoSnapshot?.fingerprint);
  // until a view's first answer arrives, the snapshot already on screen stays (Load more does not blank the list)
  const shown = defaultView ? repoSnapshot : fetched.snap ?? repoSnapshot;
  const failed = !defaultView && fetched.failed;

  const layout = useMemo(() => (shown && !shown.error ? layoutRail(shown.commits, shown.defaultBranch) : null), [shown]);
  const branches = useMemo(() => new Map((shown?.branches ?? []).map((b) => [b.name, b])), [shown]);
  const liveSet = useMemo(() => liveBranches(live, snapshot, shown?.branches ?? []), [live, snapshot, shown]);

  // the toolbar stays in a filtered view whatever arrives, so the filter can always be cleared
  const toolbarSource = shown && !shown.error ? shown : repoSnapshot && !repoSnapshot.error ? repoSnapshot : null;
  const showToolbar = !!(shown && !shown.error) || !defaultView;

  let body: ReactNode;
  if (!shown) body = failed ? null : status(connected ? "Reading the repository…" : "Connecting to the dashboard server…");
  else if (shown.error) body = status(shown.error);
  else if (shown.commits.length === 0 || !layout) body = status("No commits yet");
  else {
    body = (
      <div className="rail">
        <Rail layout={layout} commits={shown.commits} branches={shown.branches} defaultBranch={shown.defaultBranch} live={liveSet} selected={selectedCommit} />
        <Rows commits={shown.commits} layout={layout} branches={branches} live={liveSet} selected={selectedCommit} workstream={snapshot?.workstream?.slug} />
      </div>
    );
  }

  return (
    <section className={`repo-panel${selectedCommit ? " drawer-open" : ""}`} id="panel-repo" role="tabpanel" aria-labelledby="tab-repo">
      {repoPath && (
        <div className="repo-scroll">
          {showToolbar && <Toolbar view={view} branches={toolbarSource?.branches ?? []} layout={layout} truncated={!!shown?.truncated} />}
          {failed && <p className="repo-status" role="status">Could not refresh the view</p>}
          {body}
        </div>
      )}
      {repoPath && shown && <CommitDrawer repoPath={repoPath} shown={shown} snapshot={snapshot} layout={layout} branches={branches} live={liveSet} />}
    </section>
  );
}
