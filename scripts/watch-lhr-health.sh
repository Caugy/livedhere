#!/usr/bin/env bash
# Health-check the published URL via DNS-over-HTTPS + curl --resolve
# (this box's stub DNS maps public names to 198.18.0.1 and makes plain curl fail).
set -uo pipefail
ROOT="/workspace/house-reviews"
URLFILE="${ROOT}/public-url.txt"
LOG="${ROOT}/tunnel.log"
fails=0
log() { printf '%s lhr-health: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

while true; do
  sleep 30
  [[ -f "$URLFILE" ]] || continue
  url="$(tr -d '[:space:]' < "$URLFILE")"
  [[ "$url" == https://* ]] || continue
  host="${url#https://}"
  host="${host%%/*}"
  ip="$(python3 - "$host" << 'PY'
import json, sys, urllib.request
host=sys.argv[1]
try:
    req=urllib.request.Request("https://1.1.1.1/dns-query?name="+host+"&type=A", headers={"accept":"application/dns-json"})
    with urllib.request.urlopen(req, timeout=12) as r:
        data=json.load(r)
    ips=[a["data"] for a in data.get("Answer") or [] if a.get("type")==1]
    print(ips[0] if ips else "")
except Exception:
    print("")
PY
)"
  if [[ -z "$ip" ]]; then
    fails=$((fails+1))
    log "DoH returned no A record for $host fails=$fails"
  else
    code="$(curl -sS -o /tmp/lhr-health.html -w '%{http_code}' --max-time 20 --resolve "${host}:443:${ip}" -A 'LivedHereHealth/1.0' "$url/" || echo 000)"
    if [[ "$code" == "200" ]] && grep -q 'LivedHere' /tmp/lhr-health.html 2>/dev/null; then
      fails=0
      continue
    fi
    fails=$((fails+1))
    log "check failed code=$code ip=$ip fails=$fails url=$url"
  fi
  if (( fails >= 3 )); then
    log "restarting ssh tunnel after $fails failed health checks"
    pkill -f 'nokey@.* -R 80:127.0.0.1:3000' 2>/dev/null || pkill -f 'nokey@' 2>/dev/null || true
    fails=0
    sleep 20
  fi
done
