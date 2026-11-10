import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PLACEHOLDER_TOKEN, triliumBaseUrl } from "./trilium-config";

/** The global config holds no Trilium credentials (they live in the project `.mcp.json`). */
export type GlobalConfig = { dashboardPort: number; tlsVerify?: boolean };
export type WorkstreamEntry = { noteId?: string; branch: string; worktree: string };
export type RepoConfig = { projectNoteId?: string; activeWorkstream?: string; workstreams: Record<string, WorkstreamEntry> };

export const DEFAULT_PORT = 7777;

export function globalConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.FACTORY_CONFIG_DIR ?? `${env.HOME}/.config/claude-factory`;
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(globalConfigDir(env), "config.json");
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Returns the file as stored: a legacy file may still carry `triliumUrl` / `etapiToken`. */
export function readGlobalConfig(env: NodeJS.ProcessEnv = process.env): GlobalConfig | null {
  return readJson<GlobalConfig>(globalConfigPath(env));
}

export const LEGACY_TRILIUM_KEYS = ["triliumUrl", "etapiToken"] as const;

export function hasLegacyTriliumKeys(cfg: unknown): boolean {
  return cfg !== null && typeof cfg === "object" && LEGACY_TRILIUM_KEYS.some((k) => k in (cfg as object));
}

export function writeGlobalConfig(cfg: GlobalConfig, env: NodeJS.ProcessEnv = process.env): string {
  const path = globalConfigPath(env);
  writeJson(path, cfg);
  return path;
}

export function repoConfigPath(repoDir: string): string {
  return join(repoDir, ".factory", "config.json");
}

export function readRepoConfig(repoDir: string): RepoConfig | null {
  return readJson<RepoConfig>(repoConfigPath(repoDir));
}

export function writeRepoConfig(repoDir: string, cfg: RepoConfig): string {
  const path = repoConfigPath(repoDir);
  writeJson(path, cfg);
  return path;
}

export function getPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (cur === null || typeof cur !== "object" || !(part in (cur as object))) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    const next = cur[part];
    if (next === null || typeof next !== "object") cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Appends `entry` as its own line to `<repoDir>/.gitignore` unless present; true when added. */
export function ensureGitignoreEntry(repoDir: string, entry: string): boolean {
  const file = join(repoDir, ".gitignore");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (text.split(/\r?\n/).includes(entry)) return false;
  appendFileSync(file, (text && !text.endsWith("\n") ? "\n" : "") + entry + "\n");
  return true;
}

export type MigrateResult = { migrated: false; error?: string } | { migrated: true; mcpJson: string; kept?: true };

function isTrackedByGit(repoDir: string, rel: string): boolean {
  try {
    const p = Bun.spawnSync(["git", "-C", repoDir, "ls-files", "--error-unmatch", "--", rel], { stdout: "ignore", stderr: "ignore" });
    return p.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Moves legacy `triliumUrl` / `etapiToken` from the global config into `<repoDir>/.mcp.json`
 * (`mcpServers.trilium`, merged, mode 0600), gitignores `.mcp.json`, then deletes the two keys from the
 * global file. An existing `trilium` entry with a real token is kept. The result never contains the token.
 */
export function migrateTrilium(repoDir: string, env: NodeJS.ProcessEnv = process.env): { code: number; result: MigrateResult } {
  const fail = (error: string) => ({ code: 1, result: { migrated: false as const, error } });
  const gPath = globalConfigPath(env);
  const g = readJson<Record<string, unknown>>(gPath);
  if (!isObject(g) || !hasLegacyTriliumKeys(g)) return { code: 0, result: { migrated: false } };
  try {
    if (!statSync(repoDir).isDirectory()) return fail("--repo is not a directory");
  } catch {
    return fail("--repo is not a directory");
  }
  const strip = () => {
    const rest = { ...g };
    for (const k of LEGACY_TRILIUM_KEYS) delete rest[k];
    writeJson(gPath, rest);
  };
  const url = typeof g.triliumUrl === "string" ? g.triliumUrl.trim() : "";
  const token = typeof g.etapiToken === "string" ? g.etapiToken.trim() : "";
  if (!url) {
    if (token) return fail("legacy etapiToken without triliumUrl: nothing to migrate it to");
    strip();
    return { code: 0, result: { migrated: false } };
  }

  const mcpJson = join(repoDir, ".mcp.json");
  if (isTrackedByGit(repoDir, ".mcp.json")) return fail(".mcp.json is tracked by git; untrack it first (git rm --cached .mcp.json)");
  let doc: Record<string, unknown> = {};
  if (existsSync(mcpJson)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(mcpJson, "utf8"));
      if (!isObject(parsed) || (parsed.mcpServers !== undefined && !isObject(parsed.mcpServers))) throw new Error();
      doc = parsed;
    } catch {
      return fail(".mcp.json is not valid JSON; fix or delete it"); // never echo the parser message: it can quote the file
    }
  }
  const servers = (doc.mcpServers as Record<string, unknown> | undefined) ?? {};
  const cur = servers.trilium;
  let kept = false;
  if (cur !== undefined) {
    if (!isObject(cur) || typeof cur.url !== "string" || (cur.type !== undefined && cur.type !== "http"))
      return fail(".mcp.json has a trilium server the factory cannot use (needs type http and url); fix or remove it");
    const headers = isObject(cur.headers) ? cur.headers : {};
    const key = Object.keys(headers).find((k) => k.toLowerCase() === "authorization");
    const raw = key && typeof headers[key] === "string" ? (headers[key] as string).replace(/^Bearer(\s+|$)/i, "").trim() : "";
    kept = raw !== "" && raw !== PLACEHOLDER_TOKEN;
  }
  if (!kept) {
    const base = triliumBaseUrl(url.replace(/\/+$/, "").replace(/\/etapi$/, ""));
    servers.trilium = { type: "http", url: `${base}/mcp`, headers: { Authorization: `Bearer ${token || PLACEHOLDER_TOKEN}` } };
    doc.mcpServers = servers;
    writeJson(mcpJson, doc);
  } else chmodSync(mcpJson, 0o600);
  ensureGitignoreEntry(repoDir, ".mcp.json");
  strip();
  return { code: 0, result: kept ? { migrated: true, mcpJson, kept: true } : { migrated: true, mcpJson } };
}
