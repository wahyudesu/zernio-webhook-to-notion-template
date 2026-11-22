#!/usr/bin/env bash
# Link queue helper for the Notion sync routine.
#   ./links.sh pending              -> JSON array of pending links
#   ./links.sh mark synced ID [ID]  -> mark links as synced (or ignored/failed)
#   ./links.sh fail ID 'error msg'  -> mark one link as failed with an error
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
ACTION="${1:-pending}"
shift || true
NODE="$DIR/runtime/bin/node"; [[ -x "$NODE" ]] || NODE="node"
exec "$NODE" - "$ACTION" "$@" <<'NODE'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("data/inbox.db");
const [action, ...args] = process.argv.slice(2);
if (action === "pending") {
  console.log(JSON.stringify(db.prepare("SELECT id, kind, platform, suggested_name, url, sender_username, receiver_username, created_at FROM links WHERE status='pending' ORDER BY created_at").all()));
} else if (action === "mark") {
  const [status, ...ids] = args;
  if (!["synced", "ignored", "failed"].includes(status) || !ids.length) {
    console.error("usage: links.sh mark synced|ignored|failed ID [ID]");
    process.exit(2);
  }
  const stmt = db.prepare(`UPDATE links SET status=?, synced_at=? WHERE id=? AND status='pending'`);
  let n = 0;
  for (const id of ids) n += stmt.run(status, new Date().toISOString(), id).changes;
  console.log(`marked ${n} link(s) as ${status}`);
} else if (action === "fail") {
  const [id, error] = args;
  if (!id) { console.error("usage: links.sh fail ID 'error'"); process.exit(2); }
  const r = db.prepare("UPDATE links SET status='failed', error=?, synced_at=? WHERE id=? AND status='pending'").run(String(error || "error").slice(0, 500), new Date().toISOString(), id);
  console.log(`marked ${r.changes} link(s) as failed`);
} else {
  console.error("unknown action");
  process.exit(2);
}
NODE
