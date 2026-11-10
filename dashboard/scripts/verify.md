# Manual verification checklist

Run from the repo root with a working Trilium config (`~/.config/claude-factory/config.json`
or `FACTORY_TRILIUM_URL` / `FACTORY_ETAPI_TOKEN`).

1. `bin/factory-dashboard start` -> JSON `{"running":true,"port":...,"pid":...,"url":...}`, exit 0.
2. `bin/factory-dashboard start` again -> same pid (idempotent).
3. `bin/factory-dashboard status` -> `running: true`.
4. `bin/factory-dashboard open` -> browser shows the board; tabs and SSE indicator work.
5. Send an event with a real transcript path:
   ```
   echo '{"session_id":"s1","agent_id":"a1","agent_type":"factory:implementer","transcript_path":"<real .jsonl path>"}' > /tmp/ev.json
   dashboard/scripts/send-event.sh subagent-start /tmp/ev.json
   ```
   -> `{"ok":true}`-style reply; the agent appears and its transcript streams.
6. Check `~/.config/claude-factory/dashboard.log` for errors.
7. `bin/factory-dashboard stop` -> `{"running":false,"stopped":<pid>}`; pidfile gone.
8. `bin/factory-dashboard status` -> `running: false`.
