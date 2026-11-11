import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AgentRegistry } from "./agents/registry";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { EventHub } from "./hub";
import { RepoRegistry } from "./repos";
import index from "../web/index.html";

const config = loadConfig();
// each repo's Trilium URL and token: its .mcp.json, else ~/.claude.json; env overrides; the global config as last fallback
const fallback = config.triliumUrl && config.etapiToken ? { baseUrl: config.triliumUrl, token: config.etapiToken } : undefined;
const repos = new RepoRegistry({ trilium: { env: process.env, homeDir: config.homeDir, fallback } });
const hub = new EventHub();
const registry = new AgentRegistry();

/** No session or browser uses the server any more: stop serving, drop the pidfile while it still names us, and exit. */
function exit(reason: string): void {
  console.log(`factory-dashboard: exiting (${reason})`);
  app.stop();
  server.stop(true);
  const pidFile = join(config.configDir, "dashboard.pid");
  try {
    if (readFileSync(pidFile, "utf8").trim() === String(process.pid)) rmSync(pidFile, { force: true });
  } catch { /* no pidfile: not started by the daemon */ }
  process.exit(0);
}

const app = createApp({ config, repos, hub, registry, homeDir: config.homeDir }, { html: index, onExit: exit });
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
