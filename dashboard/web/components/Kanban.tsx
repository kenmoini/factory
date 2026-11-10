import { Fragment, useMemo } from "react";
import { runInWorkstream } from "../../src/shared/agents";
import { COLUMN_ORDER, COLUMN_TITLES, columnFor, sortTasks } from "../../src/shared/columns";
import type { AgentRun, Column, LiveAgent, Milestone, Review, Reviewer, Task, WorkstreamSnapshot } from "../../src/shared/types";
import { formatElapsed, useNow } from "../lib/clock";
import { dispatch, useStore } from "../lib/store";

const REVIEWERS: Reviewer[] = ["security", "ux", "ui-design", "code"];
const VERDICT_CLASS = { PASS: "v-pass", CHANGES: "v-changes", PENDING: "v-pending" } as const;
const VERDICT_TEXT = { PASS: "pass", CHANGES: "changes requested", PENDING: "pending" } as const;

/** Titles are written as `T-NNN <title>` / `M<n> <title>`; the id is shown separately, so drop the prefix. */
export function stripId(title: string, id: string): string {
  return id && title.startsWith(id + " ") ? title.slice(id.length + 1).trim() || title : title;
}

/** Plugin agent types are namespaced (`factory:builder`); the board shows the bare name. */
export const agentName = (type: string) => type.replace(/^factory:/, "") || "agent";

const time = (iso?: string) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? undefined : t;
};

/** Who is working on (or last worked on) a task, for the card's agent line. */
interface AgentLine { label: string; live: boolean; start?: number; end?: number; ticking: boolean }

function agentLine(task: Task, live: LiveAgent[], runs: AgentRun[]): AgentLine | undefined {
  if (live.length > 0) {
    const start = Math.min(...live.map((a) => time(a.startedAt) ?? Infinity));
    let label: string;
    if (live.length === 1) label = live[0].model ? `${agentName(live[0].agentType)} · ${live[0].model}` : agentName(live[0].agentType);
    else label = `${live.length} ${live.every((a) => a.agentType.endsWith("reviewer")) ? "reviewers" : "agents"}`;
    return { label, live: true, start: Number.isFinite(start) ? start : undefined, ticking: true };
  }
  if (runs.length === 0) return undefined;
  // latest run by start time; runs arrive newest-modified first, which breaks ties
  const latest = runs.reduce((a, b) => ((time(b.startedAt) ?? -Infinity) > (time(a.startedAt) ?? -Infinity) ? b : a));
  const start = time(latest.startedAt), end = time(latest.endedAt);
  return { label: agentName(latest.agentType), live: false, start, end, ticking: latest.status === "running" && end === undefined };
}

function Elapsed({ start, end, ticking }: { start: number; end?: number; ticking: boolean }) {
  return ticking ? <Ticking start={start} /> : end !== undefined ? <time>{formatElapsed(end - start)}</time> : null;
}

function Ticking({ start }: { start: number }) {
  const now = useNow();
  return <time>{formatElapsed(now - start)}</time>;
}

function Verdicts({ task, reviews }: { task: Task; reviews: Review[] }) {
  const latest = new Map<Reviewer, Review>();
  for (const r of reviews) {
    if (r.round !== task.round) continue;
    const prev = latest.get(r.reviewer);
    if (!prev || r.modified > prev.modified) latest.set(r.reviewer, r);
  }
  return (
    <div className="verdicts">
      {REVIEWERS.map((who) => {
        const v = latest.get(who)?.verdict;
        return (
          <span key={who} className={`v ${v ? VERDICT_CLASS[v] : "v-missing"}`}>
            {who}<span className="sr">: {v ? VERDICT_TEXT[v] : "not started"}</span>
          </span>
        );
      })}
    </div>
  );
}

interface CardProps {
  task: Task; column: Column; milestone?: Milestone; live: LiveAgent[]; runs: AgentRun[]; reviews: Review[]; selected: boolean;
}

