import { useEffect, useMemo, useRef, useState } from "react";
import { runInWorkstream } from "../../src/shared/agents";
import type { AgentRun, LiveAgent, Review, Reviewer, Task, TaskDetail, WorkstreamSnapshot } from "../../src/shared/types";
import { formatElapsed, useNow } from "../lib/clock";
import { useDetail, type Load } from "../lib/detail";
import { toSafeHtml } from "../lib/render";
import { dispatch, useStore } from "../lib/store";
import { statusLine } from "../lib/task-status";
import { agentName, stripId } from "./Kanban";
import { Steps, useAgentSteps } from "./Steps";

const REVIEWER_ORDER: Reviewer[] = ["security", "ux", "ui-design", "code"];
const VERDICT_CLASS = { PASS: "v-pass", CHANGES: "v-changes", PENDING: "v-pending" } as const;
const VERDICT_TEXT = { PASS: "Pass", CHANGES: "Changes requested", PENDING: "Pending" } as const;

const taskUrl = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;

/** `GET /api/tasks/:id` while the drawer is open; refetched when the task's note, status or round changes. */
function useTaskDetail(id: string | undefined, task: Task | undefined, attempt: number): Load<TaskDetail> {
  return useDetail<TaskDetail>(id ? taskUrl(id) : undefined, task ? `${task.modified}|${task.status}|${task.round}` : "", attempt);
}

type NoteLoad = { status: "loading" } | { status: "ready"; html: string } | { status: "error" };
const noteCache = new Map<string, string>();

/** A note body from `/api/docs/:id`, fetched the first time `id` is set and kept for the page's lifetime. */
function useNoteHtml(id: string | undefined): NoteLoad | undefined {
  const [load, setLoad] = useState<NoteLoad>();
  useEffect(() => {
    if (!id) return;
    const hit = noteCache.get(id);
    if (hit !== undefined) { setLoad({ status: "ready", html: hit }); return; }
    const ctrl = new AbortController();
    setLoad({ status: "loading" });
    (async () => {
      try {
        const res = await fetch(`/api/docs/${encodeURIComponent(id)}`, { cache: "no-store", signal: ctrl.signal });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body = (await res.json()) as { content: string; format: "html" | "markdown" };
        const html = toSafeHtml(body.content, body.format);
        noteCache.set(id, html);
        if (!ctrl.signal.aborted) setLoad({ status: "ready", html });
      } catch {
        if (!ctrl.signal.aborted) setLoad({ status: "error" });
      }
    })();
    return () => ctrl.abort();
  }, [id]);
  return id ? load : undefined;
}

function ReviewItem({ review }: { review: Review }) {
  const [open, setOpen] = useState(false);
  const note = useNoteHtml(open ? review.id : undefined);
  return (
    <li>
      <span className={`v ${VERDICT_CLASS[review.verdict]}`}>{review.reviewer || "reviewer"}</span>
      <details onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>{VERDICT_TEXT[review.verdict]}</summary>
        {note?.status === "loading" && <p className="drawer-state">Loading the review…</p>}
        {note?.status === "error" && <p className="drawer-state">The review note could not be loaded from Trilium.</p>}
        {note?.status === "ready" && <div className="rich review-note" dangerouslySetInnerHTML={{ __html: note.html }} />}
      </details>
    </li>
  );
}

function Reviews({ reviews }: { reviews: Review[] }) {
  const rounds = useMemo(() => {
    const by = new Map<number, Review[]>();
    for (const r of reviews) by.set(r.round, [...(by.get(r.round) ?? []), r]);
    const rank = (r: Review) => { const i = REVIEWER_ORDER.indexOf(r.reviewer); return i < 0 ? REVIEWER_ORDER.length : i; };
    return [...by.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([round, rs]) => ({ round, rs: [...rs].sort((a, b) => rank(a) - rank(b) || a.modified.localeCompare(b.modified)) }));
  }, [reviews]);
  if (rounds.length === 0) {
    return <section className="section"><h3>Reviews</h3><p className="empty">No reviews yet. The four reviewers run once the builder has finished.</p></section>;
  }
  return (
    <>
      {rounds.map(({ round, rs }) => (
        <section key={round} className="section">
          <h3>Reviews, round {round}</h3>
          <ul className="reviews">{rs.map((r) => <ReviewItem key={r.id} review={r} />)}</ul>
        </section>
      ))}
    </>
  );
}

