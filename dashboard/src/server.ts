import { AgentRegistry } from "./agents/registry";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { EventHub } from "./hub";
import { RepoRegistry } from "./repos";
import { TriliumClient } from "./trilium/client";
import index from "../web/index.html";

const config = loadConfig();
const client = new TriliumClient({ baseUrl: config.triliumUrl, token: config.etapiToken });
const repos = new RepoRegistry();
const hub = new EventHub();
const registry = new AgentRegistry();

const app = createApp({ config, client, repos, hub, registry, homeDir: config.homeDir }, { html: index });
for (const p of (process.env.FACTORY_REPOS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
  if (!app.addRepo(p)) console.warn(`factory-dashboard: no .factory/config.json in ${p}`);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: config.port,
  routes: app.routes, // the web app's entry paths; Bun bundles web/index.html (HMR when FACTORY_DEV=1)
  fetch: app.fetch, // /api/* and everything else
  development: process.env.FACTORY_DEV === "1",
  idleTimeout: 60, // Bun's 10 s default would cut SSE connections before the 15 s heartbeat
});
console.log(`factory-dashboard listening on http://127.0.0.1:${server.port}`);
