import { useEffect, useMemo, useState } from "react";
import type { HookEvent, LiveAgent, Step, Task, WorkstreamSnapshot } from "../../src/shared/types";
import { formatElapsed, useNow } from "../lib/clock";
import { dispatch, store, useStore } from "../lib/store";
import { agentName, stripId } from "./Kanban";
import { Steps, useAgentSteps } from "./Steps";

interface AgentsBody { live: LiveAgent[]; recent: LiveAgent[]; lastTaskEvent?: HookEvent }

const time = (iso?: string) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? undefined : t;
};

/** Opens a task's drawer on the board (selecting it only if it is not already selected: the action toggles). */
function openTask(id: string) {
  if (store.getState().selectedTask !== id) dispatch({ type: "select-task", data: id });
  dispatch({ type: "tab", data: "board" });
}

function Ticking({ start }: { start: number }) {
  const now = useNow();
  return <time>{formatElapsed(now - start)}</time>;
}

function stepTotal(a: LiveAgent, live: Step[] | undefined): number {
  const last = live?.[live.length - 1];
  return Math.max(a.stepCount, last ? last.seq + 1 : 0);
}

function AgentCard({ agent, running, selected, task, steps, onSelect }: {
  agent: LiveAgent; running: boolean; selected: boolean; task?: Task; steps?: Step[]; onSelect(): void;
}) {
  const start = time(agent.startedAt), end = time(agent.finishedAt);
  const n = stepTotal(agent, steps);
  const cls = ["card", "agent-card", running && "is-running", selected && "is-selected"].filter(Boolean).join(" ");
  return (
    <li className={cls}>
      <h3>
        <button className="card-open" type="button" aria-pressed={selected} onClick={onSelect}>
          {agentName(agent.agentType)}{agent.model && <span className="agent-model"> · {agent.model}</span>}
        </button>
      </h3>
      <div className="card-meta">
        {task ? (
          <button className="task-link" type="button" title={`Open ${task.taskId} on the board`} onClick={() => openTask(task.id)}>
            <span className="card-id">{task.taskId}</span> {stripId(task.title, task.taskId)}
          </button>
        ) : <span className="agent-none">{agent.taskNoteId ? "Task in another workstream" : "No task"}</span>}
      </div>
      <div className="card-agent">
        {running && <span className="pulse" aria-hidden="true" />}
        <span>{n} {n === 1 ? "step" : "steps"}{running && <span className="sr"> (running)</span>}</span>
        {start !== undefined && (running ? <Ticking start={start} /> : end !== undefined ? <time>{formatElapsed(end - start)}</time> : null)}
      </div>
    </li>
  );
}

function StepsPanel({ agent, running }: { agent: LiveAgent; running: boolean }) {
  const { steps, status } = useAgentSteps(agent.agentId);
  const description = agent.description?.replace(/\s*\[task:[^\]]+\]\s*/g, " ").trim();
  const empty = status === "loading" ? "Loading steps…"
    : status === "gone" ? "The dashboard no longer has this agent's steps. It keeps them for 30 minutes after an agent stops."
    : status === "error" ? "The steps could not be loaded. Check that the dashboard server is still running."
    : running ? "No steps yet. They appear as the agent works." : "This agent recorded no steps.";
  return (
    <section className="agent-steps" aria-labelledby="agent-steps-title">
      <header className="agent-steps-head">
        <h2 id="agent-steps-title">{agentName(agent.agentType)}{agent.model && <span className="agent-model"> · {agent.model}</span>}</h2>
        {running && <span className="live-tag"><span className="pulse" aria-hidden="true" />Live</span>}
        {description && <p className="agent-desc">{description}</p>}
      </header>
      <div className="agent-steps-scroll">
        <Steps key={agent.agentId} steps={steps} start={agent.startedAt} live={running} empty={empty} />
      </div>
    </section>
  );
}

/**
 * Agents for the selected repo: live ones (from the stream, merged with `GET /api/agents`) and recently finished ones,
 * each with type, model, task, elapsed time and step count. Selecting one shows its steps.
 */
