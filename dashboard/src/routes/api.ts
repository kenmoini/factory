import type { AppDeps } from "../app";
import type { RepoEntry } from "../repos";
import type { Poller } from "../trilium/poller";
import type { GitPoller } from "../git/poller";
import { GitError, type GitReader } from "../git/reader";
import { NOT_CONFIGURED, TOKEN_NOT_CONFIGURED, TriliumConfigError, TriliumError, type EtapiNote, type TriliumClient } from "../trilium/client";
import { labelsOf } from "../trilium/mapper";
import type { TranscriptTailer } from "../agents/tailer";
import { runInWorkstream } from "../shared/agents";
import type { CommitDetail, HookEvent, RepoSnapshot, TaskDetail, WorkstreamSnapshot } from "../shared/types";
import { handleEvent } from "./events";
import { mockupsRoute } from "./mockups";
import { streamRoute } from "./stream";

interface Ctx {
  deps: AppDeps; pollers: Map<string, Poller>; gitPollers: Map<string, GitPoller>; addRepo(path: string): RepoEntry | null;
  /** The repo's Trilium client; throws TriliumConfigError when the repo has none (see createApp). */
  clientFor(repoKey: string): TriliumClient;
  tailers: Map<string, TranscriptTailer>; lastTask: Map<string, HookEvent>; refresh(repoKey: string): void;
  refreshGit(repoKey: string): void;
  /** The repo's git reader, one per repo path. */
  gitReader(repoKey: string): GitReader;
  syncRepo(repoKey: string): void; followWorkstream(repoKey: string, slug: string): void; now?: () => number;
  heartbeatMs?: number;
}
/** What `/api/docs/:id` needs to answer before fetching the body: title and format are fetched when unknown (reviews). */
type DocMeta = { title?: string; format?: "html" | "markdown"; modified: string };
/** The repo's Trilium cannot be asked: no server configured, or a placeholder token. Shown as is, never as "unreachable". */
const configErrors = new Set<string>([NOT_CONFIGURED, TOKEN_NOT_CONFIGURED]);
const triliumProblem = (e: RepoEntry): string | undefined => (!e.trilium ? NOT_CONFIGURED : e.trilium.placeholder ? TOKEN_NOT_CONFIGURED : undefined);
type Handler = (req: Request, url: URL, params: string[]) => Promise<Response> | Response;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers });
const formatOf = (n: Pick<EtapiNote, "type" | "mime">): "html" | "markdown" =>
  n.type === "text" ? "html" : (n.mime ?? "").includes("markdown") ? "markdown" : "html";
/**
 * POSTs must say `application/json`: a cross-site page can send text/plain, form or multipart bodies without asking,
 * but `application/json` needs a CORS preflight this server never grants.
 */
