import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type GlobalConfig = { triliumUrl: string; etapiToken: string; dashboardPort: number };
export type WorkstreamEntry = { noteId: string; branch: string; worktree: string };
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

export function readGlobalConfig(env: NodeJS.ProcessEnv = process.env): GlobalConfig | null {
  return readJson<GlobalConfig>(globalConfigPath(env));
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
