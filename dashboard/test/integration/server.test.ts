import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AgentRegistry } from "../../src/agents/registry";
import { cwdSlug } from "../../src/agents/transcript-path";
import { createApp } from "../../src/app";
import type { DashboardConfig } from "../../src/config";
import { EventHub } from "../../src/hub";
import { RepoRegistry } from "../../src/repos";
import { columnFor } from "../../src/shared/columns";
import type { StreamEvent, WorkstreamSnapshot } from "../../src/shared/types";
import type { EtapiNote } from "../../src/trilium/client";
import { loadFixtureNotes, startFakeEtapi } from "./fake-etapi";

const cleanups: (() => void)[] = [];
let repoDir: string;

/** Distinctive ETAPI tokens: neither may show up in any response or console line (C1.5). */
const TOKEN = "etapi-canary-3f9c2d7e51";
const WRONG = "wrong-canary-81ab4c06";

// everything the suite writes to the console, checked by the canary test at the end
const logged: string[] = [];
const CONSOLE = ["log", "info", "warn", "error", "debug"] as const;
const originalConsole = Object.fromEntries(CONSOLE.map((m) => [m, console[m]])) as Record<(typeof CONSOLE)[number], (...a: unknown[]) => void>;
for (const m of CONSOLE) {
  console[m] = (...a: unknown[]) => {
    logged.push(a.map((x) => (typeof x === "string" ? x : Bun.inspect(x))).join(" "));
    originalConsole[m](...a);
  };
}

const postJson = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor timeout");
    await Bun.sleep(10);
  }
}

/** A factory repo; `trilium` writes its `.mcp.json` (the dashboard's only source of Trilium URL and token besides env). */
function tempRepo(config: unknown, trilium?: { url: string; token: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-repo-x-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".factory"));
  writeConfig(dir, config);
  if (trilium) writeMcp(dir, trilium.url, trilium.token);
  return dir;
}
const writeConfig = (dir: string, config: unknown) => writeFileSync(join(dir, ".factory/config.json"), JSON.stringify(config));
/** `.mcp.json` as the plugin registers the Trilium MCP server: `<base>/mcp` with a Bearer header. */
const writeMcp = (dir: string, url: string, token: string) =>
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { trilium: { type: "http", url: `${url}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }));
const DEMO = { projectNoteId: "proj1", activeWorkstream: "demo", workstreams: { demo: { noteId: "ws1" } } };

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "factory-home-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

/** Copies the sample transcript (and optionally a meta file) to `<home>/.claude/projects/<slug>/<session>/subagents/agent-<id>.jsonl`. */
function placeTranscript(home: string, slug: string, session: string, id: string, meta?: unknown): string {
  const dir = join(home, ".claude/projects", slug, session, "subagents");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `agent-${id}.jsonl`);
  copyFileSync(join(import.meta.dir, "../fixtures/transcripts/agent-sample.jsonl"), p);
  if (meta) writeFileSync(p.replace(/\.jsonl$/, ".meta.json"), JSON.stringify(meta));
  return p;
}

const stamp = { dateCreated: "2026-11-10 09:00:00.000+0000", dateModified: "2026-11-10 10:00:00.000+0000", utcDateCreated: "2026-11-10 09:00:00.000Z", utcDateModified: "2026-11-10 10:00:00.000Z" };
function mk(noteId: string, title: string, parent: string, labels: Record<string, string>): EtapiNote {
  return {
    noteId, title, type: "text", mime: "text/html", parentNoteIds: [parent], childNoteIds: [], ...stamp,
    attributes: Object.entries(labels).map(([name, value], i) => ({ attributeId: `${noteId}-${name}`, noteId, type: "label" as const, name, value, position: 10 + i, isInheritable: false })),
  };
}

/**
 * The fixture tree plus: a second workstream `next` whose task is also `T-001` (with its own run), runs of the demo T-001
 * (one labelled, one from before `#workstream` existed), and T-003 with 25 run children ahead of its spec and two approvals.
 */
function extendedFixtures() {
  const fx = loadFixtureNotes();
  const run = (id: string, parent: string, taskId: string, ws?: string) =>
    mk(id, `2026-11-10T10:00:00Z builder ${id}`, parent, { factoryAgentRun: "", agentType: "builder", agentId: `ag-${id}`, status: "done", taskId, ...(ws ? { workstream: ws } : {}) });
  const extra: EtapiNote[] = [
    mk("ws2", "next", "proj1", { factoryWorkstream: "", slug: "next", project: "demo-repo" }),
    mk("mn1", "M1 Next", "ws2", { factoryMilestone: "", milestoneId: "M1", order: "1", status: "active", workstream: "next" }),
    mk("tn1", "T-001 Next task", "mn1", { factoryTask: "", taskId: "T-001", status: "building", milestoneId: "M1", order: "1", round: "0", workstream: "next" }),
    run("runNext", "tn1", "T-001", "next"),
    run("runDemo", "t001", "T-001", "demo"),
    run("runLegacy", "t001", "T-001"),
  ];
  const runs = Array.from({ length: 25 }, (_, i) => run(`runX${String(i).padStart(2, "0")}`, "t003", "T-003", "demo"));
  const spec = mk("t003spec", "T-003 spec", "t003", { factoryDoc: "task-spec", workstream: "demo" });
  const a1 = mk("t003a1", "T-003 approval R1", "t003", { factoryDoc: "approval", round: "1", workstream: "demo" });
  const a2 = mk("t003a2", "T-003 approval R2", "t003", { factoryDoc: "approval", round: "2", workstream: "demo" });
  extra.push(...runs, spec, a1, a2);
  // the 25 runs come first among the children, as they would after a long fix loop
  fx.notes.find((n) => n.noteId === "t003")!.childNoteIds = [...runs, spec, a1, a2].map((n) => n.noteId);
  fx.notes.push(...extra);
  Object.assign(fx.contents, { t003spec: "<p>T-003 spec</p>", t003a1: "<p>approval R1</p>", t003a2: "<p>approval R2</p>" });
  return fx;
}

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

/**
 * Each repo's Trilium URL and token come from its `.mcp.json` (`env` stands in for FACTORY_TRILIUM_URL /
 * FACTORY_ETAPI_TOKEN; the process env is never read). `tls` records the TLS option of every Trilium request.
 */
function boot(homeDir = "", opts: { heartbeatMs?: number; now?: () => number; sweepMs?: number } = {}, registry = new AgentRegistry(), env: Record<string, string> = {}, tlsVerify = false) {
  const config: DashboardConfig = { port: 0, pollMs: 60000, gitPollMs: 60000, configDir: "", homeDir, tlsVerify };
  const hub = new EventHub();
  const tls: unknown[] = [];
  const fetchImpl = ((url: any, init: any) => { tls.push(init?.tls); return fetch(url, init); }) as typeof fetch;
  const repos = new RepoRegistry({ trilium: { env, homeDir } });
  const app = createApp({ config, repos, hub, registry, homeDir, fetchImpl }, opts);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
  cleanups.push(() => { app.stop(); server.stop(true); });
  return { app, hub, tls, base: `http://127.0.0.1:${server.port}`, port: server.port as number };
}

let fake: ReturnType<typeof startFakeEtapi>;
let ext: ReturnType<typeof startFakeEtapi>;
beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), "factory-repo-"));
  mkdirSync(join(repoDir, ".factory"));
  writeFileSync(join(repoDir, ".factory/config.json"), JSON.stringify(DEMO));
  const mock = join(repoDir, ".factory/mockups/demo");
  mkdirSync(mock, { recursive: true });
  writeFileSync(join(mock, "index.html"), "<h1>demo mockups</h1>");
  writeFileSync(join(mock, "style.css"), "body{color:red}");
  writeFileSync(join(mock, "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(join(mock, "blob.bin"), "xx");
  writeFileSync(join(repoDir, ".factory/secret.txt"), "secret");
  mkdirSync(join(repoDir, ".factory/mockups-evil"));
  writeFileSync(join(repoDir, ".factory/mockups-evil/x.html"), "evil");
  fake = startFakeEtapi({ ...loadFixtureNotes(), token: TOKEN });
  ext = startFakeEtapi({ ...extendedFixtures(), token: TOKEN });
  writeMcp(repoDir, fake.url, TOKEN);
});
afterAll(() => {
  cleanups.forEach((c) => c());
  fake.stop();
  ext.stop();
  rmSync(repoDir, { recursive: true, force: true });
  for (const m of CONSOLE) console[m] = originalConsole[m];
});

