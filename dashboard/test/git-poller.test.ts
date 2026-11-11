import { describe, expect, test } from "bun:test";
import { GitPoller } from "../src/git/poller";
import type { RepoProbe } from "../src/git/reader";
import { EventHub } from "../src/hub";
import type { RepoSnapshot, StreamEvent } from "../src/shared/types";

const snap = (fingerprint: string, error?: string): RepoSnapshot => ({ repoPath: "/r", defaultBranch: "main", branches: [], commits: [], limit: 100, truncated: false, fingerprint, ...(error ? { error } : {}) });

/**
 * A reader whose probes answer from `probes` in turn: a fingerprint, or `{ error }` for a failed probe. `build` turns a
 * probe into a snapshot with its fingerprint; a fingerprint starting with `!` makes the build fail with the rest as error.
 */
function fakeReader(probes: (string | { error: string })[]) {
  const calls = { probe: 0, build: 0, opts: [] as unknown[] };
  return {
    calls,
    probe: async (): Promise<RepoProbe | { error: string }> => {
      calls.probe++;
      const p = probes.shift()!;
      return typeof p === "string" ? { fingerprint: p, refs: [], worktrees: [] } : p;
    },
    build: async (p: RepoProbe, o: unknown) => {
      calls.build++; calls.opts.push(o);
      return p.fingerprint.startsWith("!") ? snap("", p.fingerprint.slice(1)) : snap(p.fingerprint);
    },
  };
}

describe("GitPoller", () => {
  test("publishes on the first snapshot and on fingerprint change only; errors keep the last snapshot", async () => {
    const reader = fakeReader(["1", "1", "2", { error: "boom" }, "3"]);
    const hub = new EventHub(); const events: StreamEvent[] = []; hub.subscribe("/r", (e) => events.push(e));
    const p = new GitPoller("/r", { reader, hub }, { limit: 50 });
    expect(await p.refresh()).toBe(true); expect(await p.refresh()).toBe(false); expect(await p.refresh()).toBe(true);
    expect(await p.refresh()).toBe(false); expect(p.lastError()).toBe("boom"); expect(p.snapshot()?.fingerprint).toBe("2");
    expect(await p.refresh()).toBe(true); expect(p.lastError()).toBeNull();
    expect(events.map((e) => e.type)).toEqual(["repo", "repo", "repo"]);
    expect(reader.calls.opts[0]).toEqual({ limit: 50 });
  });
  test("probes on every refresh and builds only when the fingerprint changed", async () => {
    const reader = fakeReader(["1", "1", "1", "2"]);
    const p = new GitPoller("/r", { reader, hub: new EventHub() });
    expect(await p.refresh()).toBe(true); expect(reader.calls).toMatchObject({ probe: 1, build: 1 });
    expect(await p.refresh()).toBe(false); expect(reader.calls).toMatchObject({ probe: 2, build: 1 });
    expect(await p.refresh()).toBe(false); expect(reader.calls).toMatchObject({ probe: 3, build: 1 });
    expect(await p.refresh()).toBe(true); expect(reader.calls).toMatchObject({ probe: 4, build: 2 });
    expect(p.snapshot()?.fingerprint).toBe("2");
  });
  test("refresh is single-flight and start/stop drive the interval", async () => {
    let n = 0; let hold = true; let release!: () => void;
    const reader = {
      probe: () => new Promise<RepoProbe>((res) => {
        n++;
        const probe = { fingerprint: String(n), refs: [], worktrees: [] };
        if (hold) release = () => res(probe); else res(probe);
      }),
      build: async (p: RepoProbe) => snap(p.fingerprint),
    };
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
