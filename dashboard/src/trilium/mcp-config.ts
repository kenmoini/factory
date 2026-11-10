// A repo's Trilium URL and ETAPI token, read from the Trilium MCP server registration Claude Code uses.
// Self-contained on purpose: the dashboard does not import the plugin's lib/.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** `project`: `<repo>/.mcp.json`; `user`: `~/.claude.json` (top-level `mcpServers`); `env`: FACTORY_TRILIUM_URL + FACTORY_ETAPI_TOKEN. */
export type TriliumSource = "project" | "user" | "env";
export interface TriliumMcp { baseUrl: string; token: string; placeholder: boolean; source: TriliumSource }
type Env = Record<string, string | undefined>;

/** The token the plugin's `.mcp.json` template carries until the user pastes a real one. */
export const PLACEHOLDER_TOKEN = "your-etapi-token";

/** An empty token or the template's placeholder: the server is registered, but not usable. */
export const isPlaceholderToken = (token: string): boolean => token.trim() === "" || token.trim() === PLACEHOLDER_TOKEN;

/**
 * `https://host/mcp/` → `https://host`: the ETAPI base is the MCP URL without its `/mcp` path. Only origin and path are
 * kept, so userinfo, query string and fragment (which may carry secrets) never reach `/api/repos`. "" when not http(s).
 */
function baseOf(url: string): string {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return ""; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  return (u.origin + u.pathname).replace(/\/+$/, "").replace(/\/mcp$/, "").replace(/\/+$/, "");
}

/** `${VAR}` and `${VAR:-default}`, expanded from `env` as Claude Code expands them in `.mcp.json`. */
const expand = (s: string, env: Env): string =>
  s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, def?: string) => env[name] || def || "");

/** The `trilium` server of one MCP config file; null when the file, the entry or its `url` is missing or unreadable. */
function fromFile(path: string, env: Env): { baseUrl: string; token: string } | null {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  const servers = raw && typeof raw === "object" ? (raw as { mcpServers?: unknown }).mcpServers : undefined;
  const s = servers && typeof servers === "object" ? (servers as Record<string, unknown>).trilium : undefined;
  if (!s || typeof s !== "object") return null;
  const { url, headers } = s as { url?: unknown; headers?: unknown };
  if (typeof url !== "string") return null; // a stdio server has no URL to derive ETAPI from
  const baseUrl = baseOf(expand(url, env));
  if (!baseUrl) return null;
  const auth = headers && typeof headers === "object"
    ? Object.entries(headers as Record<string, unknown>).find(([k]) => k.toLowerCase() === "authorization")?.[1]
    : undefined;
  const token = typeof auth === "string" ? expand(auth, env).trim().replace(/^Bearer(\s+|$)/i, "").trim() : "";
  return { baseUrl, token };
}

/**
 * The Trilium a repo's Claude Code sessions talk to: `<repoDir>/.mcp.json`, else `<homeDir>/.claude.json` (skipped when
 * `homeDir` is empty); FACTORY_TRILIUM_URL and FACTORY_ETAPI_TOKEN in `env` override the URL and the token each on its
 * own, and any override reports source "env" (as the plugin's lib/trilium-config.ts does). A project entry with a
 * placeholder token is returned as such (no fall-through: Claude Code uses it too).
 * null when no URL and token can be put together.
 */
export function readTriliumMcp(repoDir: string, env: Env, homeDir: string): TriliumMcp | null {
  const project = fromFile(join(repoDir, ".mcp.json"), env);
  const user = !project && homeDir ? fromFile(join(homeDir, ".claude.json"), env) : null;
  const found = project ? { ...project, source: "project" as const } : user ? { ...user, source: "user" as const } : null;
  const envUrl = env.FACTORY_TRILIUM_URL?.trim() || undefined;
  const envToken = env.FACTORY_ETAPI_TOKEN?.trim() || undefined;
  const baseUrl = envUrl ? baseOf(envUrl) : found?.baseUrl;
  const token = envToken ?? found?.token;
  if (!baseUrl || token === undefined) return null;
  const source: TriliumSource = envUrl || envToken ? "env" : found!.source;
  return { baseUrl, token, placeholder: isPlaceholderToken(token), source };
}
