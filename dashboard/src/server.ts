import { AgentRegistry } from "./agents/registry";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { EventHub } from "./hub";
import { RepoRegistry } from "./repos";
import { TriliumClient } from "./trilium/client";

const config = loadConfig();
const client = new TriliumClient({ baseUrl: config.triliumUrl, token: config.etapiToken });
const repos = new RepoRegistry();
const hub = new EventHub();
const registry = new AgentRegistry();

const app = createApp({ config, client, repos, hub, registry, homeDir: config.homeDir });
for (const p of (process.env.FACTORY_REPOS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
  if (!app.addRepo(p)) console.warn(`factory-dashboard: no .factory/config.json in ${p}`);
}

const server = Bun.serve({ hostname: "127.0.0.1", port: config.port, fetch: app.fetch });
console.log(`factory-dashboard listening on http://127.0.0.1:${server.port}`);
