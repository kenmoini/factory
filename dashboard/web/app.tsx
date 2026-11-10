import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Agents } from "./components/Agents";
import { DocsTab, findDoc, type DocTab } from "./components/DocsTabs";
import { Kanban } from "./components/Kanban";
import { Mockups } from "./components/Mockups";
import { TaskDrawer } from "./components/TaskDrawer";
import { dispatch, store, useStore } from "./lib/store";
import { connect } from "./lib/stream";
import type { WorkstreamSnapshot } from "../src/shared/types";

/** `noteId` is missing for a workstream the plugin has not linked to its Trilium note yet. */
interface RepoInfo { repoPath: string; repoSlug: string; activeWorkstream?: string; workstreams: { slug: string; noteId?: string }[] }

interface TabDef { id: string; label: string; kind?: string }

export const TABS: TabDef[] = [
  { id: "board", label: "Board" },
  { id: "goal", label: "Goal", kind: "goal" },
  { id: "standards", label: "Standards", kind: "standards" },
  { id: "overview", label: "Overview", kind: "overview" },
  { id: "spec", label: "Spec", kind: "spec" },
  { id: "plan", label: "Plan", kind: "plan" },
  { id: "uiux", label: "UI/UX", kind: "uiux" },
  { id: "api", label: "API", kind: "api-design" },
  { id: "validation", label: "Validation", kind: "validation" },
  { id: "agents", label: "Agents" },
  { id: "mockups", label: "Mockups" },
];
const SEPARATOR_AFTER = new Set(["board", "validation"]);
export const tabFromHash = (hash: string) => {
  const id = hash.replace(/^#\/?/, "");
  return TABS.some((t) => t.id === id) ? id : "board";
};
const isEnabled = (t: TabDef, snapshot: WorkstreamSnapshot | null) => !t.kind || !!findDoc(snapshot, t.kind);

/** Keeps the selected tab and the `#/<tab>` hash in step, in both directions (main.tsx reads the first hash before rendering). */
function useHashTab(tab: string) {
  useEffect(() => {
    const sync = () => dispatch({ type: "tab", data: tabFromHash(location.hash) });
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  useEffect(() => {
    if (location.hash === `#/${tab}`) return;
    // a missing or unknown hash is corrected in place; a tab change is a new history entry, so Back works
    if (tabFromHash(location.hash) === tab) history.replaceState(null, "", `#/${tab}`);
    else history.pushState(null, "", `#/${tab}`);
  }, [tab]);
}

/** Registered repos from the server, re-read every 30 s so a repo the factory starts in shows up. */
function useRepos(): { repos: RepoInfo[] | null; failed: boolean } {
  const [repos, setRepos] = useState<RepoInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await fetch("/api/repos", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { repos: RepoInfo[] };
        if (live) { setRepos(body.repos); setFailed(false); }
      } catch {
        if (live) setFailed(true);
      }
    };
    void load();
    const timer = setInterval(load, 30_000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  return { repos, failed };
}

function Header({ repos, current, snapshot }: { repos: RepoInfo[] | null; current?: RepoInfo; snapshot: WorkstreamSnapshot | null }) {
  const connected = useStore((s) => s.connected);
  const live = useStore((s) => s.live);
  const ws = useStore((s) => s.ws);
  const [switching, setSwitching] = useState<string>();
  const running = Object.keys(live).length;

  // the snapshot lists the project's workstream notes; before the first snapshot, the repo's config stands in
  const slugs = [...new Set(snapshot
    ? [...snapshot.workstreams.map((w) => w.slug), ...(snapshot.workstream ? [snapshot.workstream.slug] : [])]
    : [...(current?.workstreams.map((w) => w.slug) ?? []), ...(current?.activeWorkstream ? [current.activeWorkstream] : [])])];
  const wsValue = switching ?? snapshot?.workstream?.slug ?? ws ?? "";

  const chooseWorkstream = async (slug: string) => {
    if (!current) return;
    const repo = current.repoPath;
    setSwitching(slug);
    dispatch({ type: "select-ws", data: slug });
    try {
      const res = await fetch(`/api/state?repo=${encodeURIComponent(repo)}&ws=${encodeURIComponent(slug)}`, { cache: "no-store" });
      if (res.ok && store.getState().repo === repo) dispatch({ type: "snapshot", data: (await res.json()) as WorkstreamSnapshot });
    } catch { /* the stream delivers the snapshot once the poller catches up */ }
    setSwitching(undefined);
  };

  return (
    <div className="chrome-row">
      <div className="brand">factory</div>
      <div className="pickers">
        <label className="pick"><span>Repo</span>
          <select
            value={current?.repoPath ?? ""}
            disabled={!repos || repos.length === 0}
            onChange={(e) => {
              const next = repos?.find((r) => r.repoPath === e.target.value);
              if (next) dispatch({ type: "select-repo", data: { repo: next.repoPath, ws: next.activeWorkstream } });
            }}
          >
            {!repos?.length && <option value="">{repos ? "No repos yet" : "Loading…"}</option>}
            {repos?.map((r) => <option key={r.repoPath} value={r.repoPath} title={r.repoPath}>{r.repoSlug}</option>)}
          </select>
        </label>
        <label className="pick"><span>Workstream</span>
          <select value={wsValue} disabled={slugs.length === 0 || !!switching} onChange={(e) => void chooseWorkstream(e.target.value)}>
            {slugs.length === 0 && <option value="">None yet</option>}
            {slugs.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>
      <div className="chrome-status">
        {running > 0 && <div className="live-count"><span className="pulse" aria-hidden="true" />{running} {running === 1 ? "agent" : "agents"} running</div>}
        <span className={`conn${connected ? " is-up" : ""}`} role="status" title={connected ? "Receiving live updates from the dashboard server" : "Not receiving live updates; retrying"}>
          {connected ? "Connected" : current ? "Reconnecting" : "Offline"}
        </span>
      </div>
    </div>
  );
}

function Tabs({ tab, snapshot }: { tab: string; snapshot: WorkstreamSnapshot | null }) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const select = (id: string) => dispatch({ type: "tab", data: id });

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const enabled = TABS.filter((t) => isEnabled(t, snapshot));
    const i = enabled.findIndex((t) => t.id === tab);
    const next = e.key === "ArrowRight" ? enabled[(i + 1) % enabled.length]
      : e.key === "ArrowLeft" ? enabled[(i - 1 + enabled.length) % enabled.length]
      : e.key === "Home" ? enabled[0]
      : e.key === "End" ? enabled[enabled.length - 1]
      : undefined;
    if (!next) return;
    e.preventDefault();
    select(next.id);
    refs.current.get(next.id)?.focus();
  };

  return (
    <nav className="tabs" role="tablist" aria-label="Workstream views" onKeyDown={onKeyDown}>
      {TABS.map((t) => {
        const selected = t.id === tab;
        const enabled = isEnabled(t, snapshot);
        return (
          <Fragment key={t.id}>
            <button
              ref={(el) => { if (el) refs.current.set(t.id, el); else refs.current.delete(t.id); }}
              id={`tab-${t.id}`}
              className="tab"
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={selected ? `panel-${t.id}` : undefined}
              tabIndex={selected ? 0 : -1}
              disabled={!enabled}
              title={enabled ? undefined : `No ${t.label} document yet`}
              onClick={() => select(t.id)}
            >
              {t.label}
            </button>
            {SEPARATOR_AFTER.has(t.id) && <span className="tab-sep" aria-hidden="true" />}
          </Fragment>
        );
      })}
    </nav>
  );
}

function BoardStatus({ children }: { children: ReactNode }) {
  return <div className="board-scroll"><p className="board-status" role="status">{children}</p></div>;
}

function Board({ snapshot, repos, failed }: { snapshot: WorkstreamSnapshot | null; repos: RepoInfo[] | null; failed: boolean }) {
  const connected = useStore((s) => s.connected);
  if (failed && !repos) return <BoardStatus>The dashboard server did not answer. Check that it is still running, then reload the page.</BoardStatus>;
  if (!repos) return <BoardStatus>Loading repos…</BoardStatus>;
  if (repos.length === 0) return <BoardStatus>No repos yet. A repo shows up here once the factory runs in it, or when the server starts with <code>FACTORY_REPOS</code> set.</BoardStatus>;
  if (!snapshot) {
    return connected
      ? <BoardStatus>Waiting for the first update from Trilium. If the board stays empty, check that Trilium is running and the ETAPI token is set.</BoardStatus>
      : <BoardStatus>Connecting to the dashboard server…</BoardStatus>;
  }
  if (!snapshot.workstream) return <BoardStatus>{snapshot.project.title} has no workstream in Trilium yet. The board fills in once the factory plans one.</BoardStatus>;
  return <Kanban snapshot={snapshot} />;
}

export function App() {
  const repo = useStore((s) => s.repo);
  const tab = useStore((s) => s.tab);
  const snapshot = useStore((s) => s.snapshot);
  const selectedTask = useStore((s) => s.selectedTask);
  const ws = useStore((s) => s.ws);
  const { repos, failed } = useRepos();
  const current = repos?.find((r) => r.repoPath === repo);

  useHashTab(tab);

  // default to the first repo, and fall back to it if the selected one disappears
  useEffect(() => {
    if (!repos?.length || (repo && repos.some((r) => r.repoPath === repo))) return;
    dispatch({ type: "select-repo", data: { repo: repos[0].repoPath, ws: repos[0].activeWorkstream } });
  }, [repos, repo]);

  useEffect(() => (repo ? connect(repo, dispatch) : undefined), [repo]);

  useEffect(() => {
    const ws = snapshot?.workstream?.slug;
    document.title = current ? `${current.repoSlug}${ws ? ` / ${ws}` : ""}: factory` : "factory";
  }, [current, snapshot]);

  const def = TABS.find((t) => t.id === tab) ?? TABS[0];
  const workstream = snapshot?.workstream?.slug ?? ws ?? current?.activeWorkstream;
  return (
    <>
      <header className="chrome">
        <Header repos={repos} current={current} snapshot={snapshot} />
        <Tabs tab={def.id} snapshot={snapshot} />
      </header>
      <main>
        {def.id === "board" ? (
          // drawer-open squeezes the lanes so all seven stay visible beside the drawer
          <section className={`board-panel${selectedTask && snapshot?.workstream ? " drawer-open" : ""}`} id="panel-board" role="tabpanel" aria-labelledby="tab-board">
            <Board snapshot={snapshot} repos={repos} failed={failed} />
            {snapshot?.workstream && <TaskDrawer snapshot={snapshot} />}
          </section>
        ) : def.id === "agents" ? (
          <section className="agents-panel" id="panel-agents" role="tabpanel" aria-labelledby="tab-agents">
            <Agents key={current?.repoPath} repo={current?.repoPath} snapshot={snapshot} />
          </section>
        ) : def.id === "mockups" ? (
          <section className="mockups-panel" id="panel-mockups" role="tabpanel" aria-labelledby="tab-mockups">
            <Mockups repoSlug={current?.repoSlug} repoPath={current?.repoPath} workstream={workstream} />
          </section>
        ) : (
          <section className="doc-panel" id={`panel-${def.id}`} role="tabpanel" aria-labelledby={`tab-${def.id}`}>
            <DocsTab tab={def as DocTab} snapshot={snapshot} />
          </section>
        )}
      </main>
    </>
  );
}
