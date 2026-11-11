import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Trilium credentials are per repo (its `.mcp.json`, see trilium/mcp-config.ts). `triliumUrl` / `etapiToken` are only
 * a global fallback for repos without one: FACTORY_TRILIUM_URL / FACTORY_ETAPI_TOKEN, or legacy `config.json` keys.
 * `tlsVerify`: FACTORY_TLS_VERIFY=1; off by default, so a self-signed Trilium certificate is accepted.
 * Lifecycle (see sessions.ts): `graceMs` (FACTORY_GRACE_MS) after the last session ends or browser closes, or
 * `sessionIdleMs` (FACTORY_SESSION_IDLE_MS) of silence, the server exits; FACTORY_AUTO_EXIT=0 keeps it running.
 */
export interface DashboardConfig {
  port: number; pollMs: number; gitPollMs: number; configDir: string; homeDir: string; tlsVerify: boolean;
  graceMs: number; sessionIdleMs: number; autoExit: boolean; triliumUrl?: string; etapiToken?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DashboardConfig {
  const homeDir = env.HOME ?? "";
  const configDir = env.FACTORY_CONFIG_DIR ?? `${homeDir}/.config/claude-factory`;
  let file: { triliumUrl?: unknown; etapiToken?: unknown; dashboardPort?: number } = {};
  const p = join(configDir, "config.json");
  if (existsSync(p)) {
    try { file = JSON.parse(readFileSync(p, "utf8")) ?? {}; } catch { file = {}; }
  }
  const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
  const url = str(env.FACTORY_TRILIUM_URL) ?? str(file.triliumUrl);
  const token = str(env.FACTORY_ETAPI_TOKEN) ?? str(file.etapiToken);
  const num = (v: unknown, d: number): number => {
    const n = Number(v);
    return v !== undefined && v !== "" && Number.isFinite(n) && n > 0 ? n : d;
  };
  const config: DashboardConfig = {
    port: num(env.FACTORY_DASHBOARD_PORT ?? file.dashboardPort, 7777),
    pollMs: num(env.FACTORY_POLL_MS, 3000),
    gitPollMs: num(env.FACTORY_GIT_POLL_MS, 5000),
    configDir,
    homeDir,
    tlsVerify: env.FACTORY_TLS_VERIFY === "1",
    graceMs: num(env.FACTORY_GRACE_MS, 60_000),
    sessionIdleMs: num(env.FACTORY_SESSION_IDLE_MS, 7_200_000),
    autoExit: env.FACTORY_AUTO_EXIT !== "0",
  };
  if (url) config.triliumUrl = url.replace(/\/+$/, "");
  if (token) config.etapiToken = token;
  return config;
}
