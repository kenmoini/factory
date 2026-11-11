import { statSync } from "node:fs";

/** Facts about a session that arrive piecemeal across hook calls. */
export interface SessionFacts { transcriptPath?: string; pid?: number }
export interface SessionInfo extends SessionFacts { id: string; repoKey: string; lastSeen: number }
export interface TrackerDeps {
  /** Clock in ms; defaults to Date.now. */
  now?: () => number;
  /** Transcript mtime in ms, null when missing; defaults to statSync. */
  mtime?: (path: string) => number | null;
  /** Whether a pid is running; defaults to process.kill(pid, 0). */
  processAlive?: (pid: number) => boolean;
  /** Ids of sessions that still have live agents; defaults to none. */
  liveSessionIds?: () => Set<string>;
}
export interface ExitPolicy { graceMs: number; sessionIdleMs: number }

function defaultMtime(path: string): number | null {
  try { return statSync(path).mtimeMs; } catch { return null; }
}

function defaultProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Tracks Claude sessions and browser streams to decide when the server may exit. */
export class SessionTracker {
  /** Number of open browser streams. */
  streams = 0;
  private sessions = new Map<string, SessionInfo>();
  private lastActivity: number;
  private lastEnd: number | undefined;
  private now: () => number;
  private mtime: (path: string) => number | null;
  private processAlive: (pid: number) => boolean;
  private liveSessionIds: () => Set<string>;

  constructor(deps: TrackerDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.mtime = deps.mtime ?? defaultMtime;
    this.processAlive = deps.processAlive ?? defaultProcessAlive;
    this.liveSessionIds = deps.liveSessionIds ?? (() => new Set());
    this.lastActivity = this.now();
  }

  /** Upserts a session: new facts fill in, known facts are kept; counts as activity. */
  seen(id: string, repoKey: string, facts: SessionFacts = {}): SessionInfo {
    const now = this.now();
    const prev = this.sessions.get(id);
    const info: SessionInfo = {
      id,
      repoKey,
      transcriptPath: prev?.transcriptPath ?? facts.transcriptPath,
      pid: prev?.pid ?? facts.pid,
      lastSeen: now,
    };
    this.sessions.set(id, info);
    this.lastActivity = now;
    return info;
  }

  /** Removes a session and arms the grace path, even for unknown ids. True when it was known. */
  end(id: string): boolean {
    const known = this.sessions.delete(id);
    this.lastEnd = this.lastActivity = this.now();
    return known;
  }

  /** Records that something happened now. */
  activity(): void { this.lastActivity = this.now(); }

  streamOpened(): void { this.streams++; this.activity(); }

  streamClosed(): void { this.streams = Math.max(0, this.streams - 1); this.activity(); }

  list(): SessionInfo[] { return [...this.sessions.values()]; }

  get count(): number { return this.sessions.size; }

  /** Sessions still in use: pid alive, or (without a pid) seen, transcript or agent activity within sessionIdleMs. */
  live(sessionIdleMs: number): SessionInfo[] {
    const now = this.now();
    const agents = this.liveSessionIds();
    return this.list().filter((s) => {
      if (s.pid !== undefined) return this.processAlive(s.pid);
      if (now - s.lastSeen < sessionIdleMs) return true;
      if (s.transcriptPath) {
        const m = this.mtime(s.transcriptPath);
        if (m !== null && now - m < sessionIdleMs) return true;
      }
      return agents.has(s.id);
    });
  }

  /** Drops sessions whose process is gone; returns their ids and arms the grace path when any. */
  reap(): string[] {
    const gone = this.list().filter((s) => s.pid !== undefined && !this.processAlive(s.pid)).map((s) => s.id);
    for (const id of gone) this.sessions.delete(id);
    if (gone.length) this.lastEnd = this.lastActivity = this.now();
    return gone;
  }

  /** Why the server should exit now, or null to keep running. */
  exitReason(policy: ExitPolicy): string | null {
    if (this.streams > 0 || this.live(policy.sessionIdleMs).length > 0) return null;
    const quiet = this.now() - this.lastActivity;
    if (this.lastEnd !== undefined && quiet >= policy.graceMs) {
      return `no factory session or browser for ${Math.round(policy.graceMs / 1000)}s`;
    }
    if (quiet >= policy.sessionIdleMs) return `idle for ${Math.round(policy.sessionIdleMs / 60000)}min`;
    return null;
  }
}
