import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DashboardConfig { triliumUrl: string; etapiToken: string; port: number; pollMs: number; configDir: string; homeDir: string }

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DashboardConfig {
  const homeDir = env.HOME ?? "";
  const configDir = env.FACTORY_CONFIG_DIR ?? `${homeDir}/.config/claude-factory`;
  let file: { triliumUrl?: string; etapiToken?: string; dashboardPort?: number } = {};
  const p = join(configDir, "config.json");
  if (existsSync(p)) {
    try { file = JSON.parse(readFileSync(p, "utf8")) ?? {}; } catch { file = {}; }
  }
  const url = env.FACTORY_TRILIUM_URL || file.triliumUrl;
  const token = env.FACTORY_ETAPI_TOKEN || file.etapiToken;
  if (!url || !token) throw new Error("no config");
  const num = (v: unknown, d: number): number => {
    const n = Number(v);
    return v !== undefined && v !== "" && Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    triliumUrl: url.replace(/\/+$/, ""),
    etapiToken: token,
    port: num(env.FACTORY_DASHBOARD_PORT ?? file.dashboardPort, 7777),
    pollMs: num(env.FACTORY_POLL_MS, 3000),
    configDir,
    homeDir,
  };
}