export function Agents({ repo, snapshot }: { repo?: string; snapshot: WorkstreamSnapshot | null }) {
  const live = useStore((s) => s.live);
  const steps = useStore((s) => s.steps);
  const connected = useStore((s) => s.connected);
  const [fetched, setFetched] = useState<{ repo: string; body: AgentsBody }>();
  const [failed, setFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();

  // re-read whenever an agent starts or stops, so a stopped one moves to Recent
  const liveKey = Object.keys(live).sort().join(",");
  useEffect(() => {
    if (!repo) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/agents?repo=${encodeURIComponent(repo)}`, { cache: "no-store", signal: ctrl.signal });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body = (await res.json()) as AgentsBody;
        if (!ctrl.signal.aborted) { setFetched({ repo, body }); setFailed(false); }
      } catch {
        if (!ctrl.signal.aborted) setFailed(true);
      }
    })();
    return () => ctrl.abort();
  }, [repo, liveKey]);

  const lists = useMemo(() => {
    const body = fetched && fetched.repo === repo ? fetched.body : undefined;
    const known = new Map((body?.live ?? []).map((a) => [a.agentId, a]));
    // while connected the stream is the truth about who is running; the fetch only adds detail (step count, task)
    const running: LiveAgent[] = connected ? [] : [...known.values()].filter((a) => !(a.agentId in live));
    for (const a of Object.values(live)) {
      const k = known.get(a.agentId);
      running.push(k ? { ...k, ...a, taskNoteId: a.taskNoteId ?? k.taskNoteId, model: a.model ?? k.model, stepCount: Math.max(a.stepCount, k.stepCount) } : a);
    }
    running.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const recent = (body?.recent ?? []).filter((a) => !(a.agentId in live));
    return { running, recent, last: body?.lastTaskEvent };
  }, [fetched, repo, live, connected]);

  const tasks = useMemo(() => new Map((snapshot?.tasks ?? []).map((t) => [t.id, t])), [snapshot]);
  const all = [...lists.running, ...lists.recent];
  const current = all.find((a) => a.agentId === selectedId) ?? (selectedId ? undefined : all[0]);
  const isRunning = (a: LiveAgent) => lists.running.includes(a);

  if (!repo) return <div className="agents-empty"><p className="doc-note">Pick a repo to see its agents.</p></div>;

  const list = (agents: LiveAgent[], running: boolean, none: string) => (
    agents.length === 0 ? <p className="agents-none">{none}</p> : (
      <ol className="agent-list">
        {agents.map((a) => (
          <AgentCard key={a.agentId} agent={a} running={running} selected={a === current} task={a.taskNoteId ? tasks.get(a.taskNoteId) : undefined} steps={steps[a.agentId]} onSelect={() => setSelectedId(a.agentId)} />
        ))}
      </ol>
    )
  );

  return (
    <div className="agents">
      <div className="agents-lists">
        {failed && !fetched && <p className="doc-note doc-error" role="alert">The dashboard server did not answer. Showing only agents seen on the live stream.</p>}
        <section aria-labelledby="agents-live">
          <h2 className="agents-head" id="agents-live">Live <span className="lane-count">{lists.running.length}</span></h2>
          {list(lists.running, true, "No agent is running in this repo right now.")}
        </section>
        <section aria-labelledby="agents-recent">
          <h2 className="agents-head" id="agents-recent">Recent <span className="lane-count">{lists.recent.length}</span></h2>
          {list(lists.recent, false, "No finished agents. Finished agents stay listed for 30 minutes.")}
        </section>
        {lists.last && (
          <p className="agents-last">
            Last task event: <b>{lists.last.task}</b>{lists.last.status && ` ${lists.last.status}`}
            {lists.last.ts && time(lists.last.ts) !== undefined && <> at <time dateTime={lists.last.ts}>{new Date(time(lists.last.ts)!).toLocaleTimeString()}</time></>}
          </p>
        )}
      </div>
      {current ? <StepsPanel agent={current} running={isRunning(current)} />
        : <section className="agent-steps agent-steps-none"><p>{selectedId ? "This agent is no longer listed." : "Select an agent to see its steps."}</p></section>}
    </div>
  );
}
