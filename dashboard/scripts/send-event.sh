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
trimmed=$(printf '%s' "$payload" | tr -d ' \t\r\n')
if [ -z "$trimmed" ]; then
  payload="{}"
else
  case "$trimmed" in
    \{*|\[*) ;;
    *) payload="\"$(printf '%s' "$payload" | tr '\n\r\t' '   ' | sed 's/[\\"]/\\&/g')\"" ;;
  esac
fi
project="${CLAUDE_PROJECT_DIR:-$PWD}"
esc() { printf '%s' "$1" | sed 's/[\\"]/\\&/g'; }
read_port() {
  [ -f "$1" ] || return 0
  tr -d '\n' < "$1" | sed -n 's/.*"dashboardPort"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p'
}
PORT="${FACTORY_DASHBOARD_PORT:-$(read_port "${FACTORY_CONFIG_DIR:-$HOME/.config/claude-factory}/config.json")}"
PORT="${PORT:-7777}"
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '{"event":"%s","ts":"%s","project":"%s","payload":%s}' \
  "$(esc "$kind")" "$ts" "$(esc "$project")" "$payload" |
  curl -s -m 2 --connect-timeout 1 -X POST -H 'Content-Type: application/json' \
    "http://127.0.0.1:$PORT/api/events" --data-binary @-
echo