function Card({ task, column, milestone, live, runs, reviews, selected }: CardProps) {
  const line = agentLine(task, live, runs);
  const running = live.length > 0;
  const cls = ["card", running && "is-running", selected && "is-selected", column === "done" && "is-done"].filter(Boolean).join(" ");
  return (
    <article className={cls} data-task={task.taskId}>
      <h3>
        <button className="card-open" type="button" aria-current={selected || undefined} onClick={() => dispatch({ type: "select-task", data: task.id })}>
          {stripId(task.title, task.taskId)}
        </button>
      </h3>
      <div className="card-meta">
        {task.taskId && <span className="card-id">{task.taskId}</span>}
        {(milestone || task.milestoneId) && (
          <span className="ms-chip" title={milestone?.title}>
            <b>{task.milestoneId}</b>{milestone ? stripId(milestone.title, milestone.milestoneId) : ""}
          </span>
        )}
        {task.round > 0 && <span className="round" title={`Review round ${task.round}`}>R{task.round}</span>}
      </div>
      {column === "reviewers" && <Verdicts task={task} reviews={reviews} />}
      {column === "needs-human" && (task.escalation || task.status === "blocked") && (
        <span className="escalation">{task.escalation ?? "blocked"}</span>
      )}
      {column === "backlog" && task.dependsOn.length > 0 && (
        <p className="card-note">Depends on {task.dependsOn.map((id, i) => <Fragment key={id}>{i > 0 && ", "}<span className="tid">{id}</span></Fragment>)}</p>
      )}
      {line && (
        <div className="card-agent">
          {line.live && <span className="pulse" aria-hidden="true" />}
          <span className="agent">{line.label}{line.live && <span className="sr"> (running)</span>}</span>
          {line.start !== undefined && <Elapsed start={line.start} end={line.end} ticking={line.ticking} />}
        </div>
      )}
    </article>
  );
}

function tapeClass(column: Column, running: boolean): string | undefined {
  if (running) return "t-run";
  if (column === "done") return "t-done";
  if (column === "needs-human") return "t-human";
  if (column === "backlog") return "t-todo";
  return undefined;
}

export function Kanban({ snapshot }: { snapshot: WorkstreamSnapshot }) {
  const live = useStore((s) => s.live);
  const selected = useStore((s) => s.selectedTask);

  const view = useMemo(() => {
    const liveByTask = new Map<string, LiveAgent[]>();
    for (const a of Object.values(live)) {
      if (!a.taskNoteId || a.finishedAt) continue;
      liveByTask.set(a.taskNoteId, [...(liveByTask.get(a.taskNoteId) ?? []), a]);
    }
    const group = <T extends { taskId?: string }>(xs: T[]) => {
      const m = new Map<string, T[]>();
      for (const x of xs) if (x.taskId) m.set(x.taskId, [...(m.get(x.taskId) ?? []), x]);
      return m;
    };
    // #taskId repeats across workstreams (each starts at T-001): only this workstream's runs (and unlabelled ones)
    const runsByTask = group(snapshot.runs.filter((r) => runInWorkstream(r, snapshot.workstream?.slug)));
    const reviewsByTask = group(snapshot.reviews);
    const milestones = new Map(snapshot.milestones.map((m) => [m.milestoneId, m]));
    const sorted = sortTasks(snapshot.tasks, snapshot.milestones);
    const lanes = new Map<Column, Task[]>(COLUMN_ORDER.map((c) => [c, []]));
    for (const t of sorted) lanes.get(columnFor(t))!.push(t);
    const tape = [...snapshot.milestones].sort((a, b) => a.order - b.order).map((m) => {
      const ts = sorted.filter((t) => t.milestoneId === m.milestoneId);
      return { m, ts, done: ts.filter((t) => t.status === "done").length };
    });
    return { liveByTask, runsByTask, reviewsByTask, milestones, lanes, tape };
  }, [snapshot, live]);

  return (
    <div className="board-scroll">
      {view.tape.length > 0 && (
        <ol className="milestones" aria-label="Milestones">
          {view.tape.map(({ m, ts, done }) => (
            <li key={m.id}>
              <span className="ms-code">{m.milestoneId}</span>{stripId(m.title, m.milestoneId)}
              <span className="tape" aria-hidden="true">
                {ts.map((t) => {
                  const col = columnFor(t), running = view.liveByTask.has(t.id);
                  return <i key={t.id} className={tapeClass(col, running)} title={`${t.taskId} ${COLUMN_TITLES[col]}${running ? ", running" : ""}`} />;
                })}
              </span>
              <span className="ms-count">{done} of {ts.length} done</span>
            </li>
          ))}
        </ol>
      )}
      <div className="lanes">
        {COLUMN_ORDER.map((col) => {
          const tasks = view.lanes.get(col)!;
          const isLive = tasks.some((t) => view.liveByTask.has(t.id));
          const cls = ["lane", isLive && "is-live", col === "needs-human" && "is-human"].filter(Boolean).join(" ");
          return (
            <section key={col} className={cls} aria-labelledby={`lane-${col}`}>
              <header className="lane-head">
                <h2 id={`lane-${col}`}>{COLUMN_TITLES[col]}</h2>
                <span className="lane-count">{tasks.length}</span>
              </header>
              {tasks.map((t) => (
                <Card
                  key={t.id}
                  task={t}
                  column={col}
                  milestone={view.milestones.get(t.milestoneId)}
                  live={view.liveByTask.get(t.id) ?? []}
                  runs={view.runsByTask.get(t.taskId) ?? []}
                  reviews={view.reviewsByTask.get(t.taskId) ?? []}
                  selected={selected === t.id}
                />
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
