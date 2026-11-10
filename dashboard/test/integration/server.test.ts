import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/app";
import type { DashboardConfig } from "../../src/config";
import { EventHub } from "../../src/hub";
import { RepoRegistry } from "../../src/repos";
import { columnFor } from "../../src/shared/columns";
import type { WorkstreamSnapshot } from "../../src/shared/types";
import { TriliumClient } from "../../src/trilium/client";
import { loadFixtureNotes, startFakeEtapi } from "./fake-etapi";

const registry = { list: () => ({ live: [], recent: [] }) };
const cleanups: (() => void)[] = [];
let repoDir: string;

function boot(fake: { url: string }, token: string) {
  const config: DashboardConfig = { triliumUrl: fake.url, etapiToken: token, port: 0, pollMs: 60000, configDir: "", homeDir: "" };
  const app = createApp({ config, client: new TriliumClient({ baseUrl: fake.url, token }), repos: new RepoRegistry(), hub: new EventHub(), registry, homeDir: "" });
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
    expect(h.trilium.error).toContain("401");
    expect(JSON.stringify(h)).not.toContain("bad");
  });
});
