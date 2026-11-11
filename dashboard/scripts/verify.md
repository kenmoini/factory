# Manual verification checklist

Run from the repo root of a factory repo whose Trilium MCP server is registered with a real token:
`mcpServers.trilium` in `<repo>/.mcp.json` (`"url": "<trilium>/mcp"`,
`"headers": { "Authorization": "Bearer <ETAPI token>" }`), or the same entry in `~/.claude.json`.
`FACTORY_TRILIUM_URL` / `FACTORY_ETAPI_TOKEN` override both. The global config holds no credentials.
TLS certificates are not verified unless `FACTORY_TLS_VERIFY=1`, so a self-signed Trilium works.

1. `bin/factory-dashboard start` -> JSON `{"running":true,"port":...,"pid":...,"url":...}`, exit 0.
2. `bin/factory-dashboard start` again -> same pid (idempotent).
3. `bin/factory-dashboard status` -> `running: true`.
4. `bin/factory-dashboard open` -> browser shows the board; tabs and SSE indicator work.
5. Send an event as the hook would. `project` is the repo (`CLAUDE_PROJECT_DIR`, else the current directory);
   `cwd` is where the subagent runs; `transcript_path` is the session transcript
   `~/.claude/projects/<slug>/<session>.jsonl`, next to which the subagent's
   `<session>/subagents/agent-<agent_id>.jsonl` lives:
   ```
   repo=/path/to/factory-repo
   echo '{"session_id":"<session>","agent_id":"<agent id>","agent_type":"factory:builder","cwd":"'"$repo"'","transcript_path":"'"$HOME"'/.claude/projects/<slug>/<session>.jsonl"}' > /tmp/ev.json
   CLAUDE_PROJECT_DIR="$repo" dashboard/scripts/send-event.sh subagent-start /tmp/ev.json
   ```
   -> the server replies `204 No Content` (empty body, so the script prints only a newline); the agent appears
   under the repo and its transcript streams.
6. Check `~/.config/claude-factory/dashboard.log` for errors.
   - `curl -s 127.0.0.1:<port>/api/repos` -> each repo has `"trilium": {"baseUrl": ..., "placeholder": false, "source": "project"}`
     (or `"user"` / `"env"`) and no token anywhere.
   - With `Bearer your-etapi-token` in `.mcp.json`: `/api/state?repo=<repo>` is `503 {"error":"trilium token not configured"}`
     and `/api/health` has `"trilium": {"ok": false, "error": "trilium token not configured"}`. Put the real token back,
     `curl` `/api/repos` once, and the board loads again (no restart).
7. `bin/factory-dashboard stop` -> `{"running":false,"stopped":<pid>}`; pidfile gone.
8. `bin/factory-dashboard status` -> `running: false`.

## Lifecycle

1. `FACTORY_GRACE_MS=5000 bin/factory-dashboard start` from a plain shell (no Claude session) -> running.
2. `echo '{"session_id":"v1","source":"startup"}' | CLAUDE_PROJECT_DIR="$repo" dashboard/scripts/send-event.sh session-start`,
   then `curl -s 127.0.0.1:<port>/api/health` -> `"sessions": 1, "streams": 0, "autoExit": true`.
3. `echo '{"session_id":"v1","reason":"other"}' | CLAUDE_PROJECT_DIR="$repo" dashboard/scripts/send-event.sh session-end`;
   within 30 s `bin/factory-dashboard status` -> `running: false`, the pidfile is gone and `dashboard.log` ends with
   `factory-dashboard: exiting (no factory session or browser for 5s)`.
4. Repeat 1-3 with the board open in a browser: `streams` is 1 and the server stays; close the tab and it stops.
5. `bin/factory-dashboard start`, delete `~/.config/claude-factory/dashboard.pid`, `bin/factory-dashboard start`
   again -> same pid with `"adopted": true`; `status` -> running; `stop`.

## Repo tab

With the server running (steps 1-4) against a factory repo that has a worktree branch with an uncommitted file:

1. Open `#/repo` (the Repo tab): the branch rails sit beside the commit rows, newest first. Rail colours, the
   chips (branch with worktree mark and dirty count, tags, task ids), the dashed ring on a dirty worktree tip and
   the legend match `dashboard/mockup/repo.html`.
2. Click a row: the commit drawer slides in from the right with the short sha, chips, subject, author and age,
   the worktree facts for a worktree tip (path, ahead/behind main, files changed but not committed), Message,
   Changes (`+`/`−` per file, totals in the heading), Factory and Parents. A Parents button selects that commit.
3. Press Escape: the drawer closes and focus returns to the row that opened it. With the drawer open,
   ArrowUp/ArrowDown in the list move the selection and the drawer follows.
4. While a builder runs, its branch chip pulses in the row and the drawer header shows the pulse. To fake one,
   post a `subagent-start` event as in step 5 with `"description":"builder T-001 [task:<task note id>]"` in the
   JSON (the task's Trilium note id, from a task of the workstream on screen); `subagent-stop` ends it.
5. `Open on board` in the Factory section lands on the board with that task's drawer open. For a `slug/T-xxx` chip
   (a task of another workstream) it switches the workstream first.
6. `Copy sha` copies the full sha (the label reads `Copied` for 1.5 s); `Show diff` scrolls to Changes.
7. With more commits than the limit, `Load more` extends the list.
8. Pick a branch in the filter, then commit on that branch: the filter survives the new commit arriving (within
   the 5 s poll) and the new commit shows at the top.
9. Register a non-git directory via `FACTORY_REPOS` and restart (it needs a `.factory/config.json`, even `{}`, to
   be registered): its Repo tab shows "not a git repository" and the board still works.
