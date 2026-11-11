import type { EventHub } from "../hub";
import type { RepoRegistry } from "../repos";
import type { LiveAgent, RepoSnapshot, StreamEvent, WorkstreamSnapshot } from "../shared/types";

export interface StreamDeps {
  hub: EventHub;
  repos: RepoRegistry;
  snapshot: (repoKey: string) => WorkstreamSnapshot | null;
  repo: (repoKey: string) => RepoSnapshot | null;
  live: (repoKey: string) => LiveAgent[];
  heartbeatMs?: number;
  /** Called once when the stream opens, before its first frame. */
  onOpen?: () => void;
  /** Called once when the stream closes, whether the client went away or a write failed. */
  onClose?: () => void;
}

const frame = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

export function streamRoute(req: Request, deps: StreamDeps): Response {
  const key = new URL(req.url).searchParams.get("repo");
  const entry = key ? (deps.repos.get(key) ?? deps.repos.bySlug(key)) : undefined;
  if (!entry) return Response.json({ error: "unknown repo" }, { status: 404 });
  const repoKey = entry.repoPath;

  const enc = new TextEncoder();
  let cleanup = () => {};

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let done = false;
      let unsub: () => void = () => {};
      let timer: ReturnType<typeof setInterval> | undefined;
      const send = (text: string) => {
        if (done) return;
        try { controller.enqueue(enc.encode(text)); } catch { cleanup(); }
      };
      cleanup = () => {
        if (done) return;
        done = true;
        unsub();
        if (timer) clearInterval(timer);
        req.signal.removeEventListener("abort", onAbort);
        try { controller.close(); } catch { /* already closed */ }
        deps.onClose?.();
      };
      const onAbort = () => cleanup();

      deps.onOpen?.();
      send(": connected\n\n");
      const snap = deps.snapshot(repoKey);
      if (snap) send(frame("snapshot", snap));
      const repo = deps.repo(repoKey);
      if (repo) send(frame("repo", repo));
      for (const agent of deps.live(repoKey)) send(frame("agent", { op: "start", agent }));

      unsub = deps.hub.subscribe(repoKey, (e: StreamEvent) => send(frame(e.type, e.data)));
      timer = setInterval(() => send(frame("heartbeat", { ts: new Date().toISOString() })), deps.heartbeatMs ?? 15_000);
      (timer as { unref?: () => void }).unref?.();

      if (req.signal.aborted) cleanup();
      else req.signal.addEventListener("abort", onAbort, { once: true });
    },
    cancel() { cleanup(); },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
