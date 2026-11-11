import { chmodSync, existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic";
import { PLACEHOLDER_TOKEN, triliumBaseUrl } from "./trilium-config";

export type SettingsResult = "written" | "unchanged" | "invalid" | "exists";

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const save = (file: string, doc: unknown, mode?: number) => writeFileAtomic(file, JSON.stringify(doc, null, 2) + "\n", { mode });

/** A missing file is `{}`; anything that is not a JSON object is null. */
function load(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return {};
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

/** Merges `pairs` into the file's `env`; `unchanged` (no write) when every value is already set. */
export function ensureEnv(file: string, pairs: Record<string, string>): SettingsResult {
  const doc = load(file);
  if (!doc || (doc.env !== undefined && !isObject(doc.env))) return "invalid";
  const env = (doc.env as Record<string, unknown> | undefined) ?? {};
  const changed = Object.entries(pairs).filter(([k, v]) => env[k] !== v);
  if (changed.length === 0 && doc.env !== undefined) return "unchanged";
  for (const [k, v] of changed) env[k] = v;
  doc.env = env;
  save(file, doc, 0o644);
  return "written";
}

/** Adds the http MCP server `name` (placeholder token, mode 0600); never overwrites an existing one. */
export function ensureMcpServer(file: string, name: string, url: string): SettingsResult {
  const doc = load(file);
  if (!doc || (doc.mcpServers !== undefined && !isObject(doc.mcpServers))) return "invalid";
  const servers = (doc.mcpServers as Record<string, unknown> | undefined) ?? {};
  if (servers[name] !== undefined) return "exists";
  servers[name] = {
    type: "http",
    url: `${triliumBaseUrl(url.trim().replace(/\/+$/, "").replace(/\/etapi$/, ""))}/mcp`,
    headers: { Authorization: `Bearer ${PLACEHOLDER_TOKEN}` },
  };
  doc.mcpServers = servers;
  save(file, doc, 0o600);
  chmodSync(file, 0o600);
  return "written";
}
