import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EtapiNote } from "../../src/trilium/client";

export interface FakeEtapi { url: string; token: string; stop(): void; notes: EtapiNote[]; calls: string[] }

function parseTerms(q: string): { name: string; value?: string }[] {
  const out: { name: string; value?: string }[] = [];
  const re = /#(\w+)(?:\s*=\s*'((?:[^'\\]|\\.)*)')?/g;
  for (const m of q.matchAll(re)) out.push({ name: m[1], value: m[2] === undefined ? undefined : m[2].replace(/\\(.)/g, "$1") });
  return out;
}

function hasAncestor(byId: Map<string, EtapiNote>, note: EtapiNote, ancestor: string, directOnly: boolean): boolean {
  if (directOnly) return note.parentNoteIds.includes(ancestor);
  const seen = new Set<string>();
  const stack = [...note.parentNoteIds];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === ancestor) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(byId.get(id)?.parentNoteIds ?? []));
  }
  return false;
}

export function startFakeEtapi(fixtures: { notes: EtapiNote[]; contents: Record<string, string>; token?: string }, opts: { port?: number } = {}): FakeEtapi {
  const token = fixtures.token ?? "test-token";
  const notes = fixtures.notes;
  const byId = new Map(notes.map((n) => [n.noteId, n]));
  const calls: string[] = [];
  const json = (body: unknown, status = 200) => Response.json(body, { status });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    fetch(req) {
      const u = new URL(req.url);
      calls.push(u.pathname + u.search);
      if (req.headers.get("authorization") !== token) return json({ message: "unauthorized" }, 401);
      if (u.pathname === "/etapi/app-info") return json({ appVersion: "0.107.0" });
      if (u.pathname === "/etapi/notes") {
        const terms = parseTerms(u.searchParams.get("search") ?? "");
        const anc = u.searchParams.get("ancestorNoteId");
        const direct = u.searchParams.get("ancestorDepth") === "eq1";
        let res = notes.filter((n) =>
          terms.every((t) => n.attributes.some((a) => a.type === "label" && a.name === t.name && (t.value === undefined || a.value === t.value))) &&
          (!anc || hasAncestor(byId, n, anc, direct)));
        const limit = Number(u.searchParams.get("limit"));
        if (limit > 0) res = res.slice(0, limit);
        return json({ results: res });
      }
      const m = u.pathname.match(/^\/etapi\/notes\/([^/]+)(\/content)?$/);
      if (m) {
        const note = byId.get(decodeURIComponent(m[1]));
        if (!note) return json({ message: "not found" }, 404);
        if (!m[2]) return json(note);
        return new Response(fixtures.contents[note.noteId] ?? "", { headers: { "Content-Type": note.type === "text" ? "text/html" : note.mime } });
      }
      return json({ message: "not found" }, 404);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, token, stop: () => void server.stop(true), notes, calls };
}

export function loadFixtureNotes(): { notes: EtapiNote[]; contents: Record<string, string> } {
  const dir = join(import.meta.dir, "../fixtures/etapi");
  const notes: EtapiNote[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    notes.push(...(JSON.parse(readFileSync(join(dir, f), "utf8")).results as EtapiNote[]));
  }
  const t002 = notes.find((n) => n.noteId === "t002")!;
  const child = (id: string, title: string, doc: string): EtapiNote => ({
    noteId: id, title, type: "text", mime: "text/html", parentNoteIds: ["t002"], childNoteIds: [],
    attributes: [{ attributeId: `${id}a`, noteId: id, type: "label", name: "factoryDoc", value: doc, position: 10, isInheritable: false }],
    dateCreated: t002.dateCreated, dateModified: t002.dateModified, utcDateCreated: t002.utcDateCreated, utcDateModified: t002.utcDateModified,
  });
  notes.push(child("t002spec", "T-002 spec", "task-spec"), child("t002appr", "T-002 approval", "approval"));
  t002.childNoteIds = [...t002.childNoteIds, "t002spec", "t002appr"];
  const contents: Record<string, string> = {
    d1: "<h1>Goal</h1><p>Ship the demo.</p>",
    d2: "<h1>Spec</h1><p>Build it.</p>",
    d3: "# API Design\n\nGET /api/state",
    t002spec: "<p>T-002 task spec</p>",
    t002appr: "<p>Approved by approver</p>",
    r1: "<p>No secrets in the diff; no new permissions.</p>",
    r2: "<p>The loader swallows fetch errors. Surface them to the caller.</p>",
    v1: "<h1>Validation</h1><p>Round 1, plan rev 1: <strong>pass</strong>. No lens failed.</p>",
  };
  return { notes, contents };
}

if (import.meta.main) {
  const i = process.argv.indexOf("--serve");
  if (i >= 0) {
    const port = Number(process.argv[i + 1]) || 7799;
    const f = startFakeEtapi({ ...loadFixtureNotes(), token: "fake-token" }, { port });
    console.log(`fake etapi at ${f.url} token ${f.token}`);
  }
}
