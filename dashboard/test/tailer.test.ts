import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptTailer } from "../src/agents/tailer";

const dir = mkdtempSync(join(tmpdir(), "factory-tail-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const wait = async (cond: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await Bun.sleep(10); };
const line = (t: string) => JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:00:00Z", message: { role: "assistant", content: [{ type: "text", text: t }] } });
const opts = { pollMs: 20, retryMs: 20, maxRetries: 50 };

describe("TranscriptTailer", () => {
  test("reads existing lines, then partial line completion", async () => {
    const p = join(dir, "a.jsonl");
    writeFileSync(p, [line("one"), line("two"), line("three")].join("\n") + "\n");
    const got: number[] = [];
    const t = new TranscriptTailer(p, (s) => got.push(s.seq), opts);
    t.start();
    await wait(() => got.length >= 3);
    expect(got).toEqual([0, 1, 2]);
    const l4 = line("four");
    appendFileSync(p, l4.slice(0, 20));
    await Bun.sleep(80);
    expect(t.steps).toHaveLength(3);
    appendFileSync(p, l4.slice(20) + "\n");
    await wait(() => got.length >= 4);
    expect(got).toEqual([0, 1, 2, 3]);
    expect(t.state).toBe("tailing");
    t.stop();
    appendFileSync(p, line("five") + "\n");
    await Bun.sleep(80);
    expect(t.readAll()).toHaveLength(4);
    expect(t.state).toBe("stopped");
  });
  test("file created after start", async () => {
    const p = join(dir, "late.jsonl");
    const t = new TranscriptTailer(p, () => {}, opts);
    t.start();
    expect(t.state).toBe("waiting");
    await Bun.sleep(60);
    writeFileSync(p, readFileSync(join(import.meta.dir, "fixtures/transcripts/agent-sample.jsonl")));
    await wait(() => t.steps.length > 0);
    expect(t.steps.length).toBeGreaterThan(0);
    t.stop();
  });
  test("gives up when file never appears", async () => {
    const t = new TranscriptTailer(join(dir, "never.jsonl"), () => {}, { pollMs: 10, retryMs: 10, maxRetries: 3 });
    t.start();
    await wait(() => t.state === "gone");
    expect(t.state).toBe("gone");
  });
  test("ring buffer caps at 2000", async () => {
    const p = join(dir, "big.jsonl");
    writeFileSync(p, Array.from({ length: 2100 }, (_, i) => line(`m${i}`)).join("\n") + "\n");
    let n = 0;
    const t = new TranscriptTailer(p, () => n++, opts);
    t.start();
    await wait(() => n >= 2100);
    expect(t.steps).toHaveLength(2000);
    expect(t.steps[0].seq).toBe(100);
    t.stop();
  });
});
