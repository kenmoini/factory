import { useEffect, useId, useRef, useState, type JSX } from "react";
import type { CommitDetail, RepoBranch, RepoSnapshot, RepoWorktree, TaskRef, WorkstreamSnapshot } from "../../src/shared/types";
import { formatAgo, useNow } from "../lib/clock";
import { useDetail } from "../lib/detail";
import type { RailLayout } from "../lib/rail";
import { dispatch, useStore } from "../lib/store";
import { statusLine } from "../lib/task-status";
import { CommitChips } from "./Chips";
import { stripId } from "./Kanban";
import { laneColour } from "./Rail";

/** How long `Copy sha` reads `Copied` (or `Copy failed`) before it reverts. */
const COPY_FLASH_MS = 1500;

const commitUrl = (sha: string, repoPath: string) => `/api/repo/commits/${encodeURIComponent(sha)}?${new URLSearchParams({ repo: repoPath })}`;

/** A worktree path relative to the repo root when it lies inside it (`.factory/worktrees/<slug>`), else as given. */
const relPath = (path: string, root: string) => (path.startsWith(root + "/") ? path.slice(root.length + 1) : path);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The commit's age, ticking on the shared clock without re-rendering the rest of the drawer. */
function Ago({ iso }: { iso: string }) {
  const ago = formatAgo(iso, useNow());
  if (!ago) return null;
  return <time dateTime={iso}>{ago === "now" ? "just now" : /^\d{4}-/.test(ago) ? `on ${ago}` : `${ago} ago`}</time>;
}

/** Facts for the commit's tip branches that have a worktree: path, ahead/behind the default branch, uncommitted files. */
function Worktrees({ trees, root, defaultBranch }: { trees: { branch: RepoBranch; worktree: RepoWorktree }[]; root: string; defaultBranch: string }) {
  if (trees.length === 0) return null;
  const many = trees.length > 1;
  return (
    <section className="section">
      <h3>{many ? "Worktrees" : "Worktree"}</h3>
      {trees.map(({ branch, worktree }) => (
        <dl key={branch.name} className="kv">
          {many && <><dt>branch</dt><dd>{branch.name}</dd></>}
          <dt>path</dt>
          <dd>{worktree.path === root ? "repository root" : <code>{relPath(worktree.path, root)}</code>}</dd>
          {!branch.isDefault && <><dt>vs {defaultBranch}</dt><dd>{branch.ahead} ahead · {branch.behind} behind</dd></>}
          {worktree.dirty > 0 && <><dt>working tree</dt><dd>{plural(worktree.dirty, "file", "files")} changed, not committed</dd></>}
        </dl>
      ))}
    </section>
  );
}

/**
 * One `[task]` link of the commit: a task of the on-screen workstream resolves through the snapshot (id, title,
 * milestone, status, round); one from another workstream, or one the snapshot no longer has, reads `slug/T-xxx`.
 */
function FactoryTask({ taskRef, snapshot }: { taskRef: TaskRef; snapshot: WorkstreamSnapshot | null }) {
  const labelId = useId();
  const task = snapshot?.workstream?.slug === taskRef.slug ? snapshot.tasks.find((t) => t.taskId === taskRef.taskId) : undefined;
  const milestone = task ? snapshot?.milestones.find((m) => m.milestoneId === task.milestoneId) : undefined;
  return (
    <li>
      <dl className="kv">
        <dt>task</dt>
        <dd id={labelId}>
          {task ? <><b>{task.taskId}</b> {stripId(task.title, task.taskId)}</> : <b>{taskRef.slug}/{taskRef.taskId}</b>}
        </dd>
        {task && (milestone || task.milestoneId) && (
          <>
            <dt>milestone</dt>
            <dd><span className="ms-chip" title={milestone?.title}><b>{task.milestoneId}</b>{milestone ? stripId(milestone.title, milestone.milestoneId) : ""}</span></dd>
          </>
        )}
        {task && (
          <>
            <dt>status</dt>
            <dd>{statusLine(task)}{task.round > 0 && <span className="round" title={`Review round ${task.round}`}>R{task.round}</span>}</dd>
          </>
        )}
      </dl>
      <button className="doc-retry" type="button" aria-describedby={labelId} onClick={() => dispatch({ type: "open-task", data: { ws: taskRef.slug, taskId: taskRef.taskId } })}>
        Open on board
      </button>
    </li>
  );
}

