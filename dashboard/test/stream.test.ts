import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventHub } from "../src/hub";
import { RepoRegistry } from "../src/repos";
import { streamRoute } from "../src/routes/stream";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fstream-"));
  mkdirSync(join(dir, ".factory"));
  writeFileSync(join(dir, ".factory/config.json"), JSON.stringify({ projectNoteId: "p1", activeWorkstream: "a", workstreams: { a: {} } }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A stream of a registered repo whose open and close calls are counted; nothing is read, so frames stay queued. */
function open() {
  const repos = new RepoRegistry();
  repos.register(dir);
  const calls = { opens: 0, closes: 0 };
  const ac = new AbortController();
  const req = new Request(`http://127.0.0.1/api/stream?repo=${encodeURIComponent(dir)}`, { signal: ac.signal });
  const res = streamRoute(req, {
    hub: new EventHub(), repos, snapshot: () => null, repo: () => null, live: () => [],
    onOpen: () => calls.opens++, onClose: () => calls.closes++,
  });
  return { ac, reader: res.body!.getReader(), calls };
}

describe("streamRoute", () => {
  // a queued frame keeps the stream readable after abort, so the later cancel reaches the source's cancel() too
  test("onOpen and onClose run once each when the request aborts and the body is then cancelled", async () => {
    const { ac, reader, calls } = open();
    expect(calls).toEqual({ opens: 1, closes: 0 });
    ac.abort();
    await reader.cancel();
    await Bun.sleep(10);
    expect(calls).toEqual({ opens: 1, closes: 1 });
  });

  test("onClose runs once when the body is cancelled and the request then aborts", async () => {
    const { ac, reader, calls } = open();
    await reader.cancel();
    ac.abort();
    await Bun.sleep(10);
    expect(calls).toEqual({ opens: 1, closes: 1 });
  });
});
