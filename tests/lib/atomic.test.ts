import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../../lib/atomic";

describe("writeFileAtomic", () => {
  test("creates the directory and file with the default mode, leaves no temp file", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-"));
    const f = join(dir, "sub", "a.json");
    writeFileAtomic(f, "{}\n");
    expect(readFileSync(f, "utf8")).toBe("{}\n");
    expect(statSync(f).mode & 0o777).toBe(0o644);
    expect(readdirSync(join(dir, "sub"))).toEqual(["a.json"]);
  });
  test("keeps an existing file's mode and replaces its content whole", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-"));
    const f = join(dir, "b.json");
    writeFileSync(f, "old"); chmodSync(f, 0o600);
    writeFileAtomic(f, "new", { mode: 0o644 });
    expect(readFileSync(f, "utf8")).toBe("new");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["b.json"]);
  });
});
