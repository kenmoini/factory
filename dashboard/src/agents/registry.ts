import type { LiveAgent } from "../shared/types";

export class AgentRegistry {
  private agents = new Map<string, LiveAgent>();
  private recentIds: string[] = []; // oldest first
  private recentCap: number;
  private recentTtlMs: number;
  private now: () => number;

  private evictCbs: ((agentId: string) => void)[] = [];

  /** Called whenever an agent is dropped from `recent` (cap or TTL). */
  onEvict(cb: (agentId: string) => void): void { this.evictCbs.push(cb); }

  private evict(id: string): void {
    this.agents.delete(id);
    for (const cb of this.evictCbs) { try { cb(id); } catch { /* ignore */ } }
  }

  constructor(opts: { recentCap?: number; recentTtlMs?: number; now?: () => number } = {}) {
    this.recentCap = opts.recentCap ?? 50;
    this.recentTtlMs = opts.recentTtlMs ?? 30 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  start(e: { agentId: string; agentType: string; cwd: string; sessionId?: string; description?: string; model?: string; transcriptPath?: string }): LiveAgent {
    this.recentIds = this.recentIds.filter((id) => id !== e.agentId);
    const agent: LiveAgent = {
      agentId: e.agentId, agentType: e.agentType, cwd: e.cwd,
      startedAt: new Date(this.now()).toISOString(), stepCount: 0,
    };
    if (e.sessionId) agent.sessionId = e.sessionId;
    if (e.description) agent.description = e.description;
    if (e.model) agent.model = e.model;
    if (e.transcriptPath) agent.transcriptPath = e.transcriptPath;
    const m = e.description?.match(/\[task:([^\]]+)\]/);
    if (m) agent.taskNoteId = m[1];
    this.agents.set(e.agentId, agent);
    return agent;
  }

  stop(agentId: string, patch: { transcriptPath?: string } = {}): LiveAgent | undefined {
    const a = this.agents.get(agentId);
    if (!a) return undefined;
    if (patch.transcriptPath) a.transcriptPath = patch.transcriptPath;
    if (!a.finishedAt) {
      a.finishedAt = new Date(this.now()).toISOString();
      this.recentIds.push(agentId);
      while (this.recentIds.length > this.recentCap) this.evict(this.recentIds.shift()!);
    }
    return a;
  }

  touch(agentId: string, patch: Partial<LiveAgent>): LiveAgent | undefined {
    const a = this.agents.get(agentId);
    if (a) Object.assign(a, patch, { agentId });
    return a;
  }

  get(agentId: string): LiveAgent | undefined { return this.agents.get(agentId); }

  prune(): void {
    const cutoff = this.now() - this.recentTtlMs;
    this.recentIds = this.recentIds.filter((id) => {
      const a = this.agents.get(id);
      if (a?.finishedAt && Date.parse(a.finishedAt) < cutoff) { this.evict(id); return false; }
      return !!a;
    });
  }

  list(cwd?: string): { live: LiveAgent[]; recent: LiveAgent[] } {
    this.prune();
    const live: LiveAgent[] = [];
    const recent: LiveAgent[] = [];
    for (const a of this.agents.values()) {
      if (cwd && a.cwd !== cwd) continue;
      (a.finishedAt ? recent : live).push(a);
    }
    const newest = (x: LiveAgent, y: LiveAgent) => (y.finishedAt && x.finishedAt && y.finishedAt !== x.finishedAt ? y.finishedAt.localeCompare(x.finishedAt) : y.startedAt.localeCompare(x.startedAt));
    return { live: live.sort(newest), recent: recent.sort(newest) };
  }
}
