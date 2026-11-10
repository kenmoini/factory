import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EventHub } from "../src/hub";
import { RepoRegistry } from "../src/repos";
import type { StreamEvent } from "../src/shared/types";
import { TOKEN_NOT_CONFIGURED, TriliumConfigError, TriliumError, type EtapiNote, type TriliumClient } from "../src/trilium/client";
import { Poller } from "../src/trilium/poller";

const load = (f: string): EtapiNote[] => JSON.parse(readFileSync(join(import.meta.dir, "fixtures/etapi", `${f}.json`), "utf8")).results;

function setup(projectNoteId?: string) {
  const state = { bump: 0, vbump: 0, fail: false, unconfigured: false, calls: [] as { q: string; opts: any }[], getNotes: 0 };
  const byLabel: Record<string, () => EtapiNote[]> = {
    "#factoryProject": () => load("project"),
    "#factoryWorkstream": () => load("workstreams"),
    "#factoryMilestone": () => load("milestones"),
    "#factoryTask": () => load("tasks").map((t) => (t.noteId === "t001" && state.bump ? { ...t, utcDateModified: `2026-12-0${state.bump}T00:00:00.000Z` } : t)),
    "#factoryDoc": () => load("docs"),
    "#factoryReview": () => load("reviews"),
    "#factoryAgentRun": () => load("runs"),
    "#factoryValidation": () => load("validations").map((n) => (state.vbump ? { ...n, utcDateModified: "2026-12-01T00:00:00.000Z" } : n)),
  };
  const client = {
    search: async (q: string, opts: any = {}) => {
      state.calls.push({ q, opts });
      if (state.fail) throw new TriliumError("boom");
      return byLabel[q.split(/\s/)[0]]();
    },
    getNote: async (id: string) => { state.getNotes++; if (state.fail) throw new TriliumError("boom"); return load("project").find((n) => n.noteId === id)!; },
    getContent: async () => ({ content: "", mime: "text/html" }),
    appInfo: async () => ({}),
  } as unknown as TriliumClient;
  const hub = new EventHub();
  const events: StreamEvent[] = [];
  hub.subscribe("/r/app", (e) => events.push(e));
  const reg = new RepoRegistry({ readConfig: (p) => ({ repoPath: p, repoSlug: "app", projectNoteId, workstreams: {} }) });
  const repo = reg.register("/r/app")!;
  // the repo's client, as createApp's clientFor hands it out: it throws while the repo's token is a placeholder
  const clientFor = () => { if (state.unconfigured) throw new TriliumConfigError(TOKEN_NOT_CONFIGURED); return client; };
  const poller = new Poller(repo, { client: clientFor, hub, live: () => [] }, { intervalMs: 20 });
  return { state, events, poller };
}

describe("Poller", () => {
  test("publishes only on change; errors keep snapshot", async () => {
    const { state, events, poller } = setup("proj1");
    expect(await poller.refresh()).toBe(true);
    expect(events.length).toBe(1);
    expect(poller.snapshot()!.tasks.length).toBe(5);
    expect(poller.snapshot()!.project.id).toBe("proj1");
    expect(await poller.refresh()).toBe(false);
    expect(events.length).toBe(1);
    state.bump = 1;
    expect(await poller.refresh()).toBe(true);
    expect(events.length).toBe(2);
    const before = poller.snapshot();
    state.fail = true;
    expect(await poller.refresh()).toBe(false);
    expect(poller.snapshot()).toBe(before);
    expect(poller.lastError()).toContain("boom");
    state.fail = false;
    await poller.refresh();
    expect(poller.lastError()).toBeNull();
  });

  test("placeholder token: lastError 'trilium token not configured', no request; a later real token polls again", async () => {
    const { state, events, poller } = setup("proj1");
    state.unconfigured = true;
    expect(await poller.refresh()).toBe(false);
    expect(poller.lastError()).toBe("trilium token not configured");
    expect(state.calls).toHaveLength(0);
    expect(state.getNotes).toBe(0);
    expect(poller.snapshot()).toBeNull();
    state.unconfigured = false;
    expect(await poller.refresh()).toBe(true);
    expect(poller.lastError()).toBeNull();
    expect(events).toHaveLength(1);
  });

  test("agent runs searched under the project; project docs at depth eq1", async () => {
    const { state, poller } = setup("proj1");
    await poller.refresh();
    const run = state.calls.find((c) => c.q === "#factoryAgentRun")!;
    expect(run.opts.ancestorNoteId).toBe("proj1");
    expect(run.opts.limit).toBe(200);
    expect(state.calls.some((c) => c.q === "#factoryDoc" && c.opts.ancestorNoteId === "proj1" && c.opts.ancestorDepth === "eq1")).toBe(true);
    const ids = poller.snapshot()!.docs.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("validation rounds are searched under the workstream and listed as validation docs", async () => {
    const { state, poller } = setup("proj1");
    await poller.refresh();
    const call = state.calls.find((c) => c.q === "#factoryValidation");
    expect(call?.opts.ancestorNoteId).toBe("ws1");
    const v = poller.snapshot()!.docs.filter((d) => d.kind === "validation");
    expect(v).toEqual([{ id: "v1", kind: "validation", title: "Round 1", format: "html", parentId: "ws1", modified: "2026-11-10 10:00:00.000Z", round: 1 }]);
  });

  test("a changed validation round is part of the fingerprint", async () => {
    const { state, events, poller } = setup("proj1");
    expect(await poller.refresh()).toBe(true);
    expect(await poller.refresh()).toBe(false);
    state.vbump = 1;
    expect(await poller.refresh()).toBe(true);
    expect(events.length).toBe(2);
    expect(poller.snapshot()!.docs.find((d) => d.id === "v1")!.modified).toBe("2026-12-01T00:00:00.000Z");
  });

  test("finds project by repoPath when id unknown", async () => {
    const { state, poller } = setup(undefined);
    await poller.refresh();
    expect(state.calls[0].q).toBe("#factoryProject #repoPath='/r/app'");
    expect(state.getNotes).toBe(0);
    await poller.refresh();
    expect(state.getNotes).toBe(1);
  });

  test("the snapshot lists every workstream of the project", async () => {
    const { poller } = setup("proj1");
    await poller.refresh();
    expect(poller.snapshot()!.workstreams.map((w) => w.slug)).toEqual(["demo"]);
  });

  test("selectWorkstream marks a user choice only when asked, and waits out an in-flight refresh", async () => {
    const { state, poller } = setup("proj1");
    const first = poller.refresh();
    const sel = poller.selectWorkstream("demo");
    expect(poller.userSelected).toBe(false);
    await first;
    const before = state.calls.length;
    await sel;
    expect(state.calls.length).toBeGreaterThan(before); // a fresh refresh ran for the new slug
    expect(poller.activeWorkstream()).toBe("demo");
    await poller.selectWorkstream("demo", { user: true });
    expect(poller.userSelected).toBe(true);
  });

  test("start/stop poll on a timer", async () => {
    const { events, poller } = setup("proj1");
    poller.start();
    await new Promise((r) => setTimeout(r, 60));
    poller.stop();
    expect(events.length).toBe(1);
  });
});
