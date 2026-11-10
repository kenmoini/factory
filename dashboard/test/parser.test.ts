import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLine, parseTranscript, summarizeTool } from "../src/agents/parser";

const fixture = readFileSync(join(import.meta.dir, "fixtures/transcripts/agent-sample.jsonl"), "utf8");
const count = (steps: { kind: string }[], kind: string) => steps.filter((s) => s.kind === kind).length;

describe("parseTranscript", () => {
  const { steps, rest } = parseTranscript(fixture);

  test("counts per kind match the fixture (1 text, 3 thinking, 4 tool, 4 result)", () => {
    expect(steps.length).toBe(12);
    expect(count(steps, "text")).toBe(1);
    expect(count(steps, "thinking")).toBe(3);
    expect(count(steps, "tool")).toBe(4);
    expect(count(steps, "result")).toBe(4);
  });

  test("seq is contiguous from 0", () => {
    expect(steps.map((s) => s.seq)).toEqual(steps.map((_, i) => i));
  });

  test("Bash with description summarises to it; without, to the command prefix", () => {
    const bash = steps.filter((s) => s.tool?.name === "Bash");
    expect(bash[0].tool!.summary).toBe("List repo sources");
    const noDesc = bash[bash.length - 1];
    expect(noDesc.tool!.summary).toBe(noDesc.tool!.summary.slice(0, 80));
    expect(noDesc.tool!.summary.startsWith("ls -la /repo/src")).toBe(true);
  });

  test("is_error tool_result maps to isError", () => {
    const results = steps.filter((s) => s.kind === "result");
    expect(results.filter((r) => r.isError).length).toBe(2);
    expect(results.filter((r) => !r.isError).length).toBe(2);
    for (const t of steps.filter((s) => s.kind === "tool")) expect(t.toolUseId).toBeTruthy();
  });

  test("rest is the partial final line; rest + newline parses into one more step", () => {
    expect(rest).toBe(fixture.split("\n").pop()!);
    expect(rest.includes("final partial")).toBe(true);
    const more = parseTranscript(rest + "\n");
    expect(more.rest).toBe("");
    expect(more.steps.length).toBe(1);
    expect(more.steps[0].kind).toBe("text");
  });

  test("text ending in newline yields empty rest", () => {
    expect(parseTranscript('{"type":"x"}\n')).toEqual({ steps: [], rest: "" });
  });
});

describe("parseLine", () => {
  test("ignored and invalid lines yield []", () => {
    expect(parseLine('{"type":"assistant"', 0)).toEqual([]);
    expect(parseLine("", 0)).toEqual([]);
    expect(parseLine("   ", 0)).toEqual([]);
    expect(parseLine('{"type":"api-request","timestamp":"t"}', 0)).toEqual([]);
    expect(parseLine('{"type":"api-request-blob"}', 0)).toEqual([]);
    expect(parseLine('{"type":"attachment"}', 0)).toEqual([]);
    expect(parseLine("null", 0)).toEqual([]);
    expect(parseLine('{"type":"user","message":{"content":"hi"}}', 0)).toEqual([]);
    expect(parseLine('{"type":"assistant","message":{}}', 0)).toEqual([]);
  });

  test("seq increments per step and ts comes from timestamp", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-01-02T03:04:05.000Z",
      message: { content: [{ type: "text", text: "a" }, { type: "thinking", thinking: "x" }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } }] },
    });
    const s = parseLine(line, 7);
    expect(s.map((x) => x.seq)).toEqual([7, 8, 9]);
    expect(s[0]).toEqual({ seq: 7, ts: "2026-01-02T03:04:05.000Z", kind: "text", text: "a" });
    expect(s[1].text).toBeUndefined();
    expect(s[2].tool).toEqual({ name: "Read", summary: "/a" });
    expect(s[2].toolUseId).toBe("t1");
  });

  test("missing timestamp falls back to now", () => {
    const s = parseLine('{"type":"assistant","message":{"content":[{"type":"text","text":"a"}]}}', 0);
    expect(Number.isNaN(Date.parse(s[0].ts))).toBe(false);
  });
});

describe("summarizeTool", () => {
  const long = "x".repeat(200);
  const cases: [string, unknown, string][] = [
    ["Bash", { description: "Do it", command: "ls" }, "Do it"],
    ["Bash", { command: "ls   -la\n  /tmp" }, "ls -la /tmp"],
    ["Bash", { description: "", command: "echo hi" }, "echo hi"],
    ["Bash", { command: long }, "x".repeat(80)],
    ["Read", { file_path: "/repo/a.ts" }, "/repo/a.ts"],
    ["Edit", { file_path: "/repo/b.ts" }, "/repo/b.ts"],
    ["Write", { file_path: "/repo/c.ts" }, "/repo/c.ts"],
    ["NotebookEdit", { file_path: "/repo/n.ipynb" }, "/repo/n.ipynb"],
    ["MultiEdit", { file_path: "/repo/m.ts" }, "/repo/m.ts"],
    ["Glob", { pattern: "**/*.ts" }, "**/*.ts"],
    ["Glob", { pattern: "*.ts", path: "/repo/src" }, "*.ts in /repo/src"],
    ["Grep", { pattern: "foo" }, "foo"],
    ["Grep", { pattern: "foo", path: "/repo" }, "foo in /repo"],
    ["Agent", { description: "Review code" }, "Review code"],
    ["WebFetch", { url: "https://example.com" }, "https://example.com"],
    ["WebSearch", { query: "bun test" }, "bun test"],
    ["Skill", { skill: "factory:plan" }, "factory:plan"],
    ["Other", { a: 1 }, '{"a":1}'],
    ["Other", { a: long }, JSON.stringify({ a: long }).slice(0, 80)],
    ["Read", {}, ""],
    ["Bash", null, ""],
    ["Other", undefined, ""],
  ];
  test.each(cases)("%s %j -> %j", (name, input, expected) => {
    expect(summarizeTool(name, input)).toBe(expected);
  });
});
