import { useSyncExternalStore } from "react";
import type { LiveAgent, Step, StreamEvent, WorkstreamSnapshot } from "../../src/shared/types";

export interface State {
  repo?: string;
  ws?: string;
  snapshot: WorkstreamSnapshot | null;
  live: Record<string, LiveAgent>;
  steps: Record<string, Step[]>;
  connected: boolean;
  selectedTask?: string;
  tab: string;
}

export type Action =
  | StreamEvent
  | { type: "connected"; data: boolean }
  | { type: "select-task"; data?: string }
  | { type: "tab"; data: string }
  | { type: "select-repo"; data: { repo: string; ws?: string } }
  | { type: "select-ws"; data: string };

/** Steps kept per agent in the browser; older ones are dropped (the server keeps the full history). */
export const STEP_CAP = 500;
/** Agents whose step lists are kept; beyond this the least recently active stopped agent's list is dropped. */
export const STEP_AGENTS_CAP = 20;
/** Shared empty list for `useStore((s) => s.steps[id]) ?? EMPTY_STEPS`: a selector must not build a new array. */
export const EMPTY_STEPS: Step[] = [];

/** Keys are kept in activity order (an agent's key moves to the end on each step), so the first stopped ones go first. */
function pruneSteps(steps: Record<string, Step[]>, live: Record<string, LiveAgent>): Record<string, Step[]> {
  const ids = Object.keys(steps);
  let excess = ids.length - STEP_AGENTS_CAP;
  if (excess <= 0) return steps;
  const out = { ...steps };
  for (const id of ids) {
    if (excess <= 0) break;
    if (id in live) continue; // a running agent's steps stay while it runs
    delete out[id];
    excess--;
  }
  return out;
}

export const initialState: State = { snapshot: null, live: {}, steps: {}, connected: false, tab: "board" };

/** Pure reducer: no DOM, no I/O. Returns the same object when nothing changes. */
export function reduce(state: State, e: Action): State {
  switch (e.type) {
    case "snapshot":
      return { ...state, snapshot: e.data };
    case "agent": {
      const { op, agent } = e.data;
      if (op === "stop") {
        if (!(agent.agentId in state.live)) return state;
        const { [agent.agentId]: _gone, ...rest } = state.live;
        return { ...state, live: rest, steps: pruneSteps(state.steps, rest) };
      }
      return { ...state, live: { ...state.live, [agent.agentId]: agent } };
    }
    case "step": {
      const { agentId, step } = e.data;
      const prev = state.steps[agentId] ?? [];
      const next = prev.length >= STEP_CAP ? [...prev.slice(prev.length - STEP_CAP + 1), step] : [...prev, step];
      const { [agentId]: _prev, ...others } = state.steps;
      return { ...state, steps: pruneSteps({ ...others, [agentId]: next }, state.live) };
    }
    case "heartbeat":
      return state;
    case "connected":
      if (state.connected === e.data) return state;
      // On (re)connect the server re-sends every live agent as `agent start`; drop ours so stopped ones don't linger.
      return e.data ? { ...state, connected: true, live: {} } : { ...state, connected: false };
    case "select-task":
      return { ...state, selectedTask: e.data === undefined || e.data === state.selectedTask ? undefined : e.data };
    case "tab":
      return state.tab === e.data ? state : { ...state, tab: e.data };
    case "select-repo":
      return { ...initialState, repo: e.data.repo, ws: e.data.ws, tab: state.tab };
    case "select-ws":
      return { ...state, ws: e.data, selectedTask: undefined };
    default:
      return state;
  }
}

export interface Store<S, A> {
  getState(): S;
  dispatch(a: A): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<S, A>(reducer: (s: S, a: A) => S, initial: S): Store<S, A> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(a) {
      const next = reducer(state, a);
      if (next === state) return;
      state = next;
      for (const l of [...listeners]) l();
    },
    subscribe(l) {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
  };
}

export const store = createStore(reduce, initialState);
export const dispatch = store.dispatch;

/** Selectors must return a stable reference (a slice of state), not a freshly built object. */
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}
