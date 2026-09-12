#!/usr/bin/env bash
# Example: run any agent command under a context lease, using the Node session guard.
#   scripts/guarded-agent.sh ENG-142 my-agent "auth/**" -- codex exec "implement ENG-142"
set -euo pipefail
cd "$(dirname "$0")/.."
URL="${AIRLOCK_URL:-http://127.0.0.1:3000}"

if [[ $# -lt 5 || "$4" != "--" ]]; then
  echo "usage: $0 ISSUE_ID AGENT_NAME WRITE_SET -- COMMAND [ARGS...]" >&2
  exit 2
fi
issue="$1"; agent="$2"; write_set="$3"; shift 4

# Build the JSON write set from a comma-separated list.
write_json=$(printf '%s' "$write_set" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | awk 'NF' | sed 's/.*/"&"/' | paste -sd, -)
lease_id=$(curl -sf -X POST "$URL/api/leases" -H 'content-type: application/json' \
  -d "{\"issueId\":\"$issue\",\"agent\":\"$agent\",\"readSet\":[],\"writeSet\":[$write_json]}" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(!j.id){console.error(j.error);process.exit(1)}console.log(j.id)})')

echo "[airlock] lease $lease_id for $agent on $issue" >&2
exec node bin/guarded-session.js "$lease_id" -- "$@"
