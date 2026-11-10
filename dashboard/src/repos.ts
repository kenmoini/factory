import { readFileSync, statSync } from "node:fs";
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

/** Identifies one version of `.factory/config.json` without reading it: mtime (ns), size and inode. null when missing. */
function configStamp(repoPath: string): string | null {
  try {
    const s = statSync(join(repoPath, ".factory", "config.json"), { bigint: true });
    return `${s.mtimeNs}:${s.size}:${s.ino}`;
  } catch {
    return null;
  }
}

export class RepoRegistry {
  private repos = new Map<string, RepoEntry>();
  private stamps = new Map<string, string | null>();
  private readConfig: (repoPath: string) => RepoEntry | null;

  constructor(opts: { readConfig?: (repoPath: string) => RepoEntry | null } = {}) {
    this.readConfig = opts.readConfig ?? defaultReadConfig;
  }

  register(repoPath: string): RepoEntry | null {
    const abs = resolve(repoPath);
    const stamp = configStamp(abs); // taken before the read, so a write racing it is picked up by the next reload
    const cfg = this.readConfig(abs);
    if (!cfg) return null;
    const entry: RepoEntry = { ...cfg, repoPath: abs, repoSlug: basename(abs) };
    this.repos.set(abs, entry);
    this.stamps.set(abs, stamp);
    return entry;
  }

  /**
   * Re-reads a registered repo's `.factory/config.json` when its stamp changed and updates the entry in place, so a
   * poller holding the entry sees the new values. A missing or unparsable file (e.g. mid-write) keeps the old values
   * and is retried on the next call. `activeChanged`: the config's `activeWorkstream` differs from before.
   */
  reload(repoPath: string): { entry: RepoEntry; changed: boolean; activeChanged: boolean } | null {
    const abs = resolve(repoPath);
    const entry = this.repos.get(abs);
    if (!entry) return null;
    const stamp = configStamp(abs);
    const cfg = stamp !== null && stamp !== this.stamps.get(abs) ? this.readConfig(abs) : null;
    if (!cfg) return { entry, changed: false, activeChanged: false };
    this.stamps.set(abs, stamp);
    const before = entry.activeWorkstream;
    delete entry.projectNoteId;
    delete entry.activeWorkstream;
    if (cfg.projectNoteId) entry.projectNoteId = cfg.projectNoteId;
    if (cfg.activeWorkstream) entry.activeWorkstream = cfg.activeWorkstream;
    entry.workstreams = cfg.workstreams;
    return { entry, changed: true, activeChanged: entry.activeWorkstream !== before };
  }

  get(repoPath: string): RepoEntry | undefined { return this.repos.get(resolve(repoPath)); }
  bySlug(slug: string): RepoEntry | undefined { return this.list().find((r) => r.repoSlug === slug); }
  list(): RepoEntry[] { return [...this.repos.values()]; }
}