const isJson = (req: Request) => (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() === "application/json";
const unsupported = () => json({ error: "content type must be application/json" }, 415);

export function createApi(ctx: Ctx) {
  const { deps, pollers, gitPollers, gitReader } = ctx;

  const startedAt = Date.now();
  let lastLogged = "";

  const withWorkstreams = (e: RepoEntry) => ({
    ...e,
    workstreams: Object.entries(e.workstreams).map(([slug, w]) => (w.noteId ? { slug, noteId: w.noteId } : { slug })),
  });

  function resolveRepo(key: string | null): RepoEntry | undefined {
    if (!key) return undefined;
    return deps.repos.get(key) ?? deps.repos.bySlug(key);
  }

  const health: Handler = () => {
    let raw: string | undefined;
    for (const p of pollers.values()) { raw = p.lastError() ?? undefined; if (raw) break; }
    const trilium: { ok: boolean; error?: string } = { ok: !raw };
    if (raw) {
      if (raw !== lastLogged) { lastLogged = raw; console.error(`factory-dashboard: trilium poll error: ${raw}`); }
      const status = raw.match(/-> (\d{3})/)?.[1];
      trilium.error = configErrors.has(raw) ? raw : status ? `trilium returned ${status}` : "trilium unreachable";
    } else if (pollers.size > 0 && [...pollers.values()].every((p) => !p.snapshot())) {
      // registered repos but nothing fetched yet; with no repos at all ok:true is acceptable (nothing to poll)
      trilium.ok = false;
      trilium.error = "no poller has refreshed yet";
    }
    return json({ ok: true, pid: process.pid, uptimeSec: Math.round((Date.now() - startedAt) / 1000), version: "0.1.0", trilium, repos: deps.repos.list().map((r) => r.repoPath) });
  };

  const listRepos: Handler = () => {
    for (const r of deps.repos.list()) ctx.syncRepo(r.repoPath);
    return json({ repos: deps.repos.list().map(withWorkstreams) });
  };

  const addRepoRoute: Handler = async (req) => {
    if (!isJson(req)) return unsupported();
    let path: unknown;
    try { path = ((await req.json()) as { path?: unknown })?.path; } catch { return json({ error: "invalid JSON body" }, 400); }
    if (typeof path !== "string" || !path) return json({ error: "path required" }, 400);
    const entry = ctx.addRepo(path);
    return entry ? json(withWorkstreams(entry), 201) : json({ error: "no .factory/config.json" }, 404);
  };

  const state: Handler = async (_req, url) => {
    const entry = resolveRepo(url.searchParams.get("repo"));
    const poller = entry && pollers.get(entry.repoPath);
    if (!entry || !poller) return json({ error: "unknown repo" }, 404);
    const problem = triliumProblem(entry);
    if (problem) return json({ error: problem }, 503);
    const ws = url.searchParams.get("ws");
    if (ws && ws !== poller.snapshot()?.workstream?.slug) await poller.selectWorkstream(ws, { user: true });
    else if (!poller.snapshot()) await poller.refresh();
    const snap = poller.snapshot();
    const err = poller.lastError();
    if (err) console.error(`factory-dashboard: poll error: ${err}`);
    if (ws && snap && snap.workstream?.slug !== ws) return json({ error: "unknown workstream" }, 404);
    return snap ? json(snap) : json({ error: "no snapshot yet" }, 503);
  };

  /** `repoKey`: the repo whose board shows the task; its Trilium client fetches the task's notes. */
  function findTask(noteId: string): { repoKey: string; snap: WorkstreamSnapshot; task: WorkstreamSnapshot["tasks"][number] } | undefined {
    for (const [repoKey, p] of pollers) {
      const snap = p.snapshot();
      const task = snap?.tasks.find((t) => t.id === noteId);
      if (snap && task) return { repoKey, snap, task };
    }
    return undefined;
  }

  /** The spec and approval notes `/api/tasks/:id` last returned, per task note id: readable through `/api/docs` while the task is on a board. */
  const taskDocs = new Map<string, Map<string, DocMeta>>();

  /**
   * `/api/docs/:id` serves only notes the factory shows: a snapshot's docs (validation rounds included) and reviews,
   * and the spec/approval of a task on a board. Anything else in Trilium is a 404, so the endpoint is not a read proxy.
   */
  function scopedDoc(id: string): { meta: DocMeta; repoKey: string } | undefined {
    for (const [repoKey, p] of pollers) {
      const snap = p.snapshot();
      const d = snap?.docs.find((x) => x.id === id);
      if (d) return { meta: d, repoKey };
      const r = snap?.reviews.find((x) => x.id === id);
      if (r) return { meta: { modified: r.modified }, repoKey };
    }
    for (const [taskNoteId, docs] of taskDocs) {
      const d = docs.get(id);
      const hit = d && findTask(taskNoteId);
      if (d && hit) return { meta: d, repoKey: hit.repoKey };
    }
    return undefined;
  }

  const doc: Handler = async (req, _url, [id]) => {
    const known = scopedDoc(id);
    if (!known) return json({ error: "not found" }, 404);
    let { title, format } = known.meta;
    const { modified } = known.meta;
    try {
      const etag = `"${modified}"`;
      if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
      const client = ctx.clientFor(known.repoKey);
      if (title === undefined || format === undefined) {
        const n = await client.getNote(id);
        title = n.title;
        format = formatOf(n);
      }
      const { content } = await client.getContent(id);
      return json({ noteId: id, title, format, content, modified }, 200, { ETag: etag });
    } catch (e) {
      return upstreamError(e);
    }
  };

  function upstreamError(e: unknown): Response {
    if (e instanceof TriliumConfigError) return json({ error: e.message }, 503);
    if (e instanceof TriliumError && e.status === 404) return json({ error: "not found" }, 404);
    console.error(`factory-dashboard: upstream error: ${e instanceof Error ? e.message : String(e)}`);
    return json({ error: "upstream error", status: e instanceof TriliumError ? e.status : undefined }, 502);
  }

  /** `#round` as a number; a missing or malformed one ranks below every real round. */
  const roundOf = (n: EtapiNote) => {
    const r = parseInt(labelsOf(n).round ?? "", 10);
    return Number.isNaN(r) ? -1 : r;
  };

  const task: Handler = async (_req, _url, [id]) => {
    const hit = findTask(id);
    if (!hit) return json({ error: "not found" }, 404);
    const { repoKey, snap, task: found } = hit;
    const out: TaskDetail = {
      task: found,
      reviews: snap.reviews.filter((r) => r.taskId === found.taskId),
      runs: snap.runs.filter((r) => r.taskId === found.taskId && runInWorkstream(r, snap.workstream?.slug)),
    };
    try {
      const client = ctx.clientFor(repoKey);
      // the task's direct #factoryDoc children, however many runs and reviews sit beside them
      const kids = await client.search("#factoryDoc", { ancestorNoteId: id, ancestorDepth: "eq1" });
      const spec = kids.find((k) => labelsOf(k).factoryDoc === "task-spec");
      const approval = kids
        .filter((k) => labelsOf(k).factoryDoc === "approval")
        .sort((a, b) => roundOf(b) - roundOf(a) || b.utcDateModified.localeCompare(a.utcDateModified))[0];
      const scoped = new Map<string, DocMeta>();
      if (spec) {
        out.spec = { content: (await client.getContent(spec.noteId)).content, format: formatOf(spec) };
        scoped.set(spec.noteId, { title: spec.title, format: formatOf(spec), modified: spec.utcDateModified });
      }
      if (approval) {
        out.approval = { content: (await client.getContent(approval.noteId)).content };
        scoped.set(approval.noteId, { title: approval.title, format: formatOf(approval), modified: approval.utcDateModified });
      }
      taskDocs.set(id, scoped);
    } catch (e) {
      return upstreamError(e);
    }
    return json(out);
  };

  const events: Handler = async (req) => {
    if (!isJson(req)) return unsupported();
    let body: unknown;
    try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
    return handleEvent(body, {
      repos: deps.repos, registry: deps.registry, hub: deps.hub, tailers: ctx.tailers,
      homeDir: deps.homeDir, addRepo: ctx.addRepo, refresh: ctx.refresh, refreshGit: ctx.refreshGit, lastTask: ctx.lastTask,
      syncRepo: ctx.syncRepo, followWorkstream: ctx.followWorkstream, now: ctx.now,
    });
  };

  const agents: Handler = (_req, url) => {
    const param = url.searchParams.get("repo");
    const entry = resolveRepo(param);
    if (param && !entry) return json({ error: "unknown repo" }, 404);
    const out: { live: unknown[]; recent: unknown[]; lastTaskEvent?: HookEvent } = deps.registry.list(entry?.repoPath);
    const last = entry && ctx.lastTask.get(entry.repoPath);
    if (last) out.lastTaskEvent = last;
    return json(out);
  };

  const agentSteps: Handler = (_req, url, [id]) => {
    const agent = deps.registry.get(id);
    if (!agent) return json({ error: "unknown agent" }, 404);
    const after = Number(url.searchParams.get("after") ?? -1);
    const steps = (ctx.tailers.get(id)?.readAll() ?? []).filter((s) => s.seq > (Number.isFinite(after) ? after : -1));
    return json({ steps, finished: !!agent.finishedAt });
  };

  const repoSnapshot: Handler = async (_req, url) => {
    const entry = resolveRepo(url.searchParams.get("repo"));
    const repoKey = entry?.repoPath;
    const poller = repoKey ? gitPollers.get(repoKey) : undefined;
    if (!entry || !repoKey || !poller) return json({ error: "unknown repo" }, 404);
    let limit = 100;
    const rawLimit = url.searchParams.get("limit");
    if (rawLimit !== null) {
      limit = Number(rawLimit);
      if (rawLimit.trim() === "" || !Number.isInteger(limit) || limit < 1 || limit > 500) return json({ error: "limit must be 1-500" }, 400);
    }
    const branch = url.searchParams.get("branch") || undefined;
    if (!poller.snapshot()) await poller.refresh();
    if (branch && !poller.snapshot()?.branches.some((b) => b.name === branch)) return json({ error: "unknown branch" }, 400);
    if (limit === 100 && !branch) {
      const snap: RepoSnapshot = poller.snapshot() ?? {
        repoPath: repoKey, defaultBranch: "main", branches: [], commits: [], limit: 100, truncated: false, fingerprint: "",
        error: poller.lastError() ?? "no snapshot yet",
      };
      return json(snap);
    }
    return json(await gitReader(repoKey).snapshot({ limit, branch }));
  };

  const repoCommit: Handler = async (_req, url, [sha]) => {
    const entry = resolveRepo(url.searchParams.get("repo"));
    if (!entry || !gitPollers.has(entry.repoPath)) return json({ error: "unknown repo" }, 404);
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return json({ error: "invalid sha" }, 400);
    let detail: CommitDetail | null;
    try { detail = await gitReader(entry.repoPath).detail(sha); } catch (e) {
      if (!(e instanceof GitError)) throw e;
      console.error(`factory-dashboard: git failed (exit ${e.code})`); // never e.message: it is git's stderr
      return json({ error: "git failed" }, 500);
    }
    return detail ? json(detail) : json({ error: "unknown commit" }, 404);
  };

  const stream: Handler = (req) => streamRoute(req, {
    hub: deps.hub, repos: deps.repos, heartbeatMs: ctx.heartbeatMs,
    snapshot: (k) => pollers.get(k)?.snapshot() ?? null,
    repo: (k) => gitPollers.get(k)?.snapshot() ?? null,
    live: (k) => deps.registry.list(k).live,
  });

  const routes: { method: string; re: RegExp; handler: Handler }[] = [
    { method: "GET", re: /^\/api\/health$/, handler: health },
    { method: "GET", re: /^\/api\/repos$/, handler: listRepos },
    { method: "POST", re: /^\/api\/repos$/, handler: addRepoRoute },
    { method: "GET", re: /^\/api\/state$/, handler: state },
    { method: "GET", re: /^\/api\/docs\/([^/]+)$/, handler: doc },
    { method: "POST", re: /^\/api\/events$/, handler: events },
    { method: "GET", re: /^\/api\/agents$/, handler: agents },
    { method: "GET", re: /^\/api\/agents\/([^/]+)\/steps$/, handler: agentSteps },
    { method: "GET", re: /^\/api\/repo$/, handler: repoSnapshot },
    { method: "GET", re: /^\/api\/repo\/commits\/([^/]+)$/, handler: repoCommit },
    { method: "GET", re: /^\/api\/stream$/, handler: stream },
    { method: "GET", re: /^\/api\/tasks\/([^/]+)$/, handler: task },
  ];

  function match(method: string, pathname: string): { handler: Handler; params: string[] } | "method" | null {
    let pathHit = false;
    for (const r of routes) {
      const m = pathname.match(r.re);
      if (!m) continue;
      pathHit = true;
      if (r.method === method) return { handler: r.handler, params: m.slice(1).map(decodeURIComponent) };
    }
    return pathHit ? "method" : null;
  }

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/mockups/")) {
      try {
        return await mockupsRoute(req, { repos: deps.repos });
      } catch (e) {
        console.error(`factory-dashboard: mockups error: ${e instanceof Error ? e.message : String(e)}`);
        return new Response("Internal error", { status: 500 });
      }
    }
    const m = match(req.method, url.pathname);
    if (m === "method") return json({ error: "method not allowed" }, 405);
    if (!m) return json({ error: "not found" }, 404);
    try {
      return await m.handler(req, url, m.params);
    } catch (e) {
      console.error(`factory-dashboard: internal error: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      return json({ error: "internal error" }, 500);
    }
  }

  return { fetch, match };
}
