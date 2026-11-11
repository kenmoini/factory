import { useEffect, useState } from "react";

/** A drawer's detail fetch, keyed by the url it was fetched from. */
export type Load<T> =
  | { status: "idle" }
  | { status: "loading"; url: string }
  | { status: "ready"; url: string; detail: T }
  | { status: "error"; url: string; code?: number };

/**
 * `GET url` (JSON) while `url` is set; refetched when `url`, `version` or `attempt` changes. A refetch of the url
 * already on screen keeps its detail there instead of flashing "loading", and a failed refetch keeps it too. An
 * aborted request (the url changed, the drawer closed) is dropped; `code` is the HTTP status of a failed answer.
 */
export function useDetail<T>(url: string | undefined, version: string, attempt: number): Load<T> {
  const [load, setLoad] = useState<Load<T>>({ status: "idle" });
  useEffect(() => {
    if (!url) return;
    const ctrl = new AbortController();
    setLoad((prev) => (prev.status === "ready" && prev.url === url ? prev : { status: "loading", url }));
    (async () => {
      let code: number | undefined;
      try {
        const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
        code = res.status;
        if (!res.ok) throw new Error(`status ${code}`);
        const detail = (await res.json()) as T;
        if (!ctrl.signal.aborted) setLoad({ status: "ready", url, detail });
      } catch {
        if (ctrl.signal.aborted) return;
        setLoad((prev) => (prev.status === "ready" && prev.url === url ? prev : { status: "error", url, code }));
      }
    })();
    return () => ctrl.abort();
  }, [url, version, attempt]);
  return load;
}
