import { describe, expect, test } from "bun:test";
import { createStore, EMPTY_STEPS, initialState, reduce, STEP_AGENTS_CAP, STEP_CAP, type Action, type State } from "../web/lib/store";
import type { LiveAgent, RepoSnapshot, Step, WorkstreamSnapshot } from "../src/shared/types";

const snap = (fp: string): WorkstreamSnapshot => ({
  project: { id: "proj1", title: "demo-repo", repo: "demo-repo", repoPath: "/work/demo-repo", labels: {}, modified: "" },
  workstream: null, workstreams: [], milestones: [], tasks: [], docs: [], reviews: [], runs: [], live: [], fingerprint: fp,
});
const agent = (id: string, extra: Partial<LiveAgent> = {}): LiveAgent =>
  ({ agentId: id, agentType: "builder", cwd: "/w", startedAt: "2026-11-10T10:00:00Z", stepCount: 0, ...extra });
const step = (seq: number): Step => ({ seq, ts: "2026-11-10T10:00:00Z", kind: "text", text: `s${seq}` });
const run = (actions: Action[], from: State = initialState) => actions.reduce(reduce, from);

describe("reduce", () => {
  test("initial state is empty, disconnected, on the board tab", () => {
    expect(initialState).toEqual({ snapshot: null, live: {}, steps: {}, connected: false, tab: "board", repoSnapshot: null, repoView: { limit: 100 } });
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

  test("step lists are kept for at most 20 agents; the least recently active stopped agent's list goes first", () => {
    expect(STEP_AGENTS_CAP).toBe(20);
    expect(EMPTY_STEPS).toEqual([]);
    const id = (i: number) => `agent-${i}`;
    let s = initialState;
    for (let i = 0; i < 20; i++) s = reduce(s, { type: "step", data: { agentId: id(i), step: step(0) } });
    expect(Object.keys(s.steps)).toHaveLength(20);
    s = reduce(s, { type: "step", data: { agentId: id(0), step: step(1) } }); // agent-0 is active again
    s = reduce(s, { type: "step", data: { agentId: id(20), step: step(0) } });
    expect(Object.keys(s.steps)).toHaveLength(20);
    expect(s.steps[id(1)]).toBeUndefined();
    expect(s.steps[id(0)].map((x) => x.seq)).toEqual([0, 1]);
    expect(s.steps[id(20)]).toHaveLength(1);
  });

  test("a running agent's steps outlive the cap until it stops", () => {
    const id = (i: number) => `agent-${i}`;
    let s = reduce(initialState, { type: "agent", data: { op: "start", agent: agent(id(0)) } });
    for (let i = 0; i < 21; i++) s = reduce(s, { type: "step", data: { agentId: id(i), step: step(0) } });
    expect(s.steps[id(0)]).toHaveLength(1); // live, so agent-1 was dropped instead
    expect(s.steps[id(1)]).toBeUndefined();
    s = reduce(s, { type: "step", data: { agentId: id(21), step: step(0) } });
    expect(s.steps[id(0)]).toHaveLength(1);
    expect(Object.keys(s.steps)).toHaveLength(20);
    s = reduce(s, { type: "agent", data: { op: "stop", agent: agent(id(0)) } });
    expect(Object.keys(s.steps)).toHaveLength(20); // within the cap, so nothing is dropped on stop
    s = reduce(s, { type: "step", data: { agentId: id(22), step: step(0) } });
    expect(s.steps[id(0)]).toBeUndefined(); // stopped and the least recently active

    // over the cap because every agent was running: the stop itself drops the stopped agent's list
    let t = initialState;
    for (let i = 0; i < 21; i++) t = reduce(t, { type: "agent", data: { op: "start", agent: agent(id(i)) } });
    for (let i = 0; i < 21; i++) t = reduce(t, { type: "step", data: { agentId: id(i), step: step(0) } });
    expect(Object.keys(t.steps)).toHaveLength(21);
    t = reduce(t, { type: "agent", data: { op: "stop", agent: agent(id(5)) } });
    expect(Object.keys(t.steps)).toHaveLength(20);
    expect(t.steps[id(5)]).toBeUndefined();
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
    expect(s).toEqual({ repo: "other", ws: "main", snapshot: null, live: {}, steps: {}, connected: false, tab: "plan", repoSnapshot: null, repoView: { limit: 100 } });
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

describe("repo tab state", () => {
  const rsnap = (fingerprint: string): RepoSnapshot => ({ repoPath: "/w", defaultBranch: "main", branches: [], commits: [], limit: 100, truncated: false, fingerprint });
  const wsSnap = (slug: string, tasks: { id: string; taskId: string }[]) => ({ ...snap("x"), workstream: { id: slug, slug, title: slug, status: "executing", labels: {}, modified: "" },
    tasks: tasks.map((t) => ({ ...t, title: t.taskId, status: "todo" as const, milestoneId: "M1", order: 1, round: 0, dependsOn: [], modified: "" })) });
  test("initial state has no repo snapshot and the default view", () => { expect(initialState.repoSnapshot).toBeNull(); expect(initialState.repoView).toEqual({ limit: 100 }); });
  test("repo events replace the snapshot; select-commit toggles", () => {
    let s = run([{ type: "repo", data: rsnap("a") }, { type: "repo", data: rsnap("b") }]);
    expect(s.repoSnapshot?.fingerprint).toBe("b");
    s = reduce(s, { type: "select-commit", data: "abc" }); expect(s.selectedCommit).toBe("abc");
    s = reduce(s, { type: "select-commit", data: "abc" }); expect(s.selectedCommit).toBeUndefined();
    s = reduce(s, { type: "select-commit", data: "abc" }); s = reduce(s, { type: "select-commit" }); expect(s.selectedCommit).toBeUndefined();
  });
  test("repo-view returns the same state for an equal view", () => {
    const s = reduce(initialState, { type: "repo-view", data: { limit: 100 } });
    expect(s).toBe(initialState);
    expect(reduce(s, { type: "repo-view", data: { limit: 200, branch: "main" } }).repoView).toEqual({ limit: 200, branch: "main" });
  });
  test("open-task in the current workstream selects the task on the board", () => {
    const s = reduce({ ...initialState, snapshot: wsSnap("demo", [{ id: "t1", taskId: "T-001" }]), tab: "repo" }, { type: "open-task", data: { ws: "demo", taskId: "T-001" } });
    expect(s).toMatchObject({ tab: "board", selectedTask: "t1" }); expect(s.pendingTask).toBeUndefined();
  });
  test("open-task in another workstream switches and completes on that workstream's snapshot", () => {
    let s = reduce({ ...initialState, snapshot: wsSnap("demo", []), tab: "repo" }, { type: "open-task", data: { ws: "next", taskId: "T-001" } });
    expect(s).toMatchObject({ tab: "board", ws: "next", pendingTask: { ws: "next", taskId: "T-001" } }); expect(s.selectedTask).toBeUndefined();
    s = reduce(s, { type: "snapshot", data: wsSnap("demo", []) });            // a stale push for the old workstream: still pending
    expect(s.pendingTask).toBeDefined();
    s = reduce(s, { type: "snapshot", data: wsSnap("next", [{ id: "tn1", taskId: "T-001" }]) });
    expect(s.selectedTask).toBe("tn1"); expect(s.pendingTask).toBeUndefined();
  });
  test("a pending task missing from its workstream's snapshot is dropped, and select-ws / select-repo clear repo selections", () => {
    let s = reduce({ ...initialState, pendingTask: { ws: "next", taskId: "T-009" } }, { type: "snapshot", data: wsSnap("next", []) });
    expect(s.pendingTask).toBeUndefined(); expect(s.selectedTask).toBeUndefined();
    s = run([{ type: "repo", data: rsnap("a") }, { type: "select-commit", data: "abc" }, { type: "open-task", data: { ws: "n", taskId: "T-001" } }, { type: "select-ws", data: "other" }]);
    expect(s.pendingTask).toBeUndefined(); expect(s.selectedCommit).toBeUndefined();
    s = reduce(s, { type: "select-repo", data: { repo: "/x" } });
    expect(s.repoSnapshot).toBeNull(); expect(s.repoView).toEqual({ limit: 100 });
  });
});
