import { describe, expect, test } from "bun:test";
import { SessionTracker } from "../src/sessions";

const POLICY = { graceMs: 60_000, sessionIdleMs: 7_200_000 };
function make(opts: { alive?: Set<number>; mtimes?: Record<string, number>; liveIds?: Set<string> } = {}) {
  let t = 1_000_000;
  const tracker = new SessionTracker({
    now: () => t,
    processAlive: (pid) => opts.alive?.has(pid) ?? false,
    mtime: (p) => opts.mtimes?.[p] ?? null,
    liveSessionIds: () => opts.liveIds ?? new Set(),
  });
  return { tracker, tick: (ms: number) => { t += ms; } };
}

describe("SessionTracker", () => {
  test("seen upserts, keeps facts a later call omits, bumps lastSeen", () => {
    const { tracker, tick } = make({ alive: new Set([7]) });
    tracker.seen("s1", "/r", { pid: 7 });
    tick(5_000);
    const s = tracker.seen("s1", "/r", { transcriptPath: "/t/s1.jsonl" });
    expect(tracker.count).toBe(1);
    expect(s).toMatchObject({ id: "s1", repoKey: "/r", pid: 7, transcriptPath: "/t/s1.jsonl", lastSeen: 1_005_000 });
  });
  test("seen: a pid or transcript reported later replaces the known one (a session resumed after a crash)", () => {
    const { tracker } = make({ alive: new Set([9]) });
    tracker.seen("s1", "/r", { pid: 7, transcriptPath: "/t/old.jsonl" }); // 7 crashed
    const s = tracker.seen("s1", "/r", { pid: 9, transcriptPath: "/t/new.jsonl" });
    expect(s).toMatchObject({ pid: 9, transcriptPath: "/t/new.jsonl" });
    expect(tracker.reap()).toEqual([]);
    expect(tracker.live(POLICY.sessionIdleMs).map((x) => x.id)).toEqual(["s1"]);
  });
  test("end: true for a known session, false for an unknown one; both arm the grace path", () => {
    const { tracker, tick } = make();
    tracker.seen("s1", "/r");
    expect(tracker.end("s1")).toBe(true);
    expect(tracker.end("zzz")).toBe(false);
    tick(59_999); expect(tracker.exitReason(POLICY)).toBeNull();
    tick(1); expect(tracker.exitReason(POLICY)).toBe("no factory session or browser for 60s");
  });
  test("a fresh tracker only exits through the idle path", () => {
    const { tracker, tick } = make();
    tick(7_199_999); expect(tracker.exitReason(POLICY)).toBeNull();
    tick(1); expect(tracker.exitReason(POLICY)).toBe("idle for 120min");
  });
  test("an unknown session's end never stops a live known session", () => {
    const { tracker, tick } = make({ alive: new Set([42]) });
    tracker.seen("s1", "/r", { pid: 42 });
    tracker.end("other");
    tick(7_200_000);
    expect(tracker.exitReason(POLICY)).toBeNull();
  });
  test("reap removes sessions whose process is gone and arms the grace path", () => {
    const alive = new Set([42]);
    const { tracker, tick } = make({ alive });
    tracker.seen("s1", "/r", { pid: 42 });
    expect(tracker.reap()).toEqual([]);
    alive.delete(42);
    expect(tracker.reap()).toEqual(["s1"]);
    expect(tracker.count).toBe(0);
    tick(60_000);
    expect(tracker.exitReason(POLICY)).toBe("no factory session or browser for 60s");
  });
  test("live: pid decides when known; otherwise lastSeen, transcript mtime or a live agent", () => {
    const { tracker, tick } = make({ alive: new Set([1]), mtimes: { "/t/s3.jsonl": 1_000_000 + 7_000_000 }, liveIds: new Set(["s4"]) });
    tracker.seen("s1", "/r", { pid: 1 });
    tracker.seen("s2", "/r", { pid: 2 });
    tracker.seen("s3", "/r", { transcriptPath: "/t/s3.jsonl" });
    tracker.seen("s4", "/r");
    tracker.seen("s5", "/r");
    tick(7_100_000); // s5 seen 7 100 s ago (< idle); s3's transcript grew 100 s ago
    expect(tracker.live(POLICY.sessionIdleMs).map((s) => s.id).sort()).toEqual(["s1", "s3", "s4", "s5"]);
    tick(7_100_000); // now both s5's lastSeen and s3's transcript are older than the idle period
    expect(tracker.live(POLICY.sessionIdleMs).map((s) => s.id).sort()).toEqual(["s1", "s4"]);
  });
  test("a stream keeps the server alive; streamClosed floors at zero", () => {
    const { tracker, tick } = make();
    tracker.streamClosed();
    expect(tracker.streams).toBe(0);
    tracker.seen("s1", "/r"); tracker.end("s1");
    tracker.streamOpened();
    tick(10_000_000);
    expect(tracker.exitReason(POLICY)).toBeNull();
    tracker.streamClosed();
    tick(59_000); expect(tracker.exitReason(POLICY)).toBeNull();
    tick(1_000); expect(tracker.exitReason(POLICY)).toBe("no factory session or browser for 60s");
  });
});
