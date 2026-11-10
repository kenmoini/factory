import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Token setup writes into `.mcp.json`; the user replaces it by hand. */
export const PLACEHOLDER_TOKEN = "your-etapi-token";

export type TriliumMcp = {
  baseUrl: string;
  mcpUrl: string;
  token: string;
  placeholder: boolean;
  source: "project" | "user" | "env";
};

type Env = NodeJS.ProcessEnv | Record<string, string | undefined>;

/** Bun fetch `tls.rejectUnauthorized`: verification is off unless FACTORY_TLS_VERIFY=1. */
export function tlsRejectUnauthorized(env: Env = process.env): boolean {
  return env.FACTORY_TLS_VERIFY === "1";
}

/** `<base>/mcp`, `<base>/mcp/`, `<base>/` → `<base>`. */
export function triliumBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/mcp$/, "").replace(/\/+$/, "");
}

export function isPlaceholderToken(token: string): boolean {
  return token === "" || token === PLACEHOLDER_TOKEN;
}

/** `${VAR}` / `${VAR:-default}` expansion, as Claude Code applies it to `.mcp.json`. */
function expand(s: string, env: Env): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, dflt?: string) => env[name] || dflt || "");
}

function readServer(file: string, pick: (j: Record<string, unknown>) => unknown): Record<string, unknown> | null {
  try {
    if (!existsSync(file)) return null;
    const j: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (j === null || typeof j !== "object") return null;
    const s = pick(j as Record<string, unknown>);
    return s !== null && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function fromServer(s: Record<string, unknown> | null, source: "project" | "user", env: Env): TriliumMcp | null {
  if (!s || typeof s.url !== "string" || (s.type !== undefined && s.type !== "http")) return null;
  const baseUrl = triliumBaseUrl(expand(s.url, env));
  if (!baseUrl) return null;
  const headers = s.headers !== null && typeof s.headers === "object" ? (s.headers as Record<string, unknown>) : {};
  const key = Object.keys(headers).find((k) => k.toLowerCase() === "authorization");
  const raw = key && typeof headers[key] === "string" ? expand(headers[key] as string, env) : "";
  const token = raw.replace(/^Bearer(\s+|$)/i, "").trim();
  return { baseUrl, mcpUrl: `${baseUrl}/mcp`, token, placeholder: isPlaceholderToken(token), source };
}

const servers = (j: Record<string, unknown>) => (j.mcpServers as Record<string, unknown> | undefined)?.trilium;

/**
 * Trilium URL + ETAPI token of the `trilium` MCP server: `<repoDir>/.mcp.json` (project scope), else
 * `$HOME/.claude.json` top-level `mcpServers.trilium` (user scope). FACTORY_TRILIUM_URL / FACTORY_ETAPI_TOKEN
 * override either part (source "env"). Never logs.
 */
export function readTriliumMcp(repoDir: string, env: Env = process.env): TriliumMcp | null {
  const found =
    fromServer(readServer(join(repoDir, ".mcp.json"), servers), "project", env) ??
    (env.HOME ? fromServer(readServer(join(env.HOME, ".claude.json"), servers), "user", env) : null);
  const envUrl = env.FACTORY_TRILIUM_URL;
  const envToken = env.FACTORY_ETAPI_TOKEN;
  if (!envUrl && !envToken) return found;
  const baseUrl = envUrl ? triliumBaseUrl(envUrl) : found?.baseUrl;
  if (!baseUrl) return null;
  const token = envToken || found?.token || "";
  return { baseUrl, mcpUrl: `${baseUrl}/mcp`, token, placeholder: isPlaceholderToken(token), source: "env" };
}
