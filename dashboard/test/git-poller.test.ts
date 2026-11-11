import { describe, expect, test } from "bun:test";
import { GitPoller } from "../src/git/poller";
import { EventHub } from "../src/hub";
import type { RepoSnapshot, StreamEvent } from "../src/shared/types";

const snap = (fingerprint: string, error?: string): RepoSnapshot => ({ repoPath: "/r", defaultBranch: "main", branches: [], commits: [], limit: 100, truncated: false, fingerprint, ...(error ? { error } : {}) });

describe("GitPoller", () => {
  test("publishes on the first snapshot and on fingerprint change only; errors keep the last snapshot", async () => {
    const queue: RepoSnapshot[] = [snap("1"), snap("1"), snap("2"), snap("2", "boom"), snap("3")];
    const calls: unknown[] = [];
    const reader = { snapshot: async (o: unknown) => { calls.push(o); return queue.shift()!; } };
    const hub = new EventHub(); const events: StreamEvent[] = []; hub.subscribe("/r", (e) => events.push(e));
    const p = new GitPoller("/r", { reader, hub }, { limit: 50 });
    expect(await p.refresh()).toBe(true); expect(await p.refresh()).toBe(false); expect(await p.refresh()).toBe(true);
    expect(await p.refresh()).toBe(false); expect(p.lastError()).toBe("boom"); expect(p.snapshot()?.fingerprint).toBe("2");
    expect(await p.refresh()).toBe(true); expect(p.lastError()).toBeNull();
    expect(events.map((e) => e.type)).toEqual(["repo", "repo", "repo"]);
    expect(calls[0]).toEqual({ limit: 50 });
  });
  test("refresh is single-flight and start/stop drive the interval", async () => {
    let n = 0; let hold = true; let release!: () => void;
    const reader = { snapshot: () => new Promise<RepoSnapshot>((res) => {
      n++;
      const fp = snap(String(n));
      if (hold) release = () => res(fp); else res(fp);
    }) };
    const p = new GitPoller("/r", { reader, hub: new EventHub() }, { intervalMs: 10 });
    const a = p.refresh(), b = p.refresh();
    expect(n).toBe(1); hold = false; release(); expect(await a).toBe(true); expect(await b).toBe(true);
    expect(n).toBe(1);
    p.start(); await Bun.sleep(60);
    expect(n).toBeGreaterThanOrEqual(4);
    p.stop(); const seen = n; await Bun.sleep(40);
    expect(n).toBe(seen);
  });
});
