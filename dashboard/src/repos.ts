import { readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { isPlaceholderToken, readTriliumMcp, type TriliumSource } from "./trilium/mcp-config";

/** Where a repo's Trilium is, as shown by `/api/repos`: never the token. `config`: the global fallback (legacy config keys). */
export interface RepoTrilium { baseUrl: string; placeholder: boolean; source: TriliumSource | "config" }
/** A repo's Trilium credentials; only the registry and the client built from them hold the token. */
export interface TriliumCreds extends RepoTrilium { token: string }

/**
 * `noteId` is absent until the plugin has cached the workstream's Trilium note id in `.factory/config.json`.
 * `trilium` is absent when no Trilium MCP server is configured for the repo.
 */
export interface RepoEntry { repoPath: string; repoSlug: string; projectNoteId?: string; activeWorkstream?: string; workstreams: Record<string, { noteId?: string }>; trilium?: RepoTrilium }

/** How the registry finds a repo's Trilium: see readTriliumMcp; `fallback` is the global config's URL and token. */
export interface TriliumLookup { env: Record<string, string | undefined>; homeDir: string; fallback?: { baseUrl: string; token: string } }

function defaultReadConfig(repoPath: string): RepoEntry | null {
  try {
    const raw = JSON.parse(readFileSync(join(repoPath, ".factory", "config.json"), "utf8"));
    if (!raw || typeof raw !== "object") return null;
    const e: RepoEntry = { repoPath, repoSlug: basename(repoPath), workstreams: {} };
    if (typeof raw.projectNoteId === "string") e.projectNoteId = raw.projectNoteId;
    if (typeof raw.activeWorkstream === "string") e.activeWorkstream = raw.activeWorkstream;
    for (const [slug, w] of Object.entries(raw.workstreams ?? {})) {
      if (!w || typeof w !== "object" || Array.isArray(w)) continue;
      const noteId = (w as { noteId?: unknown }).noteId;
      e.workstreams[slug] = typeof noteId === "string" && noteId ? { noteId } : {};
    }
    return e;
  } catch {
    return null;
  }
}

/** Identifies one version of a file without reading it: mtime (ns), size and inode. null when missing. */
function fileStamp(path: string): string | null {
  try {
    const s = statSync(path, { bigint: true });
    return `${s.mtimeNs}:${s.size}:${s.ino}`;
  } catch {
    return null;
  }
}
const configStamp = (repoPath: string) => fileStamp(join(repoPath, ".factory", "config.json"));

const sameCreds = (a: TriliumCreds | null | undefined, b: TriliumCreds | null | undefined) =>
  a === b || (!!a && !!b && a.baseUrl === b.baseUrl && a.token === b.token && a.placeholder === b.placeholder && a.source === b.source);

export class RepoRegistry {
  private repos = new Map<string, RepoEntry>();
  private stamps = new Map<string, string | null>();
  private creds = new Map<string, TriliumCreds | null>();
  private credStamps = new Map<string, string>();
  private readConfig: (repoPath: string) => RepoEntry | null;
  private lookup: TriliumLookup | undefined;

  /** Without `trilium` no credentials are resolved: every entry is "trilium not configured". */
  constructor(opts: { readConfig?: (repoPath: string) => RepoEntry | null; trilium?: TriliumLookup } = {}) {
    this.readConfig = opts.readConfig ?? defaultReadConfig;
    this.lookup = opts.trilium;
  }

  register(repoPath: string): RepoEntry | null {
    const abs = resolve(repoPath);
    const stamp = configStamp(abs); // taken before the read, so a write racing it is picked up by the next reload
    const credStamp = this.credStamp(abs);
    const cfg = this.readConfig(abs);
    if (!cfg) return null;
    const entry: RepoEntry = { ...cfg, repoPath: abs, repoSlug: basename(abs) };
    this.repos.set(abs, entry);
    this.stamps.set(abs, stamp);
    this.creds.delete(abs);
    this.applyCreds(entry);
    this.credStamps.set(abs, credStamp);
    return entry;
  }

  /** The repo's Trilium URL and token (null: not configured). The same object until a reload finds them changed. */
  credentials(repoPath: string): TriliumCreds | null { return this.creds.get(resolve(repoPath)) ?? null; }

  /** The files a repo's credentials come from: `<repo>/.mcp.json` and `~/.claude.json`. */
  private credStamp(abs: string): string {
    const home = this.lookup?.homeDir;
    return `${fileStamp(join(abs, ".mcp.json"))}|${home ? fileStamp(join(home, ".claude.json")) : null}`;
  }

  private resolveCreds(abs: string): TriliumCreds | null {
    const l = this.lookup;
    if (!l) return null;
    const found = readTriliumMcp(abs, l.env, l.homeDir);
    if (found) return found;
    const f = l.fallback;
    if (!f?.baseUrl) return null;
    return { baseUrl: f.baseUrl.replace(/\/+$/, ""), token: f.token, placeholder: isPlaceholderToken(f.token), source: "config" };
  }

  /** Re-resolves the entry's credentials; the old object is kept when nothing changed. Returns whether they changed. */
  private applyCreds(entry: RepoEntry): boolean {
    const before = this.creds.get(entry.repoPath);
    const next = this.resolveCreds(entry.repoPath);
    if (before !== undefined && sameCreds(before, next)) return false;
    this.creds.set(entry.repoPath, next);
    if (next) entry.trilium = { baseUrl: next.baseUrl, placeholder: next.placeholder, source: next.source };
    else delete entry.trilium;
    return before !== undefined;
  }

  /**
   * Re-reads a registered repo's `.factory/config.json` when its stamp changed and updates the entry in place, so a
   * poller holding the entry sees the new values. A missing or unparsable file (e.g. mid-write) keeps the old values
   * and is retried on the next call. `activeChanged`: the config's `activeWorkstream` differs from before.
   * The Trilium credentials are re-resolved when `.mcp.json` or `~/.claude.json` changed (`triliumChanged`).
   */
  reload(repoPath: string): { entry: RepoEntry; changed: boolean; activeChanged: boolean; triliumChanged: boolean } | null {
    const abs = resolve(repoPath);
    const entry = this.repos.get(abs);
    if (!entry) return null;
    const credStamp = this.credStamp(abs);
    let triliumChanged = false;
    if (credStamp !== this.credStamps.get(abs)) {
      this.credStamps.set(abs, credStamp);
      triliumChanged = this.applyCreds(entry);
    }
    const stamp = configStamp(abs);
    const cfg = stamp !== null && stamp !== this.stamps.get(abs) ? this.readConfig(abs) : null;
    if (!cfg) return { entry, changed: false, activeChanged: false, triliumChanged };
    this.stamps.set(abs, stamp);
    const before = entry.activeWorkstream;
    delete entry.projectNoteId;
    delete entry.activeWorkstream;
    if (cfg.projectNoteId) entry.projectNoteId = cfg.projectNoteId;
    if (cfg.activeWorkstream) entry.activeWorkstream = cfg.activeWorkstream;
    entry.workstreams = cfg.workstreams;
    return { entry, changed: true, activeChanged: entry.activeWorkstream !== before, triliumChanged };
  }

  get(repoPath: string): RepoEntry | undefined { return this.repos.get(resolve(repoPath)); }
  bySlug(slug: string): RepoEntry | undefined { return this.list().find((r) => r.repoSlug === slug); }
  list(): RepoEntry[] { return [...this.repos.values()]; }
}
