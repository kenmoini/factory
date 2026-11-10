import type { Action } from "./store";

const EVENTS = ["snapshot", "agent", "step", "heartbeat"] as const;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 10000];

/**
 * Subscribes to the repo's server-sent events and feeds them to `dispatch`.
 * On error the EventSource is closed (its built-in retry is not used) and reopened after 1 s, 2 s, 4 s, 8 s, then every 10 s.
 * Returns a disposer that closes the connection and cancels any pending reconnect.
 */
export function connect(repo: string, dispatch: (e: Action) => void): () => void {
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let disposed = false;

  const open = () => {
    timer = undefined;
    if (disposed) return;
    const source = new EventSource(`/api/stream?repo=${encodeURIComponent(repo)}`);
    es = source;
    source.onopen = () => {
      attempt = 0;
      dispatch({ type: "connected", data: true });
    };
    source.onerror = () => {
      source.close();
      if (es !== source || disposed) return;
      es = null;
      dispatch({ type: "connected", data: false });
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      attempt++;
      timer = setTimeout(open, delay);
    };
    for (const type of EVENTS) {
      source.addEventListener(type, (e) => {
        let data: unknown;
        try { data = JSON.parse((e as MessageEvent<string>).data); } catch { return; }
        dispatch({ type, data } as Action);
      });
    }
  };

  open();
  return () => {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    es?.close();
    es = null;
  };
}
