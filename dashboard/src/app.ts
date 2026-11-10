import type { DashboardConfig } from "./config";
import type { EventHub } from "./hub";
import type { RepoEntry, RepoRegistry } from "./repos";
import type { LiveAgent } from "./shared/types";
import type { TriliumClient } from "./trilium/client";
import { Poller } from "./trilium/poller";
import { createApi } from "./routes/api";

export interface AppDeps {
  config: DashboardConfig;
  client: TriliumClient;
  repos: RepoRegistry;
  hub: EventHub;
  registry: { list(cwd?: string): { live: LiveAgent[]; recent: LiveAgent[] } };
  homeDir: string;
}

export interface App {
  fetch: (req: Request) => Promise<Response>;
  routes: Record<string, unknown>;
  pollers: Map<string, Poller>;
  addRepo(path: string): RepoEntry | null;
  stop(): void;
}

export function createApp(deps: AppDeps): App {
  const pollers = new Map<string, Poller>();

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
  }

  const api = createApi({ deps, pollers, addRepo });
  return { fetch: api.fetch, routes: {}, pollers, addRepo, stop };
}
