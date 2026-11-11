import type { WorkstreamSnapshot } from "../../src/shared/types";
import { store, type Action, type State, type Store } from "./store";

/**
 * Points the server's poller for `repo` at workstream `slug` (`GET /api/state?repo=&ws=`; the stream follows it from
 * then on) and dispatches the snapshot it answers with. A 404 (no such workstream) dispatches `open-task-failed`;
 * another failure is left to the stream. A reply that arrives after the user picked another repo is dropped.
 * `target` and `base` (the server's origin) stand in for the app's store and page origin in tests.
 */
export async function switchWorkstream(repo: string, slug: string, target: Pick<Store<State, Action>, "getState" | "dispatch"> = store, base = ""): Promise<void> {
  try {
    const res = await fetch(`${base}/api/state?repo=${encodeURIComponent(repo)}&ws=${encodeURIComponent(slug)}`, { cache: "no-store" });
    const data = res.ok ? ((await res.json()) as WorkstreamSnapshot) : undefined;
    if (target.getState().repo !== repo) return;
    if (data) target.dispatch({ type: "snapshot", data });
    else if (res.status === 404) target.dispatch({ type: "open-task-failed" });
  } catch { /* the stream delivers the snapshot once the poller catches up */ }
}