/** Copy sha (the label reads `Copied` or `Copy failed` for 1.5 s) and Show diff; keyed by sha, so the label resets per commit. */
function CommitButtons({ sha, onShowDiff, canShowDiff }: { sha: string; onShowDiff: () => void; canShowDiff: boolean }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onCopy = async () => {
    let ok = true;
    try { await navigator.clipboard.writeText(sha); } catch { ok = false; }
    clearTimeout(timer.current);
    setCopy(ok ? "copied" : "failed");
    timer.current = setTimeout(() => setCopy("idle"), COPY_FLASH_MS);
  };
  return (
    <div className="drawer-btns">
      <button className="doc-retry" type="button" onClick={onCopy}>{copy === "copied" ? "Copied" : copy === "failed" ? "Copy failed" : "Copy sha"}</button>
      <button className="doc-retry" type="button" disabled={!canShowDiff} onClick={onShowDiff}>Show diff</button>
      <span className="sr" role="status">{copy === "copied" ? "Commit sha copied" : copy === "failed" ? "The commit sha could not be copied" : ""}</span>
    </div>
  );
}

export interface CommitDrawerProps {
  repoPath: string;
  /** The repo snapshot on screen (the stream's, or a filtered view's); the drawer never reads the store's own. */
  shown: RepoSnapshot;
  snapshot: WorkstreamSnapshot | null;
  layout: RailLayout | null;
  branches: Map<string, RepoBranch>;
  /** Branches an agent is working on right now (`liveBranches`). */
  live: Set<string>;
}

/**
 * The commit drawer on the Repo tab: header (short sha, chips, subject, author and age), worktree facts for a tip
 * branch with a worktree, the message, changed files, factory context, parents, Copy sha and Show diff. Escape or ×
 * closes it. Rendered all the time so it can slide; it keeps the last commit on screen while it slides shut.
 */
