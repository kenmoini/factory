# Manual verification checklist

Run from the repo root with a working Trilium config (`~/.config/claude-factory/config.json`
or `FACTORY_TRILIUM_URL` / `FACTORY_ETAPI_TOKEN`).

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
7. `bin/factory-dashboard stop` -> `{"running":false,"stopped":<pid>}`; pidfile gone.
8. `bin/factory-dashboard status` -> `running: false`.
