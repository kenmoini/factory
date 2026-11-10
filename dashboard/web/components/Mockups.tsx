import { useEffect, useState } from "react";

type Check = "checking" | "found" | "missing" | "error";

/**
 * The workstream's HTML mockups (`<repo>/.factory/mockups/<workstream>/index.html`) in a frame, after a HEAD request
 * confirms they exist. The frame is sandboxed without same-origin, so a mockup's scripts cannot reach the dashboard.
 */
export function Mockups({ repoSlug, repoPath, workstream }: { repoSlug?: string; repoPath?: string; workstream?: string }) {
  const [check, setCheck] = useState<Check>("checking");
  const [attempt, setAttempt] = useState(0);
  const url = repoSlug && workstream ? `/mockups/${encodeURIComponent(repoSlug)}/${encodeURIComponent(workstream)}/` : undefined;

  useEffect(() => {
    if (!url) return;
    const ctrl = new AbortController();
    setCheck("checking");
    fetch(url, { method: "HEAD", cache: "no-store", signal: ctrl.signal })
      .then((res) => { if (!ctrl.signal.aborted) setCheck(res.ok ? "found" : res.status === 404 ? "missing" : "error"); })
      .catch(() => { if (!ctrl.signal.aborted) setCheck("error"); });
    return () => ctrl.abort();
  }, [url, attempt]);

  const expected = `${repoPath ?? "<repo>"}/.factory/mockups/${workstream ?? "<workstream>"}/index.html`;
  const retry = <button className="doc-retry" type="button" onClick={() => setAttempt((n) => n + 1)}>Check again</button>;

  if (url && check === "found") {
    return (
      <div className="mockups">
        <div className="mockups-bar">
          <code className="doc-path" title={expected}>.factory/mockups/{workstream}/</code>
          <button className="doc-retry" type="button" onClick={() => setAttempt((n) => n + 1)}>Reload</button>
          <a className="doc-retry" href={url} target="_blank" rel="noopener">Open in a new tab</a>
        </div>
        <iframe key={attempt} className="mockups-frame" src={url} title={`Mockups for ${workstream}`} sandbox="allow-scripts allow-forms allow-modals" />
      </div>
    );
  }

  return (
    <div className="doc-panel">
      <article className="doc">
        <h1>Mockups</h1>
        {!url ? <p className="doc-note">Pick a repo and a workstream to see its mockups.</p>
          : check === "checking" ? <p className="doc-state">Looking for mockups…</p>
          : check === "missing" ? (
            <div className="doc-note mockups-note">
              <p>No mockups yet for this workstream.</p>
              <p>The factory's UI/UX stage writes them to <code>{expected}</code>. They show here once that file exists.</p>
              {retry}
            </div>
          ) : (
            <div className="doc-note doc-error" role="alert">
              <p>The dashboard server did not answer. Check that it is still running, then try again.</p>
              {retry}
            </div>
          )}
      </article>
    </div>
  );
}
