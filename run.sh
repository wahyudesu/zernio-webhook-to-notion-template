#!/usr/bin/env bash
# Start (or restart) the webhook receiver and its public tunnel.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# Use bundled binaries when present, otherwise whatever is installed on PATH.
NODE="$DIR/runtime/bin/node"; [[ -x "$NODE" ]] || NODE="node"
CFD="$DIR/bin/cloudflared"; [[ -x "$CFD" ]] || CFD="cloudflared"
mkdir -p logs run data

stop_pid() {
  local f="$1"
  if [[ -f "$f" ]]; then
    local pid; pid="$(cat "$f")"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null; sleep 1; kill -9 "$pid" 2>/dev/null; fi
    rm -f "$f"
  fi
}

stop_pid run/server.pid
stop_pid run/tunnel.pid

# server
nohup "$NODE" --experimental-sqlite server.mjs >> logs/stdout.log 2>&1 &
echo $! > run/server.pid
for i in $(seq 1 20); do
  curl -sf -m 2 "http://127.0.0.1:${PORT:-8787}/health" >/dev/null 2>&1 && break
  sleep 0.5
done

# tunnel
: > logs/tunnel.log
nohup "$CFD" tunnel --url "http://127.0.0.1:${PORT:-8787}" --no-autoupdate --logfile logs/tunnel.log > logs/tunnel.out 2>&1 &
echo $! > run/tunnel.pid

URL=""
for i in $(seq 1 40); do
  URL="$(grep -oh 'https://[a-z0-9-]*\.trycloudflare\.com' logs/tunnel.log logs/tunnel.out 2>/dev/null | head -1)"
  [[ -n "$URL" ]] && break
  sleep 1
done

if [[ -z "$URL" ]]; then
  echo "ERROR: tunnel URL not found" >&2
  exit 1
fi
echo "$URL" > data/tunnel-url.txt
echo "$URL"
