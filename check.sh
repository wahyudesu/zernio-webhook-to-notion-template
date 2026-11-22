#!/usr/bin/env bash
# Health check used by the maintenance routine. Exit 0 = healthy, 1 = problem.
# Prints one JSON line.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PID="$(cat run/server.pid 2>/dev/null || true)"
UP="no"; [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null && UP="yes"

LOCAL="$(curl -sf -m 5 http://127.0.0.1:8787/health 2>/dev/null || echo '')"
URL="$(cat data/tunnel-url.txt 2>/dev/null || true)"
REMOTE=""
if [[ -n "$URL" ]]; then
  REMOTE="$(curl -sf -m 10 "$URL/health" 2>/dev/null || echo '')"
fi

node_ok="no"; command -v node >/dev/null 2>&1 && node_ok="yes"
tunnel_up="no"; [[ -n "$REMOTE" ]] && tunnel_up="yes"
ok="no"; [[ "$UP" == "yes" && -n "$LOCAL" && -n "$REMOTE" ]] && ok="yes"

printf '{"ok":"%s","server_process":"%s","local_health":%s,"tunnel_url":"%s","tunnel_health":%s,"node":"%s"}\n' \
  "$ok" "$UP" "${LOCAL:-null}" "$URL" "${REMOTE:-null}" "$node_ok"

[[ "$ok" == "yes" ]]
