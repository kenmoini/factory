import type { HTMLBundle } from "bun";
import type { DashboardConfig } from "./config";
import type { EventHub } from "./hub";
import type { RepoEntry, RepoRegistry, TriliumCreds } from "./repos";
import type { AgentRegistry } from "./agents/registry";
import type { TranscriptTailer } from "./agents/tailer";
import type { HookEvent } from "./shared/types";
import { NOT_CONFIGURED, TOKEN_NOT_CONFIGURED, TriliumClient, TriliumConfigError } from "./trilium/client";
import { Poller } from "./trilium/poller";
import { createApi } from "./routes/api";
import { stopAgent } from "./routes/events";

/** Each repo gets its own Trilium client, from the credentials `repos` resolved for it (see clientFor). */
export interface AppDeps {
  config: DashboardConfig;
  repos: RepoRegistry;
  hub: EventHub;
  registry: AgentRegistry;
  homeDir: string;
  /** The fetch every Trilium client uses; default the global one (tests observe requests through it). */
  fetchImpl?: typeof fetch;
}

/** Paths that load the web app. Only these: a `/*` route would shadow `/api/*` and `/mockups/*`, which `fetch` handles. */
export const SPA_PATHS = ["/", "/kanban", "/docs", "/agents", "/mockups-tab"] as const;

/** A live agent whose transcript has not grown for this long (or that never had one) is considered gone. */
export const IDLE_MS = 30 * 60_000;

export interface App {
  /** Bun passes the server as the second argument; its port is the one the Host header must name. */
  fetch: (req: Request, server?: { port?: number }) => Promise<Response>;
  routes: Record<string, HTMLBundle>;
  pollers: Map<string, Poller>;
  tailers: Map<string, TranscriptTailer>;
  addRepo(path: string): RepoEntry | null;
  /** Stops idle live agents (see IDLE_MS); runs every `sweepMs`. */
  sweep(): void;
  stop(): void;
}

/**
 * Only the loopback names of the serving port: a page on another site that rebinds its DNS name to 127.0.0.1 still
 * sends its own name as Host, and is refused.
 */
function allowedHost(host: string | null, port: number | undefined): boolean {
  if (!host || !port) return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
}

export function createApp(
  deps: AppDeps,
  opts: { heartbeatMs?: number; html?: HTMLBundle; port?: number; now?: () => number; sweepMs?: number } = {},
): App {
  const pollers = new Map<string, Poller>();
  const tailers = new Map<string, TranscriptTailer>();
  const lastTask = new Map<string, HookEvent>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const clients = new Map<string, { creds: TriliumCreds; client: TriliumClient }>();
  const now = opts.now ?? Date.now;

  /**
   * The repo's Trilium client, cached until the registry re-reads different credentials (a new creds object). Throws
   * TriliumConfigError, before any request, when the repo has no Trilium configured or only a placeholder token.
   */
  function clientFor(repoKey: string): TriliumClient {
    const creds = deps.repos.credentials(repoKey);
    if (!creds) throw new TriliumConfigError(NOT_CONFIGURED);
    if (creds.placeholder) throw new TriliumConfigError(TOKEN_NOT_CONFIGURED);
    const hit = clients.get(repoKey);
    if (hit?.creds === creds) return hit.client;
    const client = new TriliumClient({ baseUrl: creds.baseUrl, token: creds.token, fetchImpl: deps.fetchImpl, tlsRejectUnauthorized: deps.config.tlsVerify });
    clients.set(repoKey, { creds, client });
    return client;
  }

  deps.registry.onEvict((id) => { tailers.get(id)?.stop(); tailers.delete(id); });

  function refresh(repoKey: string): void {
    if (timers.has(repoKey)) return;
    const t = setTimeout(() => {
      timers.delete(repoKey);
      pollers.get(repoKey)?.refresh().catch(() => {});
    }, 250);
    t.unref?.();
    timers.set(repoKey, t);
  }

  function addRepo(path: string): RepoEntry | null {
    const entry = deps.repos.register(path);
    if (!entry) return null;
    pollers.get(entry.repoPath)?.stop();
    const repoKey = entry.repoPath;
    const poller = new Poller(entry, {
      client: () => clientFor(repoKey),
      hub: deps.hub,
      live: () => deps.registry.list(entry.repoPath).live,
    }, { intervalMs: deps.config.pollMs });
    pollers.set(entry.repoPath, poller);
    poller.start();
    return entry;
  }

  /** Points the repo's poller at `slug` unless the user picked a workstream in the UI. */
  function followWorkstream(repoKey: string, slug: string): void {
    const poller = pollers.get(repoKey);
    if (!poller || poller.userSelected || poller.activeWorkstream() === slug) return;
    poller.selectWorkstream(slug).catch(() => {});
  }

  /**
   * Re-reads the repo's `.factory/config.json` and Trilium credentials when they changed; a new `activeWorkstream`
   * moves the poller (see followWorkstream), new credentials (e.g. the real token replacing the placeholder) refresh it.
   */
  function syncRepo(repoKey: string): void {
    const r = deps.repos.reload(repoKey);
    if (r?.triliumChanged) refresh(r.entry.repoPath);
    if (r?.activeChanged && r.entry.activeWorkstream) followWorkstream(r.entry.repoPath, r.entry.activeWorkstream);
  }

  function sweep(): void {
    const t = now();
    for (const a of deps.registry.list().live) {
      const last = Math.max(Date.parse(a.startedAt) || 0, tailers.get(a.agentId)?.lastGrowthAt ?? 0);
      if (t - last > IDLE_MS) stopAgent(a.agentId, { registry: deps.registry, hub: deps.hub, tailers });
    }
  }
  const sweeper = setInterval(sweep, opts.sweepMs ?? 60_000);
  sweeper.unref?.();

  function stop(): void {
    clearInterval(sweeper);
    for (const p of pollers.values()) p.stop();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    for (const t of tailers.values()) t.stop();
    tailers.clear();
  }

  const api = createApi({ deps, pollers, addRepo, clientFor, tailers, lastTask, refresh, syncRepo, followWorkstream, now, heartbeatMs: opts.heartbeatMs });

  // every route `fetch` serves (API, SSE, mockups, 404s); the SPA entry paths are static bundles served by Bun's `routes`
  async function fetch(req: Request, server?: { port?: number }): Promise<Response> {
    if (!allowedHost(req.headers.get("host"), server?.port ?? opts.port ?? deps.config.port)) {
      return Response.json({ error: "forbidden host" }, { status: 403 });
    }
    return api.fetch(req);
  }

  const html = opts.html;
  const routes: Record<string, HTMLBundle> = html ? Object.fromEntries(SPA_PATHS.map((p) => [p, html])) : {};
  return { fetch, routes, pollers, tailers, addRepo, sweep, stop };
}
