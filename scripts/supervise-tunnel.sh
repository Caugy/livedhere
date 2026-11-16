#!/usr/bin/env bash
# Supervised Cloudflare quick tunnel to localhost:3000.
# This machine's stub DNS maps argotunnel.com to 198.18.0.1, which makes
# a bare `cloudflared tunnel --url` fail with "TLS handshake with edge error: EOF".
# We bind-mount a hosts file with real edge IPs (from DNS-over-HTTPS) and
# run cloudflared in a user namespace so the edge connection can complete.
set -uo pipefail

ROOT="/workspace/house-reviews"
URLFILE="${ROOT}/public-url.txt"
LOG="${ROOT}/tunnel.log"
HOSTS="/tmp/hosts.doh"
CF="${CF:-/tmp/cloudflared}"
ORIGIN="http://127.0.0.1:3000"
PIDFILE="/tmp/livedhere-tunnel.pid"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }

update_hosts() {
  python3 - "$HOSTS" << 'PY'
import json, sys, urllib.request
from pathlib import Path

hosts_path = Path(sys.argv[1])
base = Path("/etc/hosts").read_text()
# Keep only the real system hosts, drop any previous argotunnel block
lines = [ln for ln in base.splitlines() if "argotunnel" not in ln.lower()]
names = [
    "region1.v2.argotunnel.com",
    "region2.v2.argotunnel.com",
    "cfd-features.argotunnel.com",
    "v2.argotunnel.com",
]
fallback = "198.41.192.57"
entries = []
for name in names:
    try:
        req = urllib.request.Request(
            "https://1.1.1.1/dns-query?name=" + name + "&type=A",
            headers={"accept": "application/dns-json"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.load(resp)
        ips = [a["data"] for a in data.get("Answer", []) if a.get("type") == 1]
    except Exception as exc:
        sys.stderr.write(f"DoH failed for {name}: {exc}\n")
        ips = []
    if not ips:
        ips = [fallback]
    for ip in ips[:6]:
        entries.append(f"{ip} {name}")

block = "\n# Real Cloudflare tunnel edge IPs (bypass stub DNS fake-ip)\n" + "\n".join(entries) + "\n"
hosts_path.write_text("\n".join(lines) + "\n" + block)
print(f"wrote {hosts_path} ({len(entries)} edge records)")
PY
}

write_url() {
  local url="$1"
  local current=""
  if [[ -f "$URLFILE" ]]; then
    current="$(tr -d '[:space:]' < "$URLFILE")"
  fi
  if [[ "$url" != "$current" ]]; then
    printf '%s\n' "$url" > "${URLFILE}.tmp"
    mv "${URLFILE}.tmp" "$URLFILE"
    log "public URL updated: $url"
  fi
}

extract_url() {
  # latest trycloudflare URL in the log since this launch marker
  local marker="$1"
  python3 - "$LOG" "$marker" << 'PY'
import re, sys
from pathlib import Path
text = Path(sys.argv[1]).read_text(errors="replace")
marker = sys.argv[2]
idx = text.rfind(marker)
if idx >= 0:
    text = text[idx:]
urls = re.findall(r"https://[a-z0-9-]+\.trycloudflare\.com", text)
print(urls[-1] if urls else "")
PY
}

registered() {
  local marker="$1"
  python3 - "$LOG" "$marker" << 'PY'
import sys
from pathlib import Path
text = Path(sys.argv[1]).read_text(errors="replace")
marker = sys.argv[2]
idx = text.rfind(marker)
if idx >= 0:
    text = text[idx:]
print("yes" if "Registered tunnel connection" in text else "no")
PY
}

# Stop any unmanaged cloudflared we are replacing (not the LivedHere app).
stop_other_tunnels() {
  local self=$$
  local pid
  for pid in $(pgrep -f '/tmp/cloudflared tunnel' || true); do
    if [[ "$pid" != "$self" && "$pid" != "$BASHPID" ]]; then
      # don't kill our child if already started; this runs before start
      kill "$pid" 2>/dev/null || true
    fi
  done
  sleep 1
}

run_once() {
  update_hosts || log "warning: failed to refresh edge IPs, reusing existing hosts file"
  if [[ ! -x "$CF" ]]; then
    log "error: cloudflared not found at $CF"
    return 1
  fi
  local marker="TUNNEL_LAUNCH $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  log "$marker"

  unshare --user --map-root-user --mount bash -c \
    "mount --bind '$HOSTS' /etc/hosts && exec '$CF' tunnel --protocol http2 --url '$ORIGIN'" \
    >>"$LOG" 2>&1 &
  local cpid=$!
  echo "$cpid" > "$PIDFILE"

  # Wait up to ~45s for a registered connection and URL
  local i url status
  for i in $(seq 1 30); do
    if ! kill -0 "$cpid" 2>/dev/null; then
      log "cloudflared exited early (pid $cpid)"
      wait "$cpid" || true
      return 1
    fi
    url="$(extract_url "$marker")"
    status="$(registered "$marker")"
    if [[ -n "$url" && "$status" == "yes" ]]; then
      write_url "$url"
      log "tunnel up pid=$cpid url=$url"
      wait "$cpid"
      local rc=$?
      log "cloudflared exited rc=$rc"
      return "$rc"
    fi
    sleep 1.5
  done

  url="$(extract_url "$marker")"
  if [[ -n "$url" ]]; then
    write_url "$url"
    log "warning: URL assigned ($url) but connection not confirmed; watching process"
    wait "$cpid"
    return $?
  fi

  log "tunnel failed to come up; killing pid $cpid"
  kill "$cpid" 2>/dev/null || true
  wait "$cpid" 2>/dev/null || true
  return 1
}

echo "==== supervise-tunnel start $(date -u +%Y-%m-%dT%H:%M:%SZ) ====" >> "$LOG"
stop_other_tunnels
delay=2
while true; do
  if run_once; then
    delay=2
  else
    log "restarting tunnel in ${delay}s"
    sleep "$delay"
    if (( delay < 30 )); then
      delay=$((delay * 2))
    fi
  fi
done
