import { describe, expect, test } from "bun:test";
import { createStore, initialState, reduce, STEP_CAP, type Action, type State } from "../web/lib/store";
import type { LiveAgent, Step, WorkstreamSnapshot } from "../src/shared/types";

const snap = (fp: string): WorkstreamSnapshot => ({
  project: { id: "proj1", title: "demo-repo", repo: "demo-repo", repoPath: "/work/demo-repo", labels: {}, modified: "" },
  workstream: null, milestones: [], tasks: [], docs: [], reviews: [], runs: [], live: [], fingerprint: fp,
});
const agent = (id: string, extra: Partial<LiveAgent> = {}): LiveAgent =>
  ({ agentId: id, agentType: "builder", cwd: "/w", startedAt: "2026-11-10T10:00:00Z", stepCount: 0, ...extra });
const step = (seq: number): Step => ({ seq, ts: "2026-11-10T10:00:00Z", kind: "text", text: `s${seq}` });
const run = (actions: Action[], from: State = initialState) => actions.reduce(reduce, from);

describe("reduce", () => {
  test("initial state is empty, disconnected, on the board tab", () => {
    expect(initialState).toEqual({ snapshot: null, live: {}, steps: {}, connected: false, tab: "board" });
  });

  test("snapshot replaces the previous snapshot", () => {
    const s = run([{ type: "snapshot", data: snap("a") }, { type: "snapshot", data: snap("b") }]);
    expect(s.snapshot?.fingerprint).toBe("b");
  });

  test("agent start/update put the agent in live, stop removes it", () => {
    let s = run([{ type: "agent", data: { op: "start", agent: agent("a1") } }, { type: "agent", data: { op: "start", agent: agent("a2") } }]);
    expect(Object.keys(s.live).sort()).toEqual(["a1", "a2"]);
    s = reduce(s, { type: "agent", data: { op: "update", agent: agent("a1", { model: "opus", stepCount: 3 }) } });
    expect(s.live.a1.model).toBe("opus");
    expect(s.live.a1.stepCount).toBe(3);
    s = reduce(s, { type: "agent", data: { op: "stop", agent: agent("a1") } });
    expect(Object.keys(s.live)).toEqual(["a2"]);
  });

  test("agent events do not mutate the previous state", () => {
    const before = run([{ type: "agent", data: { op: "start", agent: agent("a1") } }]);
    const after = reduce(before, { type: "agent", data: { op: "stop", agent: agent("a1") } });
    expect(before.live.a1).toBeDefined();
    expect(after.live.a1).toBeUndefined();
  });

  test("step appends per agent", () => {
    const s = run([
      { type: "step", data: { agentId: "a1", step: step(0) } },
      { type: "step", data: { agentId: "a1", step: step(1) } },
      { type: "step", data: { agentId: "a2", step: step(0) } },
    ]);
    expect(s.steps.a1.map((x) => x.seq)).toEqual([0, 1]);
    expect(s.steps.a2.map((x) => x.seq)).toEqual([0]);
  });

  test("step list is capped at 500 per agent, dropping the oldest", () => {
    expect(STEP_CAP).toBe(500);
    let s = initialState;
    for (let i = 0; i < 503; i++) s = reduce(s, { type: "step", data: { agentId: "a1", step: step(i) } });
    expect(s.steps.a1).toHaveLength(500);
    expect(s.steps.a1[0].seq).toBe(3);
    expect(s.steps.a1[499].seq).toBe(502);
  });

  test("select-task selects, and selecting the same task again clears it", () => {
    let s = reduce(initialState, { type: "select-task", data: "t002" });
    expect(s.selectedTask).toBe("t002");
    s = reduce(s, { type: "select-task", data: "t004" });
    expect(s.selectedTask).toBe("t004");
    s = reduce(s, { type: "select-task", data: "t004" });
    expect(s.selectedTask).toBeUndefined();
    s = reduce(reduce(s, { type: "select-task", data: "t001" }), { type: "select-task" });
    expect(s.selectedTask).toBeUndefined();
  });

  test("connected and tab set their fields; heartbeat changes nothing", () => {
    let s = run([{ type: "connected", data: true }, { type: "tab", data: "spec" }]);
    expect(s.connected).toBe(true);
    expect(s.tab).toBe("spec");
    expect(reduce(s, { type: "heartbeat", data: { ts: "x" } })).toBe(s);
    s = reduce(s, { type: "connected", data: false });
    expect(s.connected).toBe(false);
  });

  test("a (re)connect clears live agents; the server re-sends them as agent start", () => {
    let s = run([{ type: "agent", data: { op: "start", agent: agent("gone") } }, { type: "connected", data: false }]);
    expect(s.live.gone).toBeDefined();
    s = run([{ type: "connected", data: true }, { type: "agent", data: { op: "start", agent: agent("a2") } }], s);
    expect(Object.keys(s.live)).toEqual(["a2"]);
  });

  test("select-repo resets the board; select-ws keeps the stream data but clears the selection", () => {
    let s = run([
      { type: "snapshot", data: snap("a") },
      { type: "agent", data: { op: "start", agent: agent("a1") } },
      { type: "step", data: { agentId: "a1", step: step(0) } },
      { type: "select-task", data: "t002" },
      { type: "tab", data: "plan" },
    ]);
    const ws = reduce(s, { type: "select-ws", data: "demo" });
    expect(ws.ws).toBe("demo");
    expect(ws.selectedTask).toBeUndefined();
    expect(ws.snapshot?.fingerprint).toBe("a");
    s = reduce(s, { type: "select-repo", data: { repo: "other", ws: "main" } });
    expect(s).toEqual({ repo: "other", ws: "main", snapshot: null, live: {}, steps: {}, connected: false, tab: "plan" });
  });
});

describe("createStore", () => {
  test("dispatch reduces, notifies subscribers, and unsubscribe stops notifications", () => {
    const st = createStore(reduce, initialState);
    let calls = 0;
    const off = st.subscribe(() => calls++);
    st.dispatch({ type: "tab", data: "goal" });
    expect(st.getState().tab).toBe("goal");
    expect(calls).toBe(1);
    st.dispatch({ type: "heartbeat", data: { ts: "x" } }); // unchanged state: no notification
    expect(calls).toBe(1);
    off();
    st.dispatch({ type: "tab", data: "plan" });
    expect(calls).toBe(1);
    expect(st.getState().tab).toBe("plan");
  });
});