const time = (iso?: string) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? undefined : t;
};

function Runs({ runs }: { runs: AgentRun[] }) {
  const sorted = useMemo(() => [...runs].sort((a, b) => (time(b.startedAt) ?? 0) - (time(a.startedAt) ?? 0)), [runs]);
  return (
    <section className="section">
      <h3>Agent runs</h3>
      {sorted.length === 0 ? <p className="empty">No agent has run on this task yet.</p> : (
        <ul className="runs">
          {sorted.map((r) => {
            const start = time(r.startedAt), end = time(r.endedAt);
            return (
              <li key={r.id}>
                <span className="run-agent">{agentName(r.agentType)}</span>
                <span className={`run-status run-${r.status}`}>{r.status}</span>
                <span className="run-time">
                  {start !== undefined && end !== undefined ? formatElapsed(end - start)
                    : start !== undefined ? <>started <time dateTime={r.startedAt}>{new Date(start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></>
                    : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function RunLine({ agents }: { agents: LiveAgent[] }) {
  const now = useNow();
  const start = Math.min(...agents.map((a) => time(a.startedAt) ?? Infinity));
  const label = agents.length === 1
    ? [agentName(agents[0].agentType), agents[0].model].filter(Boolean).join(" · ")
    : `${agents.length} ${agents.every((a) => a.agentType.endsWith("reviewer")) ? "reviewers" : "agents"}`;
  return (
    <div className="run-line">
      <span className="pulse" aria-hidden="true" />{label}
      {Number.isFinite(start) && <time>running {formatElapsed(now - start)}</time>}
    </div>
  );
}

function LiveSteps({ agents }: { agents: LiveAgent[] }) {
  const [picked, setPicked] = useState<string>();
  const agent = agents.find((a) => a.agentId === picked) ?? agents[0];
  const { steps, status } = useAgentSteps(agent.agentId);
  return (
    <section className="drawer-steps" aria-label="Live steps">
      <h3>Steps <span className="live-tag"><span className="pulse" aria-hidden="true" />Live</span></h3>
      {agents.length > 1 && (
        <div className="step-agents" role="group" aria-label="Show steps for">
          {agents.map((a) => (
            <button key={a.agentId} type="button" className="step-agent" aria-pressed={a.agentId === agent.agentId} onClick={() => setPicked(a.agentId)}>
              {agentName(a.agentType)}
            </button>
          ))}
        </div>
      )}
      <Steps key={agent.agentId} steps={steps} start={agent.startedAt} live empty={status === "loading" ? "Loading steps…" : "No steps yet. They appear as the agent works."} />
    </section>
  );
}

/**
 * The task drawer on the board: header, task spec, reviews by round (newest first, each note on demand),
 * approval, agent runs, and the live steps of the agent(s) working on the task. Escape or × closes it.
 * Rendered all the time so it can slide; it keeps the last task on screen while it slides shut.
 */
export function TaskDrawer({ snapshot }: { snapshot: WorkstreamSnapshot | null }) {
  const selected = useStore((s) => s.selectedTask);
  const liveById = useStore((s) => s.live);
  const [shown, setShown] = useState(selected);
  if (selected && selected !== shown) setShown(selected);
  const id = selected ?? shown;

  const [attempt, setAttempt] = useState(0);
  const snapTask = snapshot?.tasks.find((t) => t.id === id);
  const load = useTaskDetail(selected, snapTask, attempt);
  const detail = load.status === "ready" && !!id && load.url === taskUrl(id) ? load.detail : undefined;
  const task = snapTask ?? detail?.task;

  // reviews and runs come from the snapshot when it has the task, so they stay live between fetches
  const reviews = useMemo(() => (snapTask && snapshot ? snapshot.reviews.filter((r) => r.taskId === snapTask.taskId) : detail?.reviews ?? []), [snapshot, snapTask, detail]);
  const runs = useMemo(() => (snapTask && snapshot
    ? snapshot.runs.filter((r) => r.taskId === snapTask.taskId && runInWorkstream(r, snapshot.workstream?.slug))
    : detail?.runs ?? []), [snapshot, snapTask, detail]);
  const agents = useMemo(() => Object.values(liveById).filter((a) => !a.finishedAt && !!id && a.taskNoteId === id), [liveById, id]);
  const milestone = task ? snapshot?.milestones.find((m) => m.milestoneId === task.milestoneId) : undefined;
  const specHtml = useMemo(() => (detail?.spec ? toSafeHtml(detail.spec.content, detail.spec.format) : undefined), [detail]);
  const approvalHtml = useMemo(() => (detail?.approval ? toSafeHtml(detail.approval.content, "html") : undefined), [detail]);

  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) dispatch({ type: "select-task" }); };
    document.addEventListener("keydown", onKey);
    asideRef.current?.focus({ preventScroll: true });
    return () => document.removeEventListener("keydown", onKey);
  }, [selected]);

  // on close, focus goes back to the card that opened the drawer if it was inside the drawer
  const lastTaskId = useRef<string | undefined>(undefined);
  if (task) lastTaskId.current = task.taskId;
  useEffect(() => {
    if (selected) return;
    const aside = asideRef.current;
    const active = document.activeElement;
    if (!aside || !(aside.contains(active) || active === document.body) || !lastTaskId.current) return;
    document.querySelector<HTMLElement>(`.card[data-task="${CSS.escape(lastTaskId.current)}"] .card-open`)?.focus({ preventScroll: true });
  }, [selected]);

  const close = () => dispatch({ type: "select-task" });
  const isLive = agents.length > 0;

  return (
    <aside ref={asideRef} className={`drawer${isLive ? " is-live" : ""}`} aria-labelledby="drawer-title" aria-hidden={!selected || undefined} tabIndex={-1}>
      {!task ? (
        <div className="drawer-head">
          <div className="drawer-top">
            <button className="close" type="button" aria-label="Close task details" onClick={close}>&times;</button>
          </div>
          <h2 id="drawer-title">{load.status === "loading" ? "Loading task…" : "Task not found"}</h2>
          {load.status !== "loading" && <p className="drawer-state">This task is no longer in the workstream on the board. It may have been moved or deleted in Trilium.</p>}
        </div>
      ) : (
        <>
          <div className="drawer-head">
            <div className="drawer-top">
              <strong>{task.taskId}</strong>
              <span>{statusLine(task)}</span>
              <button className="close" type="button" aria-label="Close task details" onClick={close}>&times;</button>
            </div>
            <h2 id="drawer-title">{stripId(task.title, task.taskId)}</h2>
            <div className="drawer-facts">
              <span className="drawer-meta">
                {(milestone || task.milestoneId) && (
                  <span className="ms-chip" title={milestone?.title}><b>{task.milestoneId}</b>{milestone ? stripId(milestone.title, milestone.milestoneId) : ""}</span>
                )}
                {task.round > 0 && <span className="round" title={`Review round ${task.round}`}>R{task.round}</span>}
              </span>
              {(task.escalation || task.status === "blocked" || task.status === "needs-human") && (
                <span className="escalation">{task.escalation ?? (task.status === "blocked" ? "blocked" : "needs a human")}</span>
              )}
            </div>
            {isLive && <RunLine agents={agents} />}
          </div>

          <div className="drawer-body">
            <section className="section spec">
              <h3>Task spec</h3>
              {specHtml !== undefined ? <div className="rich" dangerouslySetInnerHTML={{ __html: specHtml }} />
                : load.status === "loading" ? <p className="drawer-state">Loading from Trilium…</p>
                : load.status === "error" ? (
                  <div className="empty drawer-error" role="alert">
                    <p>{load.code === 502 ? "Trilium did not answer the dashboard." : "The task details could not be loaded."}</p>
                    <button className="doc-retry" type="button" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
                  </div>
                )
                : <p className="empty">No task spec yet. The spec writer adds it before the build starts.</p>}
            </section>
            <Reviews reviews={reviews} />
            <section className="section">
              <h3>Approval</h3>
              {approvalHtml !== undefined ? <div className="rich approval" dangerouslySetInnerHTML={{ __html: approvalHtml }} />
                : <p className="approval">Not approved yet. The approver runs once all four reviewers pass in the same round.</p>}
            </section>
            <Runs runs={runs} />
          </div>

          {isLive && <LiveSteps agents={agents} />}
        </>
      )}
    </aside>
  );
}
