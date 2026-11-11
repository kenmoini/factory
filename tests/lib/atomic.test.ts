import { describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
  test("writes through a symlink: the target gets the content and keeps its mode, the link stays", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-"));
    const real = join(dir, "real.json");
    const link = join(dir, "link.json");
    writeFileSync(real, "old"); chmodSync(real, 0o600);
    symlinkSync("real.json", link);
    writeFileAtomic(link, "new");
    expect(readFileSync(real, "utf8")).toBe("new");
    expect(statSync(real).mode & 0o777).toBe(0o600);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["link.json", "real.json"]);
  });
});
