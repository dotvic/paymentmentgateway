#!/usr/bin/env bash
# Usage: scripts/verify-deploy.sh https://host   -- polls /health, then checks key pages. Exit 1 if anything fails.
set -u
BASE="${1:?base url}"
for i in $(seq 1 30); do
  if curl -fsS --max-time 5 "$BASE/health" | grep -q '"ok": *true'; then ok=1; break; fi
  sleep 5
done
[ "${ok:-0}" = 1 ] || { echo "health never came up at $BASE"; exit 1; }
bad=0
for p in / /labs /academy /knowledge /labs/risk /labs/agents /developers; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE$p")
  [ "$code" = 200 ] || { echo "$p -> $code"; bad=1; }
done
[ $bad = 0 ] && echo "verified $BASE"
exit $bad