export function CommitDrawer({ repoPath, shown, snapshot, layout, branches, live }: CommitDrawerProps): JSX.Element {
  const selected = useStore((s) => s.selectedCommit);
  const [last, setLast] = useState(selected);
  if (selected && selected !== last) setLast(selected);
  const sha = selected ?? last;
  const commit = sha ? shown.commits.find((c) => c.sha === sha) : undefined;

  const [attempt, setAttempt] = useState(0);
  // `GET /api/repo/commits/:sha` for a commit of the log on screen (one outside it is not fetched), refetched when the
  // repo snapshot's fingerprint changes (tips, worktrees, dirty counts)
  const load = useDetail<CommitDetail>(selected && commit ? commitUrl(selected, repoPath) : undefined, shown.fingerprint, attempt);
  const url = sha ? commitUrl(sha, repoPath) : undefined;
  const detail = load.status === "ready" && load.url === url ? load.detail : undefined;

  const asideRef = useRef<HTMLElement>(null);
  const changesRef = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (!selected) { wasOpen.current = false; return; }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) dispatch({ type: "select-commit" }); };
    document.addEventListener("keydown", onKey);
    // focus moves in when the drawer opens; once open, a selection made in the list (arrow keys, a click, a parent
    // whose row is listed) leaves focus on that row
    const active = document.activeElement;
    const inList = wasOpen.current && active instanceof HTMLElement && active.matches(".row-open");
    if (!inList) asideRef.current?.focus({ preventScroll: true });
    wasOpen.current = true;
    return () => document.removeEventListener("keydown", onKey);
  }, [selected]);

  // on close, focus goes back to the row that opened the drawer if it was inside the drawer
  useEffect(() => {
    if (selected || !last) return;
    const aside = asideRef.current;
    const active = document.activeElement;
    if (!aside || !(aside.contains(active) || active === document.body)) return;
    document.querySelector<HTMLElement>(`.row-open[data-sha="${CSS.escape(last)}"]`)?.focus({ preventScroll: true });
  }, [selected]);

  const close = () => dispatch({ type: "select-commit" });
  const openParent = (parent: string) => {
    dispatch({ type: "select-commit", data: parent });
    // to the parent's row when it is listed; otherwise focus stays in the drawer (the open effect takes it back)
    document.querySelector<HTMLElement>(`.row-open[data-sha="${CSS.escape(parent)}"]`)?.focus();
  };
  const isLive = !!commit && commit.branches.some((b) => live.has(b));
  const closeButton = <button className="close" type="button" aria-label="Close commit details" onClick={close}>&times;</button>;

  const trees = (commit?.branches ?? []).flatMap((name) => {
    const branch = branches.get(name);
    return branch?.worktree ? [{ branch, worktree: branch.worktree }] : [];
  });

  return (
    <aside ref={asideRef} className={`drawer commit-drawer${isLive ? " is-live" : ""}`} aria-labelledby="commit-drawer-title" aria-hidden={!selected || undefined} tabIndex={-1}>
      {!commit ? (
        <div className="drawer-head">
          <div className="drawer-top">{closeButton}</div>
          <h2 id="commit-drawer-title">Commit not in the log</h2>
          <p className="drawer-state">This commit is outside the commits shown. Widen the limit or clear the branch filter to find it.</p>
        </div>
      ) : (
        <>
          <div className="drawer-head">
            <div className="drawer-top">
              <strong>{commit.short}</strong>
              <span className="drawer-chips">
                <CommitChips commit={commit} colour={laneColour(layout?.laneOf[commit.sha] ?? 0)} branches={branches} live={live} workstream={snapshot?.workstream?.slug} />
              </span>
              {closeButton}
            </div>
            <h2 id="commit-drawer-title">{commit.subject}</h2>
            <div className="drawer-facts">
              <span className="commit-by">{commit.author} · <Ago iso={commit.authorTs} /></span>
              {isLive && <span className="sr">An agent is working on this branch.</span>}
            </div>
          </div>

          <div className="drawer-body">
            <Worktrees trees={trees} root={shown.repoPath} defaultBranch={shown.defaultBranch} />
            <section className="section">
              <h3>Message</h3>
              {detail ? (detail.body ? <pre className="commit-body">{detail.body}</pre> : <p className="drawer-state">No further message.</p>)
                : load.status === "error" && load.url === url ? (
                  <div className="empty drawer-error" role="alert">
                    <p>{load.code === 404 ? "This commit is no longer in the repository." : "The commit details could not be loaded."}</p>
                    <button className="doc-retry" type="button" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
                  </div>
                )
                : <p className="drawer-state">Loading the commit…</p>}
            </section>
            {detail && (
              <section ref={changesRef} className="section">
                <h3>
                  {`Changes · ${plural(detail.totals.files, "file", "files")} ·`}
                  <span className="plus">+{detail.totals.added}</span>
                  <span className="minus">−{detail.totals.deleted}</span>
                </h3>
                {detail.files.length === 0 ? <p className="drawer-state">No changes recorded.</p> : (
                  <ul className="files">
                    {detail.files.map((f, i) => (
                      <li key={`${i}:${f.path}`}>
                        <span className="path" title={f.path}>{f.path}</span>
                        {f.binary ? <span className="bin">binary</span> : (
                          <>
                            {f.added > 0 && <span className="plus">+{f.added}</span>}
                            {f.deleted > 0 && <span className="minus">−{f.deleted}</span>}
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
            <section className="section">
              <h3>Factory</h3>
              {commit.tasks.length === 0 ? <p className="drawer-state">Not linked to a task.</p> : (
                <ul className="commit-tasks">
                  {commit.tasks.map((t) => <FactoryTask key={`${t.slug}/${t.taskId}`} taskRef={t} snapshot={snapshot} />)}
                </ul>
              )}
            </section>
            {detail && (
              <section className="section">
                <h3>Parents</h3>
                {detail.parents.length === 0 ? <p className="drawer-state">Root commit.</p> : (
                  <ul>
                    {detail.parents.map((p) => (
                      <li key={p.sha}>
                        <button className="parent-open" type="button" onClick={() => openParent(p.sha)}>
                          <span className="row-sha">{p.short}</span>
                          <span>{p.subject}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
            <CommitButtons key={commit.sha} sha={commit.sha} canShowDiff={!!detail} onShowDiff={() => changesRef.current?.scrollIntoView({ block: "start" })} />
          </div>
        </>
      )}
    </aside>
  );
}