describe("dashboard server", () => {
  test("health, repos, state, docs, tasks", async () => {
    const { app, base } = boot();
    expect(app.addRepo(repoDir)).not.toBeNull();
    const cold: any = await (await fetch(`${base}/api/health`)).json();
    expect(cold.trilium).toMatchObject({ ok: false, error: "no poller has refreshed yet" });
    await Promise.all([...app.pollers.values()].map((p) => p.refresh()));
    const health: any = await (await fetch(`${base}/api/health`)).json();
    expect(health.ok).toBe(true);
    expect(health.trilium.ok).toBe(true);
    expect(health.repos).toContain(repoDir);
    expect(health.trilium).toEqual({ ok: true });
    expect(JSON.stringify(health)).not.toContain(TOKEN);

    const repos: any = await (await fetch(`${base}/api/repos`)).json();
    expect(repos.repos[0].workstreams).toEqual([{ slug: "demo", noteId: "ws1" }]);
    expect(repos.repos[0].trilium).toEqual({ baseUrl: fake.url, placeholder: false, source: "project" });

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
    const { base } = boot();
    const post = (body: string) => postJson(`${base}/api/repos`, body);
    expect((await post(JSON.stringify({ path: repoDir }))).status).toBe(201);
    // a cross-site form can only send text/plain, form-urlencoded or multipart: without application/json it is 415
    const plain = await fetch(`${base}/api/repos`, { method: "POST", body: JSON.stringify({ path: repoDir }) });
    expect(plain.status).toBe(415);
    expect((await fetch(`${base}/api/repos`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "path=/x" })).status).toBe(415);
    expect((await postJson(`${base}/api/repos`, { path: repoDir }, { "Content-Type": "application/json; charset=utf-8" })).status).toBe(201);
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
    const { app, base } = boot();
    app.addRepo(repoDir);
    const slug = basename(repoDir);
    const m = (p: string, init?: RequestInit) => fetch(`${base}/mockups/${slug}/${p}`, init);

    const dir = await m("demo/");
    expect(dir.status).toBe(200);
    expect(dir.headers.get("content-type")).toBe("text/html; charset=utf-8");
    // mockup HTML runs in a sandbox: an opaque origin, so its scripts cannot call /api/* as the dashboard
    expect(dir.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-forms allow-modals allow-popups");
    expect((await m("demo/index.html")).headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-forms allow-modals allow-popups");
    expect(await dir.text()).toBe("<h1>demo mockups</h1>");
    expect((await m("demo/index.html")).status).toBe(200);

    const css = await m("demo/style.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toBe("body{color:red}");
    expect((await m("demo/logo.svg")).headers.get("content-type")).toBe("image/svg+xml");
    expect((await m("demo/logo.svg")).headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-forms allow-modals allow-popups");
    expect(css.headers.get("content-security-policy")).toBeNull();
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
    const { app, base } = boot();
    app.addRepo(tempRepo(DEMO, { url: fake.url, token: WRONG }));
    await Promise.all([...app.pollers.values()].map((p) => p.refresh()));
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const h: any = await res.json();
    expect(h.trilium.ok).toBe(false);
    expect(h.trilium.error).toBe("trilium returned 401");
    expect(JSON.stringify(h)).not.toContain(WRONG);
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

    const { base } = boot(home);
    const post = (b: unknown) => postJson(`${base}/api/events`, b);
    const q = encodeURIComponent(repoDir);
    const reposBefore = await (await fetch(`${base}/api/repos`)).json();

    expect((await post({})).status).toBe(400);
    expect((await fetch(`${base}/api/events`, { method: "POST", body: JSON.stringify({ event: "stage", project: repoDir }) })).status).toBe(415);
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

    const { app, hub, base } = boot(home, { heartbeatMs: 50 });
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

    const r = await postJson(`${base}/api/events`, { event: "subagent-start", ts: "x", project: repoDir, payload: { agent_id: "a1", agent_type: "factory:builder", session_id: "s1", cwd: repoDir } });
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

    const { app, base } = boot(home);
    app.addRepo(repoDir);
    const ac = new AbortController();
    const res = await fetch(`${base}/api/stream?repo=${encodeURIComponent(repoDir)}`, { signal: ac.signal });
    const reader = res.body!.getReader();
    await readUntil(reader, (a) => a.includes(": connected"), 2000);
    // the hook's own description has no [task:…] tag; the meta file written by Claude Code does
    await postJson(`${base}/api/events`, { event: "subagent-start", project: repoDir, payload: { agent_id: "a7", agent_type: "factory:builder", session_id: "s1", cwd: repoDir, description: "builder T-001" } });
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
    const { app, base } = boot(home, {}, registry);
    const post = (b: unknown) => postJson(`${base}/api/events`, b);
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
    const { app, base } = boot();
    app.addRepo(repoDir);
    const res = await fetch(`${base}/api/state?repo=${encodeURIComponent(repoDir)}&ws=nope`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toBe("unknown workstream");
  });

  test("host guard: a foreign or missing Host is 403 on every route, incl. SSE and mockups", async () => {
    const { app, base, port } = boot();
    app.addRepo(repoDir);
    const q = encodeURIComponent(repoDir);
    const slug = basename(repoDir);
    const paths = ["/api/health", "/api/repos", `/api/state?repo=${q}`, "/api/docs/d2", "/api/tasks/t002", `/api/agents?repo=${q}`,
      `/api/repo?repo=${q}`, "/api/agents/a1/steps", `/api/stream?repo=${q}`, `/mockups/${slug}/demo/`, "/nope"];
    for (const host of ["evil.example", `evil.example:${port}`, `127.0.0.1:${port + 1}`, `localhost.evil.example:${port}`, `127.0.0.1.nip.io:${port}`]) {
      for (const path of paths) {
        const r = await fetch(`${base}${path}`, { headers: { Host: host } });
        expect(`${host} ${path} ${r.status}`).toBe(`${host} ${path} 403`);
        expect(await r.json()).toEqual({ error: "forbidden host" });
      }
      const ev = await postJson(`${base}/api/events`, { event: "stage", project: repoDir }, { Host: host });
      expect(ev.status).toBe(403);
      expect((await postJson(`${base}/api/repos`, { path: repoDir }, { Host: host })).status).toBe(403);
    }
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`]) {
      expect(`${host} ${(await fetch(`${base}/api/health`, { headers: { Host: host } })).status}`).toBe(`${host} 200`);
    }
    // HTTP/1.0 without a Host header
    const raw = await new Promise<string>((done) => {
      let acc = "";
      void Bun.connect({ hostname: "127.0.0.1", port, socket: {
        open(s) { s.write("GET /api/health HTTP/1.0\r\n\r\n"); },
        data(_s, d) { acc += new TextDecoder().decode(d); },
        close() { done(acc); },
        error() { done(acc); },
      } });
    });
    expect(raw).toStartWith("HTTP/1.1 403");
  });

  test("docs are scoped to the snapshot: docs, rounds, reviews and the task spec/approval /api/tasks returned", async () => {
    const { app, base } = boot();
    app.addRepo(repoDir);
    await Promise.all([...app.pollers.values()].map((p) => p.refresh()));
    expect((await fetch(`${base}/api/docs/d2`)).status).toBe(200);
    expect((await fetch(`${base}/api/docs/v1`)).status).toBe(200); // validation round
    const review = await fetch(`${base}/api/docs/r2`);
    expect(review.status).toBe(200);
    expect(await review.json()).toMatchObject({ noteId: "r2", title: "Review T-002 r1 code", format: "html", content: expect.stringContaining("swallows") });
    // notes Trilium has but the factory does not show as documents: the project, a task, a run, the root
    for (const id of ["proj1", "t001", "run1", "ws1", "root", "zzz"]) {
      const r = await fetch(`${base}/api/docs/${id}`);
      expect(`${id} ${r.status}`).toBe(`${id} 404`);
    }
    // a task's spec and approval are #factoryDoc notes under the workstream: snapshot docs
    expect((await fetch(`${base}/api/docs/t002spec`)).status).toBe(200);
    expect(((await (await fetch(`${base}/api/docs/t002appr`)).json()) as any).content).toContain("Approved");
    expect(fake.calls.some((c) => c.startsWith("/etapi/notes/root") || c.startsWith("/etapi/notes/proj1/content"))).toBe(false);
  });

  test("approval: the highest #round among the task's direct #factoryDoc children, past 20 children", async () => {
    const { app, base } = boot();
    app.addRepo(tempRepo(DEMO, { url: ext.url, token: TOKEN }));
    await Promise.all([...app.pollers.values()].map((p) => p.refresh()));
    const t: any = await (await fetch(`${base}/api/tasks/t003`)).json();
    expect(t.spec?.content).toBe("<p>T-003 spec</p>");
    expect(t.approval?.content).toBe("<p>approval R2</p>");
    expect(ext.calls).toContain("/etapi/notes?search=%23factoryDoc&ancestorNoteId=t003&ancestorDepth=eq1");
    expect((await fetch(`${base}/api/docs/t003a2`)).status).toBe(200);
    expect((await fetch(`${base}/api/docs/runX00`)).status).toBe(404);

    // an approval written after the last poll: out of scope until /api/tasks returns it, then readable
    ext.add(mk("t003a3", "T-003 approval R3", "t003", { factoryDoc: "approval", round: "3", workstream: "demo" }), "<p>approval R3</p>");
    expect((await fetch(`${base}/api/docs/t003a3`)).status).toBe(404);
    expect(((await (await fetch(`${base}/api/tasks/t003`)).json()) as any).approval.content).toBe("<p>approval R3</p>");
    expect(((await (await fetch(`${base}/api/docs/t003a3`)).json()) as any)).toMatchObject({ title: "T-003 approval R3", format: "html", content: "<p>approval R3</p>" });
  });

  test("runs are joined to a task by #taskId within the workstream on screen (same T-001 in two workstreams)", async () => {
    const repo = tempRepo({ projectNoteId: "proj1", activeWorkstream: "demo", workstreams: { demo: { noteId: "ws1" }, next: { noteId: "ws2" } } }, { url: ext.url, token: TOKEN });
    const { app, base } = boot();
    app.addRepo(repo);
    const q = encodeURIComponent(repo);
    const demo = (await (await fetch(`${base}/api/state?repo=${q}`)).json()) as WorkstreamSnapshot;
    expect(demo.runs.find((r) => r.id === "runNext")?.workstream).toBe("next");
    const t: any = await (await fetch(`${base}/api/tasks/t001`)).json();
    expect(t.runs.map((r: any) => r.id).sort()).toEqual(["runDemo", "runLegacy"]);
    expect((await fetch(`${base}/api/state?repo=${q}&ws=next`)).status).toBe(200);
    const n: any = await (await fetch(`${base}/api/tasks/tn1`)).json();
    expect(n.runs.map((r: any) => r.id).sort()).toEqual(["runLegacy", "runNext"]);
  });

  test("config is re-read on events and GET /api/repos: a second workstream appears and the poller follows activeWorkstream until the user picks one", async () => {
    const repo = tempRepo(DEMO, { url: ext.url, token: TOKEN });
    const { app, base } = boot();
    app.addRepo(repo);
    const poller = app.pollers.get(repo)!;
    await poller.refresh();
    expect(poller.snapshot()!.workstream!.slug).toBe("demo");
    expect(poller.snapshot()!.workstreams.map((w) => w.slug).sort()).toEqual(["demo", "next"]);
    const repos = async () => ((await (await fetch(`${base}/api/repos`)).json()) as any).repos.find((r: any) => r.repoPath === repo);
    expect((await repos()).workstreams).toEqual([{ slug: "demo", noteId: "ws1" }]);

    // the plugin adds a workstream and makes it active, then an event arrives
    writeConfig(repo, { projectNoteId: "proj1", activeWorkstream: "next", workstreams: { demo: { noteId: "ws1" }, next: { noteId: "ws2" } } });
    expect((await postJson(`${base}/api/events`, { event: "stage", project: repo, payload: {} })).status).toBe(204);
    await waitFor(() => poller.snapshot()?.workstream?.slug === "next");
    expect(await repos()).toMatchObject({ activeWorkstream: "next", workstreams: [{ slug: "demo", noteId: "ws1" }, { slug: "next", noteId: "ws2" }] });

    // GET /api/repos alone also re-reads the config
    const cfg = (active: string) => ({ projectNoteId: "proj1", activeWorkstream: active, workstreams: { demo: { noteId: "ws1" }, next: { noteId: "ws2" }, third: {} } });
    writeConfig(repo, cfg("demo"));
    expect(await repos()).toMatchObject({ activeWorkstream: "demo", workstreams: [{ slug: "demo" }, { slug: "next" }, { slug: "third" }] });
    await waitFor(() => poller.snapshot()?.workstream?.slug === "demo");

    // once the user picks a workstream, neither the config nor an event's workstream moves the poller
    expect((await fetch(`${base}/api/state?repo=${encodeURIComponent(repo)}&ws=next`)).status).toBe(200);
    expect(poller.snapshot()!.workstream!.slug).toBe("next");
    writeConfig(repo, cfg("next"));
    await repos();
    writeConfig(repo, cfg("demo"));
    expect((await repos()).activeWorkstream).toBe("demo");
    await postJson(`${base}/api/events`, { event: "stage", project: repo, workstream: "demo", payload: {} });
    await Bun.sleep(400);
    expect(poller.snapshot()!.workstream!.slug).toBe("next");
  });

  test("the envelope's workstream moves a poller the user has not pointed elsewhere", async () => {
    const repo = tempRepo({ projectNoteId: "proj1", activeWorkstream: "demo", workstreams: { demo: { noteId: "ws1" }, next: { noteId: "ws2" } } }, { url: ext.url, token: TOKEN });
    const { app, base } = boot();
    app.addRepo(repo);
    const poller = app.pollers.get(repo)!;
    await poller.refresh();
    expect(poller.snapshot()!.workstream!.slug).toBe("demo");
    expect((await postJson(`${base}/api/events`, { event: "stage", project: repo, workstream: "next", stage: "validate", status: "started", payload: {} })).status).toBe(204);
    await waitFor(() => poller.snapshot()?.workstream?.slug === "next");
  });

  test("agents belong to the posted project, not payload.cwd; transcript found via transcript_path, else the project's slug", async () => {
    const home = tempHome();
    const worktree = join(repoDir, ".factory/worktrees/demo");
    placeTranscript(home, cwdSlug(repoDir), "s1", "c1", { agentType: "factory:codebase-examiner", description: "examine [task:none]" });
    const elsewhere = placeTranscript(home, "-elsewhere", "s2", "c2");
    const { base } = boot(home);
    const q = encodeURIComponent(repoDir);
    // c1: no transcript_path; the transcript sits under the project's slug while the subagent's cwd is a worktree
    expect((await postJson(`${base}/api/events`, { event: "subagent-start", project: repoDir, payload: { agent_id: "c1", session_id: "s1", cwd: worktree, description: "examine [task:none]" } })).status).toBe(204);
    // c2: the session transcript path names the folder, whatever the cwd or project slug
    await postJson(`${base}/api/events`, { event: "subagent-start", project: repoDir, payload: { agent_id: "c2", session_id: "s2", cwd: worktree, transcript_path: join(home, ".claude/projects/-elsewhere/s2.jsonl") } });
    const ag: any = await (await fetch(`${base}/api/agents?repo=${q}`)).json();
    expect(ag.live.map((a: any) => a.agentId).sort()).toEqual(["c1", "c2"]);
    const c1 = ag.live.find((a: any) => a.agentId === "c1");
    expect(c1).toMatchObject({ cwd: worktree, repoKey: repoDir });
    expect(c1.taskNoteId).toBeUndefined(); // [task:none], in the hook description and in the meta file
    expect(ag.live.find((a: any) => a.agentId === "c2").transcriptPath).toBe(elsewhere);
    for (const id of ["c1", "c2"]) {
      const steps: any = await (await fetch(`${base}/api/agents/${id}/steps`)).json();
      expect(`${id} ${steps.steps.length > 0}`).toBe(`${id} true`);
    }
    expect(((await (await fetch(`${base}/api/agents?repo=${encodeURIComponent(worktree)}`)).json()) as any).error).toBe("unknown repo");
  });

  test("subagent-stop with agent_transcript_path replaces a tailer that never found the file or tails another one", async () => {
    const home = tempHome();
    const { app, base } = boot(home);
    const post = (b: unknown) => postJson(`${base}/api/events`, b);
    const steps = async (id: string) => ((await (await fetch(`${base}/api/agents/${id}/steps`)).json()) as any);

    // m1: nothing to find at start; the transcript turns up in a folder the lookup does not search
    await post({ event: "subagent-start", project: repoDir, payload: { agent_id: "m1", session_id: "s1", cwd: repoDir } });
    expect(app.tailers.get("m1")!.found).toBe(false);
    const p1 = placeTranscript(home, "-unrelated", "s1", "m1");
    await post({ event: "subagent-stop", project: repoDir, payload: { agent_id: "m1", agent_transcript_path: p1 } });
    const s1 = await steps("m1");
    expect(s1.finished).toBe(true);
    expect(s1.steps.length).toBeGreaterThan(0);
    const m1: any = (await (await fetch(`${base}/api/agents?repo=${encodeURIComponent(repoDir)}`)).json()).recent.find((a: any) => a.agentId === "m1");
    expect(m1).toMatchObject({ transcriptPath: p1, stepCount: s1.steps.length });

    // m2: the start lookup found a different file than the one Claude Code reports at stop
    placeTranscript(home, cwdSlug(repoDir), "s1", "m2");
    await post({ event: "subagent-start", project: repoDir, payload: { agent_id: "m2", session_id: "s1", cwd: repoDir } });
    expect(app.tailers.get("m2")!.found).toBe(true);
    const p2 = join(home, ".claude/projects/-other/s9/subagents/agent-m2.jsonl");
    mkdirSync(join(p2, ".."), { recursive: true });
    writeFileSync(p2, JSON.stringify({ type: "assistant", timestamp: "2026-11-10T03:18:11.000Z", message: { role: "assistant", content: [{ type: "text", text: "only step" }] } }) + "\n");
    await post({ event: "subagent-stop", project: repoDir, payload: { agent_id: "m2", agent_transcript_path: p2 } });
    const s2 = await steps("m2");
    expect(s2.steps.map((s: any) => s.text)).toEqual(["only step"]);

    // m3: a path outside ~/.claude/projects is ignored
    const outside = mkdtempSync(join(tmpdir(), "factory-outside-"));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    copyFileSync(join(import.meta.dir, "../fixtures/transcripts/agent-sample.jsonl"), join(outside, "agent-m3.jsonl"));
    await post({ event: "subagent-start", project: repoDir, payload: { agent_id: "m3", session_id: "s1", cwd: repoDir } });
    await post({ event: "subagent-stop", project: repoDir, payload: { agent_id: "m3", agent_transcript_path: join(outside, "agent-m3.jsonl") } });
    expect((await steps("m3")).steps).toHaveLength(0);
  });

  test("session-start: a new session (startup, or no source and another session_id) ends the repo's other sessions' live agents", async () => {
    const { hub, base } = boot();
    const stops: string[] = [];
    hub.subscribe(repoDir, (e: StreamEvent) => { if (e.type === "agent" && e.data.op === "stop") stops.push(e.data.agent.agentId); });
    const post = (b: unknown) => postJson(`${base}/api/events`, b);
    const start = (id: string, session: string) => post({ event: "subagent-start", project: repoDir, payload: { agent_id: id, session_id: session, cwd: repoDir } });
    const live = async () => (((await (await fetch(`${base}/api/agents?repo=${encodeURIComponent(repoDir)}`)).json()) as any).live.map((a: any) => a.agentId).sort());
    await start("old1", "s1");
    await start("cur1", "s2");
    for (const source of ["compact", "clear"]) await post({ event: "session-start", project: repoDir, payload: { session_id: "s2", source } });
    expect(await live()).toEqual(["cur1", "old1"]);
    await post({ event: "session-start", project: repoDir, payload: { session_id: "s2", source: "startup" } });
    expect(await live()).toEqual(["cur1"]);
    expect(stops).toEqual(["old1"]);
    await start("old2", "s2");
    await post({ event: "session-start", project: repoDir, payload: { session_id: "s3" } });
    expect(await live()).toEqual([]);
    expect(stops.sort()).toEqual(["cur1", "old1", "old2"]);
  });

  test("idle sweep: an agent whose transcript has not grown for 30 min, or with no transcript started 30 min ago, is stopped", async () => {
    const home = tempHome();
    const t0 = Date.now();
    let t = t0;
    const now = () => t;
    const { app, hub, base } = boot(home, { now, sweepMs: 3_600_000 }, new AgentRegistry({ now }));
    const stops: string[] = [];
    hub.subscribe(repoDir, (e: StreamEvent) => { if (e.type === "agent" && e.data.op === "stop") stops.push(e.data.agent.agentId); });
    const quiet = placeTranscript(home, cwdSlug(repoDir), "s1", "i1");
    const busy = placeTranscript(home, cwdSlug(repoDir), "s1", "i3");
    for (const id of ["i1", "i2", "i3"]) await postJson(`${base}/api/events`, { event: "subagent-start", project: repoDir, payload: { agent_id: id, session_id: "s1", cwd: repoDir } });
    expect(app.tailers.get("i1")!.lastGrowthAt).toBe(t0);
    expect(app.tailers.get("i2")!.found).toBe(false); // i2 has no transcript at all
    t = t0 + 20 * 60_000;
    appendFileSync(busy, readFileSync(quiet, "utf8").split("\n")[0] + "\n");
    app.tailers.get("i3")!.readMore();
    t = t0 + 29 * 60_000;
    app.sweep();
    expect(stops).toEqual([]);
    t = t0 + 31 * 60_000;
    app.sweep();
    expect(stops.sort()).toEqual(["i1", "i2"]);
    const ag: any = await (await fetch(`${base}/api/agents?repo=${encodeURIComponent(repoDir)}`)).json();
    expect(ag.live.map((a: any) => a.agentId)).toEqual(["i3"]);
    t = t0 + 51 * 60_000;
    app.sweep();
    expect(stops.sort()).toEqual(["i1", "i2", "i3"]);
  });

  test("per-repo credentials: each repo polls the Trilium its .mcp.json names; docs and tasks use the owning repo's client", async () => {
    const { app, base } = boot();
    const other = tempRepo({ projectNoteId: "proj1", activeWorkstream: "next", workstreams: { demo: { noteId: "ws1" }, next: { noteId: "ws2" } } }, { url: ext.url, token: TOKEN });
    app.addRepo(repoDir);
    app.addRepo(other);
    // what each board shows tells the servers apart: only ext has workstream `next` (tn1) and the extra runs
    const demo = await fetch(`${base}/api/state?repo=${encodeURIComponent(repoDir)}`);
    expect(demo.status).toBe(200);
    expect(((await demo.json()) as WorkstreamSnapshot).runs.map((r) => r.id)).not.toContain("runDemo");
    const next = await fetch(`${base}/api/state?repo=${encodeURIComponent(other)}`);
    expect(next.status).toBe(200);
    const nextSnap = (await next.json()) as WorkstreamSnapshot;
    expect(nextSnap.tasks.map((t) => t.id)).toEqual(["tn1"]);
    expect(nextSnap.runs.map((r) => r.id)).toContain("runDemo");

    const listed: any = await (await fetch(`${base}/api/repos`)).json();
    const byPath = Object.fromEntries(listed.repos.map((r: any) => [r.repoPath, r.trilium]));
    expect(byPath).toEqual({
      [repoDir]: { baseUrl: fake.url, placeholder: false, source: "project" },
      [other]: { baseUrl: ext.url, placeholder: false, source: "project" },
    });

    // tn1 is only on the ext repo's board: its detail is fetched from ext, never from fake
    expect((await fetch(`${base}/api/tasks/tn1`)).status).toBe(200);
    expect(ext.calls).toContain("/etapi/notes?search=%23factoryDoc&ancestorNoteId=tn1&ancestorDepth=eq1");
    expect(fake.calls.some((c) => c.includes("tn1"))).toBe(false);
  });

  test("placeholder token: the repo is registered, its state is 503, health names the error, Trilium gets no request; a real token is picked up", async () => {
    const own = startFakeEtapi({ ...loadFixtureNotes(), token: TOKEN }); // this repo's Trilium alone: its calls are this test's
    cleanups.push(() => own.stop());
    const { app, base } = boot();
    const repo = tempRepo(DEMO, { url: own.url, token: "your-etapi-token" });
    const q = encodeURIComponent(repo);
    const added = await postJson(`${base}/api/repos`, { path: repo });
    expect(added.status).toBe(201);
    expect(((await added.json()) as any).trilium).toEqual({ baseUrl: own.url, placeholder: true, source: "project" });

    const st = await fetch(`${base}/api/state?repo=${q}`);
    expect(st.status).toBe(503);
    expect(await st.json()).toEqual({ error: "trilium token not configured" });
    expect(app.pollers.get(repo)!.lastError()).toBe("trilium token not configured");
    expect(((await (await fetch(`${base}/api/health`)).json()) as any).trilium).toEqual({ ok: false, error: "trilium token not configured" });
    expect(own.calls).toEqual([]);

    // the user pastes the real token; the next GET /api/repos (the web app re-reads it every 30 s) picks it up
    writeMcp(repo, own.url, TOKEN);
    const listed: any = await (await fetch(`${base}/api/repos`)).json();
    expect(listed.repos[0].trilium).toEqual({ baseUrl: own.url, placeholder: false, source: "project" });
    expect((await fetch(`${base}/api/state?repo=${q}`)).status).toBe(200);
    expect(own.calls.length).toBeGreaterThan(0);
    expect(((await (await fetch(`${base}/api/health`)).json()) as any).trilium).toEqual({ ok: true });

    // a repo with no trilium server anywhere is registered too, and says so
    const bare = tempRepo(DEMO);
    expect(app.addRepo(bare)!.trilium).toBeUndefined();
    const b = await fetch(`${base}/api/state?repo=${encodeURIComponent(bare)}`);
    expect(b.status).toBe(503);
    expect(await b.json()).toEqual({ error: "trilium not configured" });
    expect(((await (await fetch(`${base}/api/health`)).json()) as any).trilium).toEqual({ ok: false, error: "trilium not configured" });
  });

  test("env FACTORY_TRILIUM_URL / FACTORY_ETAPI_TOKEN still win over the repo's .mcp.json", async () => {
    const repo = tempRepo(DEMO, { url: "http://127.0.0.1:9", token: WRONG });
    const { app, base } = boot("", {}, new AgentRegistry(), { FACTORY_TRILIUM_URL: fake.url, FACTORY_ETAPI_TOKEN: TOKEN });
    expect(app.addRepo(repo)!.trilium).toEqual({ baseUrl: fake.url, placeholder: false, source: "env" });
    const st = await fetch(`${base}/api/state?repo=${encodeURIComponent(repo)}`);
    expect(st.status).toBe(200);
    expect(((await st.json()) as WorkstreamSnapshot).tasks).toHaveLength(5);
  });

  test("TLS verification: off by default on every Trilium request, on with config.tlsVerify", async () => {
    const off = boot();
    off.app.addRepo(repoDir);
    expect((await fetch(`${off.base}/api/state?repo=${encodeURIComponent(repoDir)}`)).status).toBe(200);
    expect((await fetch(`${off.base}/api/tasks/t002`)).status).toBe(200);
    expect(off.tls.length).toBeGreaterThan(5);
    expect(off.tls.every((t) => JSON.stringify(t) === JSON.stringify({ rejectUnauthorized: false }))).toBe(true);
    const on = boot("", {}, new AgentRegistry(), {}, true);
    on.app.addRepo(repoDir);
    expect((await fetch(`${on.base}/api/state?repo=${encodeURIComponent(repoDir)}`)).status).toBe(200);
    expect(on.tls.length).toBeGreaterThan(5);
    expect(on.tls.every((t) => JSON.stringify(t) === JSON.stringify({ rejectUnauthorized: true }))).toBe(true);
  });

  describe("repo routes", () => {
    // every commit gets its own increasing timestamp, so --date-order is deterministic
    let tick = 0;
    const git = (cwd: string, ...args: string[]) => gitAt(undefined, cwd, ...args);
    const gitAt = (date: string | undefined, cwd: string, ...args: string[]) => {
      const ts = date ?? `2026-11-10T10:${String(tick++).padStart(2, "0")}:00Z`;
      const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
        { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_DATE: ts, GIT_COMMITTER_DATE: ts } });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
      return r.stdout.toString().trim();
    };
    const commit = (cwd: string, file: string, msg: string) => { writeFileSync(join(cwd, file), `${msg}\n`); git(cwd, "add", "-A"); git(cwd, "commit", "-q", "-m", msg); };
    beforeAll(() => {
      git(repoDir, "init", "-q", "-b", "main");
      commit(repoDir, "a.txt", "chore: enforce standards");
      const wt = join(repoDir, ".factory/worktrees/checkout-flow");
      git(repoDir, "worktree", "add", "-q", "-b", "checkout-flow", wt);
      commit(wt, "b.txt", "feat(cart): summary\n\nTask: checkout-flow/T-001");
      commit(wt, "c.txt", "test(cart): totals\n\nTask: checkout-flow/T-001");
      git(repoDir, "merge", "--no-ff", "-q", "-m", "Merge checkout-flow: T-001 Cart summary", "checkout-flow");
      commit(wt, "d.txt", "feat(address): validation\n\nTask: checkout-flow/T-002");
    });

    test("/api/repo serves the registered repo's snapshot; validates limit and branch; unknown repo is 404", async () => {
      const { base, app } = boot(); app.addRepo(repoDir); const q = encodeURIComponent(repoDir);
      expect((await fetch(`${base}/api/repo?repo=nope`)).status).toBe(404);
      const snap = (await (await fetch(`${base}/api/repo?repo=${q}`)).json()) as any;
      expect(snap.defaultBranch).toBe("main");
      expect(snap.branches.map((b: any) => b.name).sort()).toEqual(["checkout-flow", "main"]);
      expect(snap.commits.length).toBeGreaterThanOrEqual(4);
      expect((await fetch(`${base}/api/repo?repo=${q}&limit=0`)).status).toBe(400);
      expect((await fetch(`${base}/api/repo?repo=${q}&limit=501`)).status).toBe(400);
      expect((await fetch(`${base}/api/repo?repo=${q}&branch=nope`)).status).toBe(400);
      const filtered = (await (await fetch(`${base}/api/repo?repo=${q}&branch=checkout-flow&limit=2`)).json()) as any;
      expect(filtered.commits.length).toBe(2); expect(filtered.truncated).toBe(true); expect(filtered.limit).toBe(2);
    });
    test("/api/repo/commits/:sha serves detail, rejects bad shas, 404s unknown ones", async () => {
      const { base, app } = boot(); app.addRepo(repoDir); const q = encodeURIComponent(repoDir);
      const snap = (await (await fetch(`${base}/api/repo?repo=${q}`)).json()) as any;
      const sha = snap.commits[0].sha;
      const d = (await (await fetch(`${base}/api/repo/commits/${sha}?repo=${q}`)).json()) as any;
      expect(d.commit.sha).toBe(sha); expect(Array.isArray(d.files)).toBe(true); expect(d.totals.files).toBe(d.files.length);
      expect((await fetch(`${base}/api/repo/commits/zzz?repo=${q}`)).status).toBe(400);
      expect((await fetch(`${base}/api/repo/commits/${"0".repeat(40)}?repo=${q}`)).status).toBe(404);
      expect((await fetch(`${base}/api/repo/commits/${sha}?repo=nope`)).status).toBe(404);
    });
    test("a git failure on a commit lookup is a 500 that logs no git output", async () => {
      const { base, app } = boot(); const plain = tempRepo({}); app.addRepo(plain);
      const r = await fetch(`${base}/api/repo/commits/abcdef0?repo=${encodeURIComponent(plain)}`);
      expect(r.status).toBe(500);
      expect(await r.json()).toEqual({ error: "git failed" });
      for (const line of logged) { expect(line).not.toContain("fatal:"); expect(line).not.toContain("not a git repository"); }
    });
    test("the stream sends a repo frame on connect and after a task event that changed git", async () => {
      const { base, app } = boot(); app.addRepo(repoDir); const q = encodeURIComponent(repoDir);
      await app.gitPollers.get(repoDir)!.refresh();
      const ac = new AbortController();
      const res = await fetch(`${base}/api/stream?repo=${q}`, { signal: ac.signal });
      const reader = res.body!.getReader();
      await readUntil(reader, (a) => a.includes("event: repo"), 2000);
      // a new commit on main, then the hook's task event: the poller refreshes and pushes
      writeFileSync(join(repoDir, "z.txt"), "z\n");
      gitAt(undefined, repoDir, "add", "-A");
      gitAt("2027-01-01T00:00:00Z", repoDir, "commit", "-q", "-m", "chore: z"); // newer than every fixture commit
      await postJson(`${base}/api/events`, { event: "task", ts: "x", project: repoDir, task: "T-001", status: "done", payload: {} });
      const acc = await readUntil(reader, (a) => a.includes("event: repo"), 3000);
      ac.abort();
      const last = acc.split("\n\n").filter((f) => f.startsWith("event: repo")).at(-1)!;
      expect(JSON.parse(last.slice(last.indexOf("data: ") + 6)).commits[0].subject).toBe("chore: z");
    });
  });

  test("token canary: no response body or header, and no console line of this suite, carries the ETAPI token", async () => {
    const home = tempHome();
    placeTranscript(home, cwdSlug(repoDir), "s1", "k1");
    const { app, base } = boot(home);
    app.addRepo(repoDir);
    await Promise.all([...app.pollers.values()].map((p) => p.refresh()));
    const wrongRepo = tempRepo(DEMO, { url: fake.url, token: WRONG });
    const bad = boot();
    bad.app.addRepo(wrongRepo);
    await Promise.all([...bad.app.pollers.values()].map((p) => p.refresh()));
    // a placeholder repo and an env-token boot (FACTORY_ETAPI_TOKEN) answer without the token too
    const envBoot = boot("", {}, new AgentRegistry(), { FACTORY_TRILIUM_URL: fake.url, FACTORY_ETAPI_TOKEN: TOKEN });
    const envRepo = tempRepo(DEMO, { url: "http://127.0.0.1:9", token: "your-etapi-token" });
    envBoot.app.addRepo(envRepo);
    const seen: string[] = [];
    const check = async (label: string, res: Response, body?: string) => {
      const text = body ?? (await res.text());
      const all = `${label} ${res.status}\n${[...res.headers].map(([k, v]) => `${k}: ${v}`).join("\n")}\n${text}`;
      seen.push(`${label} ${res.status}`);
      expect(all).not.toContain(TOKEN);
      expect(all).not.toContain(WRONG);
    };
    for (const [b, repo] of [[base, repoDir], [bad.base, wrongRepo], [envBoot.base, envRepo]]) {
      const q = encodeURIComponent(repo);
      const slug = basename(repo);
      const listed: any = await (await fetch(`${b}/api/repos`)).json();
      expect(listed.repos.map((r: any) => Object.keys(r.trilium).sort())).toEqual([["baseUrl", "placeholder", "source"]]);
      for (const path of ["/api/health", "/api/repos", `/api/state?repo=${q}`, `/api/state?repo=${q}&ws=nope`, "/api/state?repo=nope", "/api/docs/d2", "/api/docs/r1",
        "/api/docs/proj1", "/api/tasks/t002", "/api/tasks/zzz", `/api/agents?repo=${q}`, "/api/agents?repo=nope", "/api/agents/k1/steps", "/api/agents/zz/steps",
        `/mockups/${slug}/demo/`, `/mockups/${slug}/demo/style.css`, `/mockups/${slug}/missing`, "/nope", "/api/stream?repo=nope"]) {
        await check(`GET ${path}`, await fetch(`${b}${path}`));
      }
      await check("PUT /api/health", await fetch(`${b}/api/health`, { method: "PUT" }));
      await check("GET evil host", await fetch(`${b}/api/health`, { headers: { Host: "evil.example" } }));
      await check("POST /api/repos", await postJson(`${b}/api/repos`, { path: repo }));
      await check("POST /api/repos 404", await postJson(`${b}/api/repos`, { path: "/nonexistent-xyz" }));
      await check("POST /api/repos 400", await postJson(`${b}/api/repos`, "{"));
      await check("POST /api/repos 415", await fetch(`${b}/api/repos`, { method: "POST", body: "{}" }));
      await check("POST /api/events start", await postJson(`${b}/api/events`, { event: "subagent-start", project: repo, payload: { agent_id: "k1", session_id: "s1", cwd: repo } }));
      await check("POST /api/events stop", await postJson(`${b}/api/events`, { event: "subagent-stop", project: repo, payload: { agent_id: "k1" } }));
      await check("POST /api/events 400", await postJson(`${b}/api/events`, {}));
      await check("POST /api/events 415", await fetch(`${b}/api/events`, { method: "POST", body: "{}" }));
      const ac = new AbortController();
      const sse = await fetch(`${b}/api/stream?repo=${q}`, { signal: ac.signal });
      const text = await readUntil(sse.body!.getReader(), (a) => a.includes(": connected"), 2000);
      ac.abort();
      await check("GET /api/stream", sse, text);
    }
    expect(seen.length).toBeGreaterThan(80);
    // the whole suite's console output (this test runs last)
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain(WRONG);
    }
  });
});
