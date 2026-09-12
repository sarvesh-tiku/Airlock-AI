#!/usr/bin/env bash
# Prepare a clean demo: fresh Linear issues (if a key is set) and a reset dashboard.
set -euo pipefail
cd "$(dirname "$0")/.."
URL="${AIRLOCK_URL:-http://127.0.0.1:3000}"

if [[ -f .env ]] && grep -qE '^LINEAR_API_KEY=.+' .env; then
  echo "Seeding a fresh issue graph in Linear..."
  npm run -s linear:seed
else
  echo "No LINEAR_API_KEY in .env; skipping Linear seed (sample data still works)."
fi

if curl -sf "$URL/api/state" >/dev/null; then
  curl -sf -X POST "$URL/api/reset" -H 'content-type: application/json' -d '{"scenario":"drift"}' >/dev/null
  echo "Dashboard reset to the Requirement drift scenario at $URL"
else
  echo "Airlock is not running at $URL. Start it with: npm start"
fi
