import type { DashboardConfig } from "./config";
import type { EventHub } from "./hub";
import type { RepoEntry, RepoRegistry } from "./repos";
import type { AgentRegistry } from "./agents/registry";
import type { TranscriptTailer } from "./agents/tailer";
import type { HookEvent } from "./shared/types";
import type { TriliumClient } from "./trilium/client";
import { Poller } from "./trilium/poller";
import { createApi } from "./routes/api";

export interface AppDeps {
  config: DashboardConfig;
  client: TriliumClient;
  repos: RepoRegistry;
  hub: EventHub;
  registry: AgentRegistry;
  homeDir: string;
}

export interface App {
  fetch: (req: Request) => Promise<Response>;
  routes: Record<string, unknown>;
  pollers: Map<string, Poller>;
  tailers: Map<string, TranscriptTailer>;
  addRepo(path: string): RepoEntry | null;
  stop(): void;
}

export function createApp(deps: AppDeps, opts: { heartbeatMs?: number } = {}): App {
  const pollers = new Map<string, Poller>();
  const tailers = new Map<string, TranscriptTailer>();
  const lastTask = new Map<string, HookEvent>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

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
    const poller = new Poller(entry, {
      client: deps.client,
      hub: deps.hub,
      live: () => deps.registry.list(entry.repoPath).live,
    }, { intervalMs: deps.config.pollMs });
    pollers.set(entry.repoPath, poller);
    poller.start();
    return entry;
  }

  function stop(): void {
    for (const p of pollers.values()) p.stop();
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    for (const t of tailers.values()) t.stop();
    tailers.clear();
  }

  const api = createApi({ deps, pollers, addRepo, tailers, lastTask, refresh, heartbeatMs: opts.heartbeatMs });
  return { fetch: api.fetch, routes: {}, pollers, tailers, addRepo, stop };
}
