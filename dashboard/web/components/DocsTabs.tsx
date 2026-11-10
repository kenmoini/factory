import { useEffect, useState } from "react";
import type { Doc, WorkstreamSnapshot } from "../../src/shared/types";
import { toSafeHtml } from "../lib/render";

export interface DocTab { id: string; label: string; kind: string }

interface DocBody { noteId: string; title: string; format: "html" | "markdown"; content: string; modified: string }
interface Cached { etag: string; title: string; html: string }
type Load = { status: "loading" } | { status: "ready"; doc: Cached } | { status: "error"; message: string };

// In-memory cache for this page: note id -> last body seen, revalidated with If-None-Match on every open.
const cache = new Map<string, Cached>();

/** The doc for a tab: the workstream's own note wins over a project-level one of the same kind. */
export function findDoc(snapshot: WorkstreamSnapshot | null, kind: string): Doc | undefined {
  const docs = snapshot?.docs.filter((d) => d.kind === kind) ?? [];
  return docs.find((d) => d.parentId && d.parentId === snapshot?.workstream?.id) ?? docs[0];
}

function errorText(status: number | undefined): string {
  if (status === 404) return "This note is no longer in Trilium. It may have been moved or deleted.";
  if (status === 502 || status === 503) return "Trilium did not answer the dashboard. Check that Trilium is running, then try again.";
  if (status === undefined) return "The dashboard server is not reachable. Check that it is still running, then try again.";
  if (status < 400) return "The dashboard server sent a document it could not read. Try again.";
  return `The dashboard server returned an error (${status}). Try again; if it keeps failing, check the server log.`;
}

/** Drops a leading <h1> that only repeats the note title, since the panel already shows the title. */
function withoutTitleHeading(html: string, title: string): string {
  return html.replace(/^\s*<h1[^>]*>([\s\S]*?)<\/h1>/i, (m, inner: string) =>
    inner.replace(/<[^>]+>/g, "").trim().toLowerCase() === title.trim().toLowerCase() ? "" : m);
}

function useDoc(id: string, modified: string, attempt: number): Load {
  const [load, setLoad] = useState<Load>(() => {
    const hit = cache.get(id);
    return hit ? { status: "ready", doc: hit } : { status: "loading" };
  });

  useEffect(() => {
    const ctrl = new AbortController();
    const hit = cache.get(id);
    setLoad(hit ? { status: "ready", doc: hit } : { status: "loading" });
    (async () => {
      let status: number | undefined;
      try {
        const res = await fetch(`/api/docs/${encodeURIComponent(id)}`, {
          headers: hit ? { "If-None-Match": hit.etag } : {},
          cache: "no-store", // revalidation is ours; keep the browser cache out of it
          signal: ctrl.signal,
        });
        status = res.status;
        if (res.status === 304 && hit) return;
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body = (await res.json()) as DocBody;
        const entry: Cached = { etag: res.headers.get("ETag") ?? "", title: body.title, html: withoutTitleHeading(toSafeHtml(body.content, body.format), body.title) };
        if (entry.etag) cache.set(id, entry);
        if (!ctrl.signal.aborted) setLoad({ status: "ready", doc: entry });
      } catch {
        if (ctrl.signal.aborted) return;
        // a failed revalidation keeps showing the copy we already have
        if (!hit) setLoad({ status: "error", message: errorText(status) });
      }
    })();
    return () => ctrl.abort();
  }, [id, modified, attempt]);

  return load;
}

function docPath(snapshot: WorkstreamSnapshot, doc: Doc): string {
  const ws = snapshot.workstream;
  const base = `ClaudeProjects/${snapshot.project.title}`;
  if (ws && doc.kind === "validation") return `${base}/Workstreams/${ws.slug}/Validation/${doc.title}`;
  return ws && doc.parentId === ws.id ? `${base}/Workstreams/${ws.slug}/${doc.title}` : `${base}/${doc.title}`;
}

/** Validation rounds, newest first: by the `round` label, else the number in the `Round <N>` title. */
export function validationRounds(snapshot: WorkstreamSnapshot | null): Doc[] {
  const n = (d: Doc) => d.round || Number(d.title.match(/\d+/)?.[0] ?? 0);
  return (snapshot?.docs.filter((d) => d.kind === "validation") ?? []).sort((a, b) => n(b) - n(a));
}

/** The Validation tab: one button per round (newest first) above the chosen round's note, the newest by default. */
function ValidationRounds({ snapshot, rounds }: { snapshot: WorkstreamSnapshot; rounds: Doc[] }) {
  const [picked, setPicked] = useState<string>();
  const doc = rounds.find((d) => d.id === picked) ?? rounds[0];
  return (
    <>
      <nav className="rounds" aria-label="Validation rounds">
        {rounds.map((d) => (
          <button key={d.id} type="button" className="round-pick" aria-pressed={d.id === doc.id} onClick={() => setPicked(d.id)}>{d.title}</button>
        ))}
      </nav>
      <DocView key={doc.id} snapshot={snapshot} doc={doc} />
    </>
  );
}

function DocView({ snapshot, doc }: { snapshot: WorkstreamSnapshot; doc: Doc }) {
  const [attempt, setAttempt] = useState(0);
  const load = useDoc(doc.id, doc.modified, attempt);
  return (
    <article className="doc" aria-busy={load.status === "loading"}>
      <p className="doc-path">{docPath(snapshot, doc)}</p>
      <h1>{doc.title}</h1>
      {load.status === "loading" && <p className="doc-state">Loading {doc.title} from Trilium…</p>}
      {load.status === "error" && (
        <div className="doc-note doc-error" role="alert">
          <p>{load.message}</p>
          <button className="doc-retry" type="button" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
        </div>
      )}
      {load.status === "ready" && <div className="doc-body" dangerouslySetInnerHTML={{ __html: load.doc.html }} />}
    </article>
  );
}

/** One document tab: the rendered note, or a note saying it does not exist yet. */
export function DocsTab({ tab, snapshot }: { tab: DocTab; snapshot: WorkstreamSnapshot | null }) {
  if (tab.kind === "validation" && snapshot) {
    const rounds = validationRounds(snapshot);
    if (rounds.length > 0) return <ValidationRounds snapshot={snapshot} rounds={rounds} />;
  }
  const doc = findDoc(snapshot, tab.kind);
  if (snapshot && doc) return <DocView key={doc.id} snapshot={snapshot} doc={doc} />;
  return (
    <article className="doc">
      <h1>{tab.label}</h1>
      <p className="doc-note">
        {snapshot
          ? `There is no ${tab.label} document for this workstream yet. It shows here once the factory writes it to Trilium.`
          : "Waiting for the board to load from Trilium."}
      </p>
    </article>
  );
}
