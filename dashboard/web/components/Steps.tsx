import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Step } from "../../src/shared/types";
import { formatElapsed } from "../lib/clock";
import { mergeSteps, toRows } from "../lib/steps";
import { EMPTY_STEPS, useStore } from "../lib/store";

/** Within this many pixels of the end counts as "at the bottom", so new steps keep the list scrolled down. */
const BOTTOM_SLACK = 24;

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
  }
  return null;
}

const clock = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : new Date(t).toLocaleTimeString();
};

/**
 * An agent's steps: text as paragraphs, tools as `▸ name — summary` with a ✓/✗ once their result arrives,
 * runs of thinking as one "thinking… ×N" line. Times are elapsed since `start` (or the first step).
 * The nearest scrolling ancestor follows new steps while the reader is at its bottom; scrolling up stops that.
 */
export function Steps({ steps, start, live = false, empty = "No steps yet." }: { steps: Step[]; start?: string; live?: boolean; empty?: string }) {
  const rows = useMemo(() => toRows(steps), [steps]);
  const first = steps[0]?.ts;
  const base = useMemo(() => {
    const ts = [start, first].map((s) => (s ? Date.parse(s) : NaN)).filter(Number.isFinite);
    return ts.length ? Math.min(...ts) : undefined;
  }, [start, first]);

  const listRef = useRef<HTMLOListElement>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const atBottom = useRef(true);

  useLayoutEffect(() => {
    const el = scrollParent(listRef.current);
    scroller.current = el;
    if (!el) return;
    const onScroll = () => { atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK; };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [rows]);

  let lastTool = -1;
  if (live) for (let i = rows.length - 1; i >= 0; i--) if (rows[i].kind === "tool") { lastTool = i; break; }

  return (
    <ol className="steps" ref={listRef}>
      {rows.length === 0 && <li className="steps-empty">{empty}</li>}
      {rows.map((r, i) => {
        const t = Date.parse(r.ts);
        const when = base !== undefined && !Number.isNaN(t) ? <time dateTime={r.ts} title={clock(r.ts)}>{formatElapsed(t - base)}</time> : <span />;
        if (r.kind === "text") return <li key={r.key}>{when}<p className="step-text">{r.text}</p><span /></li>;
        if (r.kind === "thinking") return <li key={r.key} className="step-thinking">{when}<span className="step-think">thinking…{r.count > 1 && ` ×${r.count}`}</span><span /></li>;
        const running = i === lastTool && !r.result;
        return (
          <li key={r.key} className={running ? "is-live" : undefined}>
            {when}
            <span className="step-tool">&#9656; <b>{r.name}</b>{r.summary && <> &mdash; {r.summary}</>}</span>
            {r.result === "ok" ? <span className="res res-ok"><span aria-hidden="true">&#10003;</span><span className="sr">succeeded</span></span>
              : r.result === "err" ? <span className="res res-err"><span aria-hidden="true">&#10007;</span><span className="sr">failed</span></span>
              : running ? <span className="res res-run"><span className="pulse" aria-hidden="true" />running</span>
              : <span />}
          </li>
        );
      })}
    </ol>
  );
}

export interface AgentSteps { steps: Step[]; status: "idle" | "loading" | "ready" | "gone" | "error" }

/**
 * Full step history for one agent: `GET /api/agents/:id/steps?after=-1` once, then the live steps from the store.
 * Live steps are folded into local state as they arrive, so they survive the store dropping old agents' lists.
 */
export function useAgentSteps(agentId: string | undefined): AgentSteps {
  const live = useStore((s) => (agentId ? s.steps[agentId] : undefined)) ?? EMPTY_STEPS;
  const [held, setHeld] = useState<{ id?: string; steps: Step[]; status: AgentSteps["status"] }>({ steps: EMPTY_STEPS, status: "idle" });

  useEffect(() => {
    if (!agentId) return;
    const ctrl = new AbortController();
    setHeld({ id: agentId, steps: EMPTY_STEPS, status: "loading" });
    (async () => {
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/steps?after=-1`, { cache: "no-store", signal: ctrl.signal });
        if (res.status === 404) {
          if (!ctrl.signal.aborted) setHeld((p) => (p.id === agentId ? { ...p, status: "gone" } : p));
          return;
        }
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body = (await res.json()) as { steps: Step[] };
        if (!ctrl.signal.aborted) setHeld((p) => (p.id === agentId ? { id: agentId, steps: mergeSteps(body.steps, p.steps), status: "ready" } : p));
      } catch {
        if (!ctrl.signal.aborted) setHeld((p) => (p.id === agentId ? { ...p, status: "error" } : p));
      }
    })();
    return () => ctrl.abort();
  }, [agentId]);

  useEffect(() => {
    if (live === EMPTY_STEPS) return;
    setHeld((p) => {
      if (p.id !== agentId) return p;
      const steps = mergeSteps(p.steps, live);
      return steps === p.steps ? p : { ...p, steps };
    });
  }, [live, agentId]);

  const mine = held.id === agentId ? held : undefined;
  const steps = useMemo(() => mergeSteps(mine?.steps ?? EMPTY_STEPS, live), [mine?.steps, live]);
  return { steps, status: agentId ? (mine?.status ?? "loading") : "idle" };
}
