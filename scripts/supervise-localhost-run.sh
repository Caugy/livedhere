#!/usr/bin/env bash
# Supervised localhost.run reverse SSH tunnel to http://127.0.0.1:3000
# Connects to real IPs from DNS-over-HTTPS so this box's stub DNS (198.18.0.1) is bypassed.
set -uo pipefail

ROOT="/workspace/house-reviews"
URLFILE="${ROOT}/public-url.txt"
LOG="${ROOT}/tunnel.log"
KEY="/tmp/livedhere-tunnel-ssh"
KNOWN="/tmp/livedhere-known-hosts"
IPFILE="/tmp/livedhere-lhr-ips.txt"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }

ensure_key() {
  if [[ ! -f "$KEY" ]]; then
    ssh-keygen -t ed25519 -f "$KEY" -N '' -q
  fi
}

refresh_ips() {
  python3 - "$IPFILE" << 'PY'
import json, socket, sys, urllib.request
from pathlib import Path
out = Path(sys.argv[1])
names = ["ssh.localhost.run", "localhost.run"]
ips = []
seen = set()
for name in names:
    try:
        req = urllib.request.Request(
            f"https://1.1.1.1/dns-query?name={name}&type=A",
            headers={"accept": "application/dns-json"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.load(resp)
        for rec in data.get("Answer") or []:
            if rec.get("type") == 1 and rec["data"] not in seen:
                seen.add(rec["data"])
                ips.append(rec["data"])
    except Exception as exc:
        sys.stderr.write(f"DoH failed for {name}: {exc}\n")
if not ips:
    ips = ["35.171.254.69", "54.82.85.249", "54.161.197.247"]
# keep only IPs that accept SSH
live = []
for ip in ips:
    try:
        s = socket.create_connection((ip, 22), timeout=5)
        s.settimeout(5)
        banner = s.recv(64)
        s.close()
        if banner.startswith(b"SSH-"):
            live.append(ip)
    except Exception:
        continue
if not live:
    live = ips
out.write_text("\n".join(live) + "\n")
print("lhr ips:", ", ".join(live))
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

# Parse new lhr.life URLs from a growing ssh log, starting at byte offset.
watch_urls() {
  local sshlog="$1"
  python3 -u - "$sshlog" << 'PY'
import re, sys, time
from pathlib import Path
path = Path(sys.argv[1])
pat = re.compile(r"https://[a-z0-9-]+\.app\.lhr\.life")
seen = 0
last = ""
# keep running until the ssh log stops growing for a long time AND the parent dies;
# this helper is killed when ssh exits (pipeline / wait).
while True:
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        time.sleep(0.5)
        continue
    chunk = data[seen:].decode("utf-8", "replace")
    seen = len(data)
    urls = pat.findall(chunk)
    if urls and urls[-1] != last:
        last = urls[-1]
        print(last, flush=True)
    time.sleep(1)
PY
}

run_once() {
  ensure_key
  refresh_ips || log "warning: using cached localhost.run IPs"
  if [[ ! -s "$IPFILE" ]]; then
    log "error: no localhost.run IPs"
    return 1
  fi
  local ip sshlog marker
  ip="$(head -n1 "$IPFILE")"
  sshlog="/tmp/livedhere-lhr-ssh.log"
  : > "$sshlog"
  marker="LHR_LAUNCH $(date -u +%Y-%m-%dT%H:%M:%SZ) ip=$ip"
  log "$marker"

  ssh -i "$KEY" -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=accept-new \
    -o UserKnownHostsFile="$KNOWN" \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -o ConnectTimeout=15 \
    -o PreferredAuthentications=publickey,none \
    -o BatchMode=yes \
    -o HostKeyAlias=localhost.run \
    -R 80:127.0.0.1:3000 \
    "nokey@${ip}" \
    >"$sshlog" 2>&1 &
  local spid=$!
  echo "$spid" > /tmp/livedhere-tunnel.pid

  # URL watcher in background
  local upipe="/tmp/livedhere-lhr-urls.fifo"
  rm -f "$upipe"
  mkfifo "$upipe"
  watch_urls "$sshlog" >"$upipe" &
  local wpid=$!

  # Read first URL with a timeout, then keep updating until ssh exits
  (
    while IFS= read -r url; do
      [[ -n "$url" ]] && write_url "$url"
    done <"$upipe"
  ) &
  local rpid=$!

  local i got=""
  for i in $(seq 1 20); do
    if ! kill -0 "$spid" 2>/dev/null; then
      log "ssh exited early; log follows:"
      tail -30 "$sshlog" | tee -a "$LOG"
      kill "$wpid" "$rpid" 2>/dev/null || true
      wait "$spid" 2>/dev/null || true
      return 1
    fi
    if [[ -f "$URLFILE" ]]; then
      got="$(tr -d '[:space:]' < "$URLFILE")"
    fi
    if [[ "$got" == https://*.app.lhr.life ]]; then
      # only accept if this launch produced it (file may be stale from previous)
      if rg -q --fixed-strings "$got" "$sshlog" 2>/dev/null; then
        log "tunnel up pid=$spid url=$got"
        break
      fi
    fi
    sleep 1
  done

  if ! rg -q 'https://[a-z0-9-]+\.app\.lhr\.life' "$sshlog"; then
    log "no public URL after wait; killing ssh"
    tail -30 "$sshlog" | tee -a "$LOG"
    kill "$spid" "$wpid" "$rpid" 2>/dev/null || true
    wait "$spid" 2>/dev/null || true
    return 1
  fi

  wait "$spid"
  local rc=$?
  log "ssh exited rc=$rc"
  kill "$wpid" "$rpid" 2>/dev/null || true
  return "$rc"
}

echo "==== supervise-localhost-run start $(date -u +%Y-%m-%dT%H:%M:%SZ) ====" >> "$LOG"
delay=2
while true; do
  if run_once; then
    delay=2
  else
    log "restarting localhost.run tunnel in ${delay}s"
    sleep "$delay"
    if (( delay < 30 )); then
      delay=$((delay * 2))
    fi
  fi
done
