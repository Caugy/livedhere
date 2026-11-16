#!/usr/bin/env bash
# If the published public URL starts failing while cloudflared is still
# running, kill it so supervise-tunnel.sh can restart and rewrite public-url.txt.
set -uo pipefail
ROOT="/workspace/house-reviews"
URLFILE="${ROOT}/public-url.txt"
LOG="${ROOT}/tunnel.log"
fails=0

log() { printf '%s health: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

while true; do
  sleep 20
  [[ -f "$URLFILE" ]] || continue
  url="$(tr -d '[:space:]' < "$URLFILE")"
  [[ -n "$url" ]] || continue
  code="$(curl -sS -o /tmp/tunnel-health.html -w '%{http_code}' --max-time 20 -A 'LivedHereHealth/1.0' "$url/" || echo 000)"
  if [[ "$code" == "200" ]] && grep -q 'LivedHere' /tmp/tunnel-health.html 2>/dev/null; then
    fails=0
    continue
  fi
  fails=$((fails + 1))
  log "check failed code=$code fails=$fails url=$url"
  if (( fails >= 3 )); then
    log "restarting cloudflared after $fails failed health checks"
    pkill -f '/tmp/cloudflared tunnel' 2>/dev/null || true
    fails=0
    sleep 15
  fi
done
