import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../../src/agents/registry";
import { cwdSlug } from "../../src/agents/transcript-path";
import { createApp } from "../../src/app";
import type { DashboardConfig } from "../../src/config";
import { EventHub } from "../../src/hub";
import { RepoRegistry } from "../../src/repos";
import { columnFor } from "../../src/shared/columns";
import type { WorkstreamSnapshot } from "../../src/shared/types";
import { TriliumClient } from "../../src/trilium/client";
import { loadFixtureNotes, startFakeEtapi } from "./fake-etapi";

const cleanups: (() => void)[] = [];
let repoDir: string;

function boot(fake: { url: string }, token: string, homeDir = "") {
  const config: DashboardConfig = { triliumUrl: fake.url, etapiToken: token, port: 0, pollMs: 60000, configDir: "", homeDir };
  const app = createApp({ config, client: new TriliumClient({ baseUrl: fake.url, token }), repos: new RepoRegistry(), hub: new EventHub(), registry: new AgentRegistry(), homeDir });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  cleanups.push(() => { app.stop(); server.stop(true); });
  return { app, base: `http://127.0.0.1:${server.port}` };
}

let fake: ReturnType<typeof startFakeEtapi>;
beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), "factory-repo-"));
  mkdirSync(join(repoDir, ".factory"));
  writeFileSync(join(repoDir, ".factory/config.json"), JSON.stringify({ projectNoteId: "proj1", activeWorkstream: "demo", workstreams: { demo: { noteId: "ws1" } } }));
  fake = startFakeEtapi({ ...loadFixtureNotes(), token: "good" });
});
afterAll(() => { cleanups.forEach((c) => c()); fake.stop(); rmSync(repoDir, { recursive: true, force: true }); });

describe("dashboard server", () => {
  test("health, repos, state, docs, tasks", async () => {
    const { app, base } = boot(fake, "good");
    expect(app.addRepo(repoDir)).not.toBeNull();
    const cold: any = await (await fetch(`${base}/api/health`)).json();
    expect(cold.trilium).toMatchObject({ ok: false, error: "no poller has refreshed yet" });
    await Promise.all([...app.pollers.values()].map((p) => p.refresh()));
    const health: any = await (await fetch(`${base}/api/health`)).json();
    expect(health.ok).toBe(true);
    expect(health.trilium.ok).toBe(true);
    expect(health.repos).toContain(repoDir);
    expect(JSON.stringify(health)).not.toContain("good");

    const repos: any = await (await fetch(`${base}/api/repos`)).json();
    expect(repos.repos[0].workstreams).toEqual([{ slug: "demo", noteId: "ws1" }]);

    const st = await fetch(`${base}/api/state?repo=${encodeURIComponent(repoDir)}`);
    expect(st.status).toBe(200);
    const snap = (await st.json()) as WorkstreamSnapshot;
    expect(snap.tasks).toHaveLength(5);
    expect(columnFor(snap.tasks.find((t) => t.id === "t002")!)).toBe("reviewers");
    expect((await fetch(`${base}/api/state?repo=nope`)).status).toBe(404);
    expect((await fetch(`${base}/api/state?repo=${app.pollers.size ? repoDir.split("/").pop() : ""}`)).status).toBe(200);

    expect((await fetch(`${base}/api/state?repo=${encodeURIComponent(repoDir)}&ws=nope`)).status).toBe(404);
    expect(((await (await fetch(`${base}/api/state?repo=${encodeURIComponent(repoDir)}&ws=nope`)).json()) as any).error).toBe("unknown workstream");

    const d1 = await fetch(`${base}/api/docs/d2`);
    expect(d1.status).toBe(200);
    const etag = d1.headers.get("etag")!;
    expect(etag).toMatch(/^".+"$/);
    expect(((await d1.json()) as any).content).toContain("Spec");
    const d2 = await fetch(`${base}/api/docs/d2`, { headers: { "If-None-Match": etag } });
    expect(d2.status).toBe(304);

    const t: any = await (await fetch(`${base}/api/tasks/t002`)).json();
    expect(t.reviews).toHaveLength(2);
    expect(t.spec.content).toContain("task spec");
    expect(t.approval.content).toContain("Approved");
    expect(t.runs).toHaveLength(1);
    expect((await fetch(`${base}/api/tasks/zzz`)).status).toBe(404);
  });

  test("POST /api/repos", async () => {
    const { base } = boot(fake, "good");
    const post = (body: string) => fetch(`${base}/api/repos`, { method: "POST", body });
    expect((await post(JSON.stringify({ path: repoDir }))).status).toBe(201);
    expect((await post("{")).status).toBe(400);
    expect((await post(JSON.stringify({ path: "/nonexistent-xyz" }))).status).toBe(404);
  });

  test("wrong token reports trilium error but server stays up", async () => {
    const { app, base } = boot(fake, "bad");
    app.addRepo(repoDir);
    await Promise.all([...app.pollers.values()].map((p) => p.refresh()));
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const h: any = await res.json();
    expect(h.trilium.ok).toBe(false);
    expect(h.trilium.error).toBe("trilium returned 401");
    expect(JSON.stringify(h)).not.toContain("bad");
  });

  test("events: subagent start/stop, unknown project, bad body", async () => {
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    const other = mkdtempSync(join(tmpdir(), "factory-norepo-"));
    cleanups.push(() => { rmSync(home, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); });
    const dir = join(home, ".claude/projects", cwdSlug(repoDir), "s1/subagents");
    mkdirSync(dir, { recursive: true });
    const fx = join(import.meta.dir, "../fixtures/transcripts/agent-sample");
    copyFileSync(`${fx}.jsonl`, join(dir, "agent-a1.jsonl"));
    copyFileSync(`${fx}.meta.json`, join(dir, "agent-a1.meta.json"));

    const { base } = boot(fake, "good", home);
    const post = (b: unknown) => fetch(`${base}/api/events`, { method: "POST", body: JSON.stringify(b) });
    const q = encodeURIComponent(repoDir);
    const reposBefore = await (await fetch(`${base}/api/repos`)).json();

    expect((await post({})).status).toBe(400);
    expect((await post({ event: "stage", project: other })).status).toBe(204);
    expect(await (await fetch(`${base}/api/repos`)).json()).toEqual(reposBefore as any);

    const start = await post({ event: "subagent-start", ts: "x", project: repoDir, payload: { agent_id: "a1", agent_type: "factory:builder", session_id: "s1", cwd: repoDir } });
    expect(start.status).toBe(204);
    let ag: any = await (await fetch(`${base}/api/agents?repo=${q}`)).json();
    expect(ag.live).toHaveLength(1);
    expect(ag.live[0].taskNoteId).toBe("t001");
    await Bun.sleep(100);
    const steps: any = await (await fetch(`${base}/api/agents/a1/steps?after=-1`)).json();
    expect(steps.steps.length).toBeGreaterThan(0);
    expect(steps.finished).toBe(false);
    expect((await fetch(`${base}/api/agents/zz/steps`)).status).toBe(404);

    await post({ event: "task", project: repoDir, task: "T-001", payload: {} });
    await post({ event: "subagent-stop", project: repoDir, payload: { agent_id: "a1" } });
    ag = await (await fetch(`${base}/api/agents?repo=${q}`)).json();
    expect(ag.live).toHaveLength(0);
    expect(ag.recent).toHaveLength(1);
    expect(ag.lastTaskEvent.task).toBe("T-001");
    const after: any = await (await fetch(`${base}/api/agents/a1/steps`)).json();
    expect(after.finished).toBe(true);
  });
});
