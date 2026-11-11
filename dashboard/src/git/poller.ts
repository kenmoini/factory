import type { EventHub } from "../hub";
import type { RepoSnapshot } from "../shared/types";
import { errorSnapshot, type GitReader } from "./reader";

export interface GitPollerDeps { reader: Pick<GitReader, "probe" | "build">; hub: EventHub }

/**
 * Polls one repo's git state: each poll probes refs, worktrees and dirty counts, and only when their fingerprint
 * differs from the current snapshot's builds a new snapshot (log, ahead/behind) and publishes it as a `repo` event.
 * Until a good snapshot exists, a failure is the snapshot (`error` set), so the stream's connect frame carries it.
 */
export class GitPoller {
  private snap: RepoSnapshot | null = null;
  private err: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<boolean> | null = null;
  private intervalMs: number;
  private limit: number;

  constructor(private repoPath: string, private deps: GitPollerDeps, opts: { intervalMs?: number; limit?: number } = {}) {
    this.intervalMs = opts.intervalMs ?? 5000;
    this.limit = opts.limit ?? 100;
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): RepoSnapshot | null { return this.snap; }
  lastError(): string | null { return this.err; }

  /** Single-flight; resolves true when a new snapshot (or a new error snapshot) was published. */
  refresh(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    const p = this.doRefresh().finally(() => { this.inFlight = null; });
    this.inFlight = p;
    return p;
  }

  private async doRefresh(): Promise<boolean> {
    const probe = await this.deps.reader.probe();
    if ("error" in probe) return this.fail(probe.error);
    if (this.snap && !this.snap.error && this.snap.fingerprint === probe.fingerprint) { this.err = null; return false; }
    const data = await this.deps.reader.build(probe, { limit: this.limit });
    if (data.error) return this.fail(data.error);
    this.err = null;
    this.snap = data;
    this.deps.hub.publish(this.repoPath, { type: "repo", data });
    return true;
  }

  /** Records the error; a good snapshot is kept, else the error snapshot becomes current and is published when its text changes. */
  private fail(message: string): boolean {
    this.err = message;
    if (this.snap && (!this.snap.error || this.snap.error === message)) return false;
    this.snap = errorSnapshot(this.repoPath, this.limit, message);
    this.deps.hub.publish(this.repoPath, { type: "repo", data: this.snap });
    return true;
  }
}
