import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, pred: (acc: string) => boolean, timeoutMs: number): Promise<string> {
  const dec = new TextDecoder();
  let acc = "";
  const deadline = Date.now() + timeoutMs;
  while (!pred(acc)) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`readUntil timeout; got: ${JSON.stringify(acc)}`);
    const r = await Promise.race([reader.read(), Bun.sleep(left).then(() => "timeout" as const)]);
    if (r === "timeout") throw new Error(`readUntil timeout; got: ${JSON.stringify(acc)}`);
    if (r.done) throw new Error(`stream ended; got: ${JSON.stringify(acc)}`);
    acc += dec.decode(r.value);
  }
  return acc;
}

function boot(fake: { url: string }, token: string, homeDir = "", opts: { heartbeatMs?: number } = {}, registry = new AgentRegistry()) {
  const config: DashboardConfig = { triliumUrl: fake.url, etapiToken: token, port: 0, pollMs: 60000, configDir: "", homeDir };
  const hub = new EventHub();
  const app = createApp({ config, client: new TriliumClient({ baseUrl: fake.url, token }), repos: new RepoRegistry(), hub, registry, homeDir }, opts);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  cleanups.push(() => { app.stop(); server.stop(true); });
  return { app, hub, base: `http://127.0.0.1:${server.port}` };
}

