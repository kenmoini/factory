import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/** `noteId` is absent until the plugin has cached the workstream's Trilium note id in `.factory/config.json`. */
export interface RepoEntry { repoPath: string; repoSlug: string; projectNoteId?: string; activeWorkstream?: string; workstreams: Record<string, { noteId?: string }> }

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

export class RepoRegistry {
  private repos = new Map<string, RepoEntry>();
  private readConfig: (repoPath: string) => RepoEntry | null;

  constructor(opts: { readConfig?: (repoPath: string) => RepoEntry | null } = {}) {
    this.readConfig = opts.readConfig ?? defaultReadConfig;
  }

  register(repoPath: string): RepoEntry | null {
    const abs = resolve(repoPath);
    const cfg = this.readConfig(abs);
    if (!cfg) return null;
    const entry: RepoEntry = { ...cfg, repoPath: abs, repoSlug: basename(abs) };
    this.repos.set(abs, entry);
    return entry;
  }

  get(repoPath: string): RepoEntry | undefined { return this.repos.get(resolve(repoPath)); }
  bySlug(slug: string): RepoEntry | undefined { return this.list().find((r) => r.repoSlug === slug); }
  list(): RepoEntry[] { return [...this.repos.values()]; }
}
