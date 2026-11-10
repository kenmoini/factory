#!/bin/sh
# send-event.sh <kind> [json-file]
# POSTs a hook-style event to the local dashboard (manual testing).
# The hook JSON (file, or stdin if omitted and piped) is wrapped in the
# {event, ts, project, payload} envelope used by bin/factory-event.
kind="${1:?usage: send-event.sh <kind> [json-file]}"
file="${2:-}"
if [ -n "$file" ]; then payload=$(cat "$file")
elif [ ! -t 0 ]; then payload=$(cat)
else payload="{}"; fi
[ -n "$payload" ] || payload="{}"
project="${CLAUDE_PROJECT_DIR:-$PWD}"
esc() { printf '%s' "$1" | sed 's/[\\"]/\\&/g'; }
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '{"event":"%s","ts":"%s","project":"%s","payload":%s}' \
  "$(esc "$kind")" "$ts" "$(esc "$project")" "$payload" |
  curl -s -X POST -H 'Content-Type: application/json' \
    "http://127.0.0.1:${FACTORY_DASHBOARD_PORT:-7777}/api/events" --data-binary @-
echo
