#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for f in "$DIR/run/tunnel.pid" "$DIR/run/server.pid"; do
  [[ -f "$f" ]] && pid=$(cat "$f") && kill "$pid" 2>/dev/null && rm -f "$f"
done
echo stopped