let fake: ReturnType<typeof startFakeEtapi>;
beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), "factory-repo-"));
  mkdirSync(join(repoDir, ".factory"));
  writeFileSync(join(repoDir, ".factory/config.json"), JSON.stringify({ projectNoteId: "proj1", activeWorkstream: "demo", workstreams: { demo: { noteId: "ws1" } } }));
  const mock = join(repoDir, ".factory/mockups/demo");
  mkdirSync(mock, { recursive: true });
  writeFileSync(join(mock, "index.html"), "<h1>demo mockups</h1>");
  writeFileSync(join(mock, "style.css"), "body{color:red}");
  writeFileSync(join(mock, "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(join(mock, "blob.bin"), "xx");
  writeFileSync(join(repoDir, ".factory/secret.txt"), "secret");
  mkdirSync(join(repoDir, ".factory/mockups-evil"));
  writeFileSync(join(repoDir, ".factory/mockups-evil/x.html"), "evil");
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
    expect(snap.docs.find((d) => d.kind === "validation")).toMatchObject({ id: "v1", title: "Round 1", round: 1 });
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

    // a workstream the plugin has not cached a noteId for yet is still listed
    const other = mkdtempSync(join(tmpdir(), "factory-repo2-"));
    cleanups.push(() => rmSync(other, { recursive: true, force: true }));
    mkdirSync(join(other, ".factory"));
    writeFileSync(join(other, ".factory/config.json"), JSON.stringify({ workstreams: { demo: { noteId: "ws1" }, next: { branch: "next", worktree: ".factory/worktrees/next" } } }));
    const res = await post(JSON.stringify({ path: other }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).workstreams).toEqual([{ slug: "demo", noteId: "ws1" }, { slug: "next" }]);
  });

  test("mockups: files from .factory/mockups; traversal, unknown slug and missing files are 404", async () => {
    const { app, base } = boot(fake, "good");
    app.addRepo(repoDir);
    const slug = basename(repoDir);
    const m = (p: string, init?: RequestInit) => fetch(`${base}/mockups/${slug}/${p}`, init);

    const dir = await m("demo/");
    expect(dir.status).toBe(200);
    expect(dir.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await dir.text()).toBe("<h1>demo mockups</h1>");
    expect((await m("demo/index.html")).status).toBe(200);

    const css = await m("demo/style.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toBe("body{color:red}");
    expect((await m("demo/logo.svg")).headers.get("content-type")).toBe("image/svg+xml");
    expect((await m("demo/blob.bin")).headers.get("content-type")).toBe("application/octet-stream");

    // a directory without the trailing slash is redirected, so relative links inside the mockup resolve
    const bare = await m("demo", { redirect: "manual" });
    expect(bare.status).toBe(301);
    expect(bare.headers.get("location")).toBe(`/mockups/${slug}/demo/`);

    // encoded slashes survive URL normalisation and reach the resolver; mockups-evil shares the mockups prefix
    for (const p of ["..%2fsecret.txt", "demo/..%2f..%2fsecret.txt", "%2e%2e%2fsecret.txt", "..%2fmockups-evil%2fx.html", "%2Fetc%2Fpasswd", "demo/%00", "demo/missing.html", "nope/"]) {
      const r = await m(p);
      expect(`${p} ${r.status}`).toBe(`${p} 404`);
    }
    expect((await fetch(`${base}/mockups/no-such-repo/demo/`)).status).toBe(404);

    const head = await m("demo/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await head.text()).toBe("");
    expect((await m("nope/", { method: "HEAD" })).status).toBe(404);
    expect((await m("demo/", { method: "POST" })).status).toBe(405);
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

  test("sse stream: snapshot, agent, heartbeat, abort cleanup", async () => {
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const dir = join(home, ".claude/projects", cwdSlug(repoDir), "s1/subagents");
    mkdirSync(dir, { recursive: true });
    const fx = join(import.meta.dir, "../fixtures/transcripts/agent-sample");
    copyFileSync(`${fx}.jsonl`, join(dir, "agent-a1.jsonl"));
    copyFileSync(`${fx}.meta.json`, join(dir, "agent-a1.meta.json"));

    const { app, hub, base } = boot(fake, "good", home, { heartbeatMs: 50 });
    app.addRepo(repoDir);
    const q = encodeURIComponent(repoDir);
    expect((await fetch(`${base}/api/stream?repo=nope`)).status).toBe(404);
    expect((await fetch(`${base}/api/state?repo=${q}`)).status).toBe(200);

    const ac = new AbortController();
    const res = await fetch(`${base}/api/stream?repo=${q}`, { signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const reader = res.body!.getReader();
    const first = await readUntil(reader, (a) => a.includes(": connected") && a.includes("event: snapshot"), 2000);
    expect(first).toContain("event: snapshot");
    expect(hub.count(repoDir)).toBe(1);

    const r = await fetch(`${base}/api/events`, { method: "POST", body: JSON.stringify({ event: "subagent-start", ts: "x", project: repoDir, payload: { agent_id: "a1", agent_type: "factory:builder", session_id: "s1", cwd: repoDir } }) });
    expect(r.status).toBe(204);
    await readUntil(reader, (a) => a.includes("event: agent"), 2000);
    await readUntil(reader, (a) => a.includes("event: heartbeat"), 1000);

    ac.abort();
    const t0 = Date.now();
    while (hub.count(repoDir) > 0 && Date.now() - t0 < 500) await Bun.sleep(10);
    expect(hub.count(repoDir)).toBe(0);
  });

  test("task and model back-filled from the transcript meta are published as agent update", async () => {
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const dir = join(home, ".claude/projects", cwdSlug(repoDir), "s1/subagents");
    mkdirSync(dir, { recursive: true });
    const fx = join(import.meta.dir, "../fixtures/transcripts/agent-sample");
    copyFileSync(`${fx}.jsonl`, join(dir, "agent-a7.jsonl"));
    copyFileSync(`${fx}.meta.json`, join(dir, "agent-a7.meta.json")); // description "builder T-001 [task:t001]"

    const { app, base } = boot(fake, "good", home);
    app.addRepo(repoDir);
    const ac = new AbortController();
    const res = await fetch(`${base}/api/stream?repo=${encodeURIComponent(repoDir)}`, { signal: ac.signal });
    const reader = res.body!.getReader();
    await readUntil(reader, (a) => a.includes(": connected"), 2000);
    // the hook's own description has no [task:…] tag; the meta file written by Claude Code does
    await fetch(`${base}/api/events`, { method: "POST", body: JSON.stringify({ event: "subagent-start", project: repoDir, payload: { agent_id: "a7", agent_type: "factory:builder", session_id: "s1", cwd: repoDir, description: "builder T-001" } }) });
    const acc = await readUntil(reader, (a) => a.includes('"op":"update"'), 2000);
    ac.abort();
    const agentFrames = acc.split("\n\n").filter((f) => f.startsWith("event: agent")).map((f) => JSON.parse(f.slice(f.indexOf("data: ") + 6)));
    expect(agentFrames[0].op).toBe("start");
    expect(agentFrames[0].agent.taskNoteId).toBeUndefined();
    const update = agentFrames.find((f) => f.op === "update");
    expect(update.agent).toMatchObject({ agentId: "a7", taskNoteId: "t001", model: "opus" });
    expect(((await (await fetch(`${base}/api/agents?repo=${encodeURIComponent(repoDir)}`)).json()) as any).live[0].taskNoteId).toBe("t001");
  });

  test("stopped agent keeps steps until registry eviction, then tailer is dropped", async () => {
    const home = mkdtempSync(join(tmpdir(), "factory-home-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const dir = join(home, ".claude/projects", cwdSlug(repoDir), "s1/subagents");
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(import.meta.dir, "../fixtures/transcripts/agent-sample.jsonl"), join(dir, "agent-a9.jsonl"));
    let t = Date.now();
    const registry = new AgentRegistry({ recentTtlMs: 1000, now: () => t });
    const { app, base } = boot(fake, "good", home, {}, registry);
    const post = (b: unknown) => fetch(`${base}/api/events`, { method: "POST", body: JSON.stringify(b) });
    await post({ event: "subagent-start", project: repoDir, payload: { agent_id: "a9", agent_type: "x", session_id: "s1", cwd: repoDir } });
    await Bun.sleep(100);
    await post({ event: "subagent-stop", project: repoDir, payload: { agent_id: "a9" } });
    await post({ event: "subagent-stop", project: repoDir, payload: { agent_id: "never-started" } });
    expect(app.tailers.has("never-started")).toBe(false);
    const r: any = await (await fetch(`${base}/api/agents/a9/steps`)).json();
    expect(r.steps.length).toBeGreaterThan(0);
    expect(app.tailers.has("a9")).toBe(true);
    t += 5000;
    registry.prune();
    expect(app.tailers.has("a9")).toBe(false);
    expect((await fetch(`${base}/api/agents/a9/steps`)).status).toBe(404);
  });

  test("first request with unknown ws and no snapshot yields 404", async () => {
    const { app, base } = boot(fake, "good");
    app.addRepo(repoDir);
    const res = await fetch(`${base}/api/state?repo=${encodeURIComponent(repoDir)}&ws=nope`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toBe("unknown workstream");
  });
});
