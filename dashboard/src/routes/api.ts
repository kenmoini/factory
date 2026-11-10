import type { AppDeps } from "../app";
import type { RepoEntry } from "../repos";
import type { Poller } from "../trilium/poller";
import { TriliumError, type EtapiNote } from "../trilium/client";
import { labelsOf } from "../trilium/mapper";
import type { TranscriptTailer } from "../agents/tailer";
import type { HookEvent } from "../shared/types";
import { handleEvent } from "./events";
import { streamRoute } from "./stream";

interface Ctx {
  deps: AppDeps; pollers: Map<string, Poller>; addRepo(path: string): RepoEntry | null;
  tailers: Map<string, TranscriptTailer>; lastTask: Map<string, HookEvent>; refresh(repoKey: string): void;
  heartbeatMs?: number;
}
type Handler = (req: Request, url: URL, params: string[]) => Promise<Response> | Response;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers });
const formatOf = (n: Pick<EtapiNote, "type" | "mime">): "html" | "markdown" =>
  n.type === "text" ? "html" : (n.mime ?? "").includes("markdown") ? "markdown" : "html";

export function createApi(ctx: Ctx) {
  const { deps, pollers } = ctx;
  const startedAt = Date.now();
  let lastLogged = "";

  const withWorkstreams = (e: RepoEntry) => ({ ...e, workstreams: Object.entries(e.workstreams).map(([slug, w]) => ({ slug, noteId: w.noteId })) });

  function resolveRepo(key: string | null): RepoEntry | undefined {
    if (!key) return undefined;
    return deps.repos.get(key) ?? deps.repos.bySlug(key);
  }

  const health: Handler = () => {
    let raw: string | undefined;
    for (const p of pollers.values()) { raw = p.lastError() ?? undefined; if (raw) break; }
    const trilium: { ok: boolean; url: string; error?: string } = { ok: !raw, url: deps.config.triliumUrl };
    if (raw) {
      if (raw !== lastLogged) { lastLogged = raw; console.error(`factory-dashboard: trilium poll error: ${raw}`); }
      const status = raw.match(/-> (\d{3})/)?.[1];
      trilium.error = status ? `trilium returned ${status}` : "trilium unreachable";
    } else if (pollers.size > 0 && [...pollers.values()].every((p) => !p.snapshot())) {
      // registered repos but nothing fetched yet; with no repos at all ok:true is acceptable (nothing to poll)
      trilium.ok = false;
      trilium.error = "no poller has refreshed yet";
    }
    return json({ ok: true, pid: process.pid, uptimeSec: Math.round((Date.now() - startedAt) / 1000), version: "0.1.0", trilium, repos: deps.repos.list().map((r) => r.repoPath) });
  };

  const listRepos: Handler = () => json({ repos: deps.repos.list().map(withWorkstreams) });

  const addRepoRoute: Handler = async (req) => {
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
    const ws = url.searchParams.get("ws");
    if (ws && ws !== poller.snapshot()?.workstream?.slug) await poller.selectWorkstream(ws);
    else if (!poller.snapshot()) await poller.refresh();
    const snap = poller.snapshot();
    const err = poller.lastError();
    if (err) console.error(`factory-dashboard: poll error: ${err}`);
    if (ws && snap && snap.workstream?.slug !== ws) return json({ error: "unknown workstream" }, 404);
    return snap ? json(snap) : json({ error: "no snapshot yet" }, 503);
  };

  function findDoc(id: string) {
    for (const p of pollers.values()) {
      const d = p.snapshot()?.docs.find((x) => x.id === id);
      if (d) return d;
    }
    return undefined;
  }

  const doc: Handler = async (req, _url, [id]) => {
    let title = "", format: "html" | "markdown", modified: string;
    const known = findDoc(id);
    try {
      if (known) ({ title, format, modified } = known);
      else {
        const n = await deps.client.getNote(id);
        ({ title } = n); format = formatOf(n); modified = n.utcDateModified;
      }
      const etag = `"${modified}"`;
      if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
      const { content } = await deps.client.getContent(id);
      return json({ noteId: id, title, format, content, modified }, 200, { ETag: etag });
    } catch (e) {
      return upstreamError(e);
    }
  };

  function upstreamError(e: unknown): Response {
    if (e instanceof TriliumError && e.status === 404) return json({ error: "not found" }, 404);
    console.error(`factory-dashboard: upstream error: ${e instanceof Error ? e.message : String(e)}`);
    return json({ error: "upstream error", status: e instanceof TriliumError ? e.status : undefined }, 502);
  }

  const task: Handler = async (_req, _url, [id]) => {
    let snap = null as ReturnType<Poller["snapshot"]>;
    let found;
    for (const p of pollers.values()) {
      snap = p.snapshot();
      found = snap?.tasks.find((t) => t.id === id);
      if (found) break;
    }
    if (!snap || !found) return json({ error: "not found" }, 404);
    const out: { task: typeof found; spec?: { content: string; format: "html" | "markdown" }; reviews: unknown[]; approval?: { content: string }; runs: unknown[] } = {
      task: found,
      reviews: snap.reviews.filter((r) => r.taskId === found.taskId),
      runs: snap.runs.filter((r) => r.taskId === found.taskId),
    };
    try {
      const note = await deps.client.getNote(id);
      const kids = await Promise.all(note.childNoteIds.slice(0, 20).map((c) => deps.client.getNote(c)));
      for (const k of kids) {
        const kind = labelsOf(k).factoryDoc;
        if (kind === "task-spec" && !out.spec) out.spec = { content: (await deps.client.getContent(k.noteId)).content, format: formatOf(k) };
        else if (kind === "approval" && !out.approval) out.approval = { content: (await deps.client.getContent(k.noteId)).content };
      }
    } catch (e) {
      return upstreamError(e);
    }
    return json(out);
  };

  const events: Handler = async (req) => {
    let body: unknown;
    try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
    return handleEvent(body, {
      repos: deps.repos, registry: deps.registry, hub: deps.hub, tailers: ctx.tailers,
      homeDir: deps.homeDir, addRepo: ctx.addRepo, refresh: ctx.refresh, lastTask: ctx.lastTask,
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

  const stream: Handler = (req) => streamRoute(req, {
    hub: deps.hub, repos: deps.repos, heartbeatMs: ctx.heartbeatMs,
    snapshot: (k) => pollers.get(k)?.snapshot() ?? null,
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
