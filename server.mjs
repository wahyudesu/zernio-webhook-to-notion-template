// Zernio inbox webhook receiver.
// Verifies X-Zernio-Signature, stores inbox events in SQLite, exposes /health.
// Zero npm dependencies: Node 24 + node:sqlite.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ogImageUrl } from "./og.mjs";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const ENV_FILE = path.join(ROOT, ".env");
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const SECRET = process.env.ZERNIO_WEBHOOK_SECRET || "";
const DB_PATH = process.env.DB_PATH || path.join(ROOT, "data", "inbox.db");
const LOG_DIR = path.join(ROOT, "logs");
const MAX_BODY = 1024 * 1024;
const DOWNSTREAM_URL = process.env.DOWNSTREAM_URL || "";

// Inbox allow-list. Comma-separated usernames, case-insensitive.
// Empty list = allow everything. Set both to require a specific pair.
const allowList = (v) =>
  String(v || "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
const ALLOW_SENDERS = allowList(process.env.ALLOW_SENDER_USERNAMES);
const ALLOW_RECEIVERS = allowList(process.env.ALLOW_RECEIVER_USERNAMES);

// Notion direct sync. The token stays in the OpenBot vault: this file holds only
// the path to it, never the secret itself.
const NOTION_PATH_FILE = path.join(ROOT, "notion-token-path.txt");
const NOTION_VERSION = "2025-09-03";
const NOTION_DS = {
  profile: "3fbe2eb9-50ad-8378-b4da-87714b40cd3f",
  post: "41fe2eb9-50ad-81de-a284-000b4b00b813",
};
function readNotionToken() {
  try {
    const p = fs.readFileSync(NOTION_PATH_FILE, "utf8").trim();
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}
let NOTION_TOKEN = readNotionToken();

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS deliveries (
    event_id    TEXT PRIMARY KEY,
    event_type  TEXT,
    received_at TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'stored'
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id           TEXT PRIMARY KEY,
    account_id   TEXT,
    profile_id   TEXT,
    platform     TEXT,
    status       TEXT,
    updated_at   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT,
    account_id      TEXT,
    profile_id      TEXT,
    platform        TEXT,
    direction       TEXT,
    sender_id       TEXT,
    sender_name     TEXT,
    sender_username TEXT,
    text            TEXT,
    attachments     TEXT,
    event_type      TEXT,
    event_id        TEXT,
    raw             TEXT,
    sent_at         TEXT,
    received_at     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, received_at);
  CREATE TABLE IF NOT EXISTS links (
    id               TEXT PRIMARY KEY,
    event_id         TEXT,
    message_id       TEXT,
    url              TEXT NOT NULL UNIQUE,
    kind             TEXT NOT NULL,
    platform         TEXT,
    suggested_name   TEXT,
    caption          TEXT,
    source           TEXT,
    attachments      TEXT,
    sender_username  TEXT,
    receiver_username TEXT,
    status           TEXT NOT NULL DEFAULT 'pending',
    error            TEXT,
    attempts         INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    synced_at        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_links_status ON links(status, created_at);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`);

// Migrate databases created before caption/source existed.
try { db.exec("ALTER TABLE links ADD COLUMN caption TEXT"); } catch {}
try { db.exec("ALTER TABLE links ADD COLUMN source TEXT"); } catch {}
try { db.exec("ALTER TABLE links ADD COLUMN attachments TEXT"); } catch {}
try { db.exec("ALTER TABLE links ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0"); } catch {}

const now = () => new Date().toISOString();
const setMeta = (k, v) =>
  db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(v));
const getMeta = (k) => db.prepare("SELECT value FROM meta WHERE key=?").get(k)?.value ?? null;

// ---- logging (JSON lines, size-based rotation) ----
let logSize = 0;
const logFile = path.join(LOG_DIR, "app.log");
function rotateIfNeeded() {
  try {
    if (fs.existsSync(logFile)) logSize = fs.statSync(logFile).size;
    if (logSize > 5 * 1024 * 1024) {
      fs.renameSync(logFile, path.join(LOG_DIR, "app.log.1"));
      logSize = 0;
    }
  } catch {}
}
function log(level, msg, extra = {}) {
  rotateIfNeeded();
  const line = JSON.stringify({ ts: now(), level, msg, ...extra }) + "\n";
  try {
    fs.appendFileSync(logFile, line);
    logSize += Buffer.byteLength(line);
  } catch {}
  if (level === "error") process.stderr.write(line);
}

function fail(status, error, detail = "") {
  setMeta("last_error", JSON.stringify({ at: now(), status, error, detail }));
  log("error", error, { status, detail });
  return { status, error, detail };
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, "http://localhost");
  const send = (code, body, type = "application/json") => {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(code, {
      "content-type": type,
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
    });
    res.end(payload);
  };

  try {
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      const h = health();
      return send(h.ok ? 200 : 503, h);
    }

    if (req.method === "POST" && url.pathname === "/webhooks/zernio") {
      if (!SECRET) return send(500, fail(500, "missing_secret", "ZERNIO_WEBHOOK_SECRET not set"));

      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) return send(413, fail(413, "payload_too_large"));
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);

      const signature = String(req.headers["x-zernio-signature"] || "");
      const expected = crypto.createHmac("sha256", SECRET).update(raw).digest("hex");
      const sigBuf = Buffer.from(signature, "utf8");
      const expBuf = Buffer.from(expected, "utf8");
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        return send(401, fail(401, "invalid_signature", `len=${signature.length}`));
      }

      let evt;
      try {
        evt = JSON.parse(raw.toString("utf8"));
      } catch {
        return send(400, fail(400, "invalid_json"));
      }

      const decision = allows(evt);
      const result = store(evt, decision.ok ? "stored" : "filtered");
      if (result.duplicate) {
        log("info", "duplicate_delivery", { event_id: result.event_id });
        return send(200, { ok: true, duplicate: true });
      }
      if (!decision.ok) {
        log("info", "event_filtered", {
          event_id: result.event_id,
          event: evt.event,
          sender: decision.sender,
          receiver: decision.receiver,
          direction: decision.direction,
        });
        return send(200, { ok: true, filtered: true, event_id: result.event_id });
      }
      log("info", "event_stored", { event_id: result.event_id, event: evt.event, ms: Date.now() - started });
      syncPending().catch(() => {});
      return send(200, { ok: true, event_id: result.event_id });
    }

    return send(404, { error: "not_found" });
  } catch (err) {
    return send(500, fail(500, "unhandled", String(err?.stack || err)));
  }
});

// Decide whether an event belongs in the inbox.
// Incoming: sender username must be allowed.
// Outgoing: the account owner replies to an allowed participant, so the
// conversation participant must be allowed. Receiver = the account username.
function allows(evt) {
  const msg = evt.message || {};
  const conv = evt.conversation || {};
  const account = evt.account || {};
  const norm = (v) => String(v || "").trim().toLowerCase().replace(/^@/, "");
  const sender = norm(msg.sender?.username);
  const participant = norm(conv.participantUsername);
  const receiver = norm(account.username);
  const direction = norm(msg.direction) || (evt.event === "conversation.started" ? "incoming" : "");

  if (!ALLOW_SENDERS.length && !ALLOW_RECEIVERS.length) {
    return { ok: true, sender, receiver, direction };
  }
  const senderOk =
    !ALLOW_SENDERS.length ||
    ALLOW_SENDERS.includes(sender) ||
    (direction === "outgoing" && ALLOW_SENDERS.includes(participant));
  const receiverOk = !ALLOW_RECEIVERS.length || ALLOW_RECEIVERS.includes(receiver);
  return { ok: senderOk && receiverOk, sender, receiver, direction };
}

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

// Turn a shared URL into a Notion destination hint.
function classifyLink(raw) {
  let u;
  try {
    u = new URL(raw.replace(/[.,;!?)\]]+$/, ""));
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  let platform = null;
  let kind = "unknown";
  let name = "";

  if (host === "instagram.com" || host === "instagr.am") {
    platform = "Instagram";
    if (["p", "reel", "reels", "tv"].includes(parts[0])) {
      kind = "post";
      name = `Instagram post · ${parts[1] || ""}`;
    } else if (parts.length === 1) {
      kind = "profile";
      name = `@${parts[0].replace(/^@/, "")} · Instagram`;
    }
  } else if (host === "threads.com" || host === "threads.net") {
    platform = "Threads";
    if (parts.includes("post") || parts[0] === "t") {
      kind = "post";
      name = `Threads post · ${parts[parts.length - 1] || ""}`;
    } else if (parts[0]?.startsWith("@")) {
      kind = "profile";
      name = `${parts[0]} · Threads`;
    }
  } else if (host === "tiktok.com") {
    platform = "TikTok";
    if (parts[0]?.startsWith("@") && parts.length === 1) {
      kind = "profile";
      name = `${parts[0]} · TikTok`;
    } else if (parts.includes("video")) {
      kind = "post";
      name = `TikTok video · ${parts[parts.length - 1] || ""}`;
    }
  } else if (host === "youtube.com" || host === "youtu.be") {
    platform = "YouTube";
    if (parts[0] === "watch" || parts[0] === "shorts" || host === "youtu.be") {
      kind = "post";
      name = `YouTube video · ${u.searchParams.get("v") || parts[1] || ""}`;
    } else if (parts[0]?.startsWith("@")) {
      kind = "profile";
      name = `${parts[0]} · YouTube`;
    }
  } else if (host === "linkedin.com") {
    platform = "LinkedIn";
    if (parts[0] === "in") {
      kind = "profile";
      name = `LinkedIn · ${parts[1] || ""}`;
    } else if (parts.includes("posts")) {
      kind = "post";
      name = `LinkedIn post · ${parts[parts.length - 1] || ""}`;
    }
  } else if (host === "x.com" || host === "twitter.com") {
    platform = "X";
    const statusIdx = parts.indexOf("status");
    if (statusIdx !== -1) {
      kind = "post";
      name = `X post · ${parts[statusIdx + 1] || ""}`;
    } else if (parts.length === 1 && parts[0] && parts[0] !== "i") {
      kind = "profile";
      name = `@${parts[0]} · X`;
    }
  }

  return { url: u.toString(), kind, platform, name: name || `${platform || "Link"} · ${host}` };
}

// A bare @username in the DM becomes a profile link. Captions are excluded:
// reel descriptions are full of @mentions that are not profile shares.
function usernameLink(raw, platformHint) {
  const username = String(raw || "").replace(/^@/, "").replace(/[.,;:!?]+$/, "").toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(username)) return null;
  const threads = String(platformHint || "").toLowerCase() === "threads";
  return threads
    ? { url: `https://www.threads.net/@${username}`, kind: "profile", platform: "Threads", name: `@${username} · Threads` }
    : { url: `https://www.instagram.com/${username}/`, kind: "profile", platform: "Instagram", name: `@${username} · Instagram` };
}

function collectLinks(evt, msg, receivedAt) {
  // Zernio often delivers shared posts as attachments with no message text.
  const candidates = [];
  if (typeof msg.text === "string") {
    const accompanying = msg.text.replace(URL_RE, " ").trim();
    for (const match of msg.text.matchAll(URL_RE)) {
      candidates.push({ value: match[0], caption: accompanying || null, source: "text", attachments: [] });
    }
    const withoutUrls = msg.text.replace(URL_RE, " ");
    const usernames = new Set();
    for (const match of withoutUrls.matchAll(/(^|[\s(])@([A-Za-z0-9._]{1,30})/g)) {
      usernames.add(match[2].toLowerCase());
    }
    for (const username of [...usernames].slice(0, 5)) {
      candidates.push({ username, source: "mention", attachments: [] });
    }
  }
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  for (const att of attachments) {
    const caption = att?.payload?.title || att?.title || null;
    const source = att?.originalType || att?.type || "attachment";
    if (att?.url) candidates.push({ value: String(att.url), caption, source, attachments: [att] });
    if (att?.payload?.url && att.payload.url !== att.url) {
      candidates.push({ value: String(att.payload.url), caption, source: "attachment", attachments: [att] });
    }
  }

  const stmt = db.prepare(
    `INSERT INTO links (id,event_id,message_id,url,kind,platform,suggested_name,caption,source,attachments,sender_username,receiver_username,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(url) DO NOTHING`
  );
  let n = 0;
  for (const c of candidates) {
    const info = c.username ? usernameLink(c.username, msg.platform) : classifyLink(c.value);
    if (!info || info.kind === "unknown") continue;
    const r = stmt.run(
      crypto.randomUUID(),
      evt.id || null,
      msg.id || null,
      info.url,
      info.kind,
      info.platform,
      info.name,
      c.caption ? String(c.caption).slice(0, 2000) : null,
      c.source,
      c.attachments?.length ? JSON.stringify(c.attachments) : null,
      msg.sender?.username || null,
      evt.account?.username || null,
      "pending",
      receivedAt
    );
    n += r.changes;
  }
  return n;
}

function store(evt, status = "stored") {
  const eventId = String(evt.id || `missing-${crypto.randomUUID()}`);
  const dup = db.prepare("SELECT 1 AS x FROM deliveries WHERE event_id=?").get(eventId);
  if (dup) return { duplicate: true, event_id: eventId };

  const receivedAt = now();
  const type = String(evt.event || "unknown");
  const msg = evt.message || null;
  const conv = evt.conversation || null;
  const account = evt.account || null;
  const profiles = Array.isArray(evt.profiles) ? evt.profiles : [];
  const profileId = account?.profileId || profiles[0]?.id || null;
  const keep = status === "stored";

  db.exec("BEGIN");
  try {
    if (keep && msg && msg.id) {
      db.prepare(
        `INSERT INTO messages (id, conversation_id, account_id, profile_id, platform, direction,
          sender_id, sender_name, sender_username, text, attachments, event_type, event_id, raw, sent_at, received_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           text=excluded.text, attachments=excluded.attachments, event_type=excluded.event_type,
           event_id=excluded.event_id, raw=excluded.raw, received_at=excluded.received_at`
      ).run(
        String(msg.id),
        msg.conversationId ? String(msg.conversationId) : null,
        account?.accountId || account?.id || null,
        profileId,
        msg.platform || account?.platform || null,
        msg.direction || null,
        msg.sender?.id || null,
        msg.sender?.name || null,
        msg.sender?.username || null,
        msg.text ?? null,
        msg.attachments ? JSON.stringify(msg.attachments) : null,
        type,
        eventId,
        JSON.stringify(evt),
        msg.timestamp || msg.createdAt || evt.timestamp || null,
        receivedAt
      );
    }
    if (keep && msg) collectLinks(evt, msg, receivedAt);
    if (keep && conv && conv.id) {
      db.prepare(
        `INSERT INTO conversations (id, account_id, profile_id, platform, status, updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`
      ).run(
        String(conv.id),
        account?.accountId || account?.id || null,
        profileId,
        account?.platform || null,
        conv.status || null,
        receivedAt
      );
    }
    db.prepare("INSERT INTO deliveries (event_id,event_type,received_at,status) VALUES (?,?,?,?)").run(
      eventId,
      type,
      receivedAt,
      status
    );
    if (keep) setMeta("last_event_at", receivedAt);
    else setMeta("last_filtered_at", receivedAt);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  if (keep && DOWNSTREAM_URL) forward(evt).catch(() => {});
  return { duplicate: false, event_id: eventId };
}

// Optional: POST the raw event to another API. Off unless DOWNSTREAM_URL is set.
async function forward(evt, attempt = 1) {
  try {
    const r = await fetch(DOWNSTREAM_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-source": "zernio-webhook",
        ...(process.env.DOWNSTREAM_TOKEN ? { authorization: `Bearer ${process.env.DOWNSTREAM_TOKEN}` } : {}),
      },
      body: JSON.stringify(evt),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`downstream ${r.status}`);
    log("info", "downstream_ok", { event_id: evt.id });
  } catch (e) {
    log("error", "downstream_failed", { event_id: evt.id, attempt, error: String(e) });
    setMeta("last_error", JSON.stringify({ at: now(), status: 502, error: "downstream_failed", detail: String(e) }));
    if (attempt < 5) setTimeout(() => forward(evt, attempt + 1), 1000 * 2 ** attempt);
  }
}

// ---- Notion direct sync (no OpenBot routine needed) ----
const NOTION_PLATFORMS = ["Instagram", "Threads", "TikTok", "YouTube", "LinkedIn", "X", "Lainnya"];
const notionPlatform = (p) => (NOTION_PLATFORMS.includes(p) ? p : "Lainnya");
const richText = (s) => ({ rich_text: [{ text: { content: String(s || "").slice(0, 2000) } }] });
const titleText = (s) => ({ title: [{ text: { content: String(s || "").slice(0, 200) } }] });
const select = (name) => ({ select: { name } });
const multi = (names) => ({ multi_select: names.map((name) => ({ name })) });
const paragraph = (s) => ({
  object: "block",
  type: "paragraph",
  paragraph: { rich_text: [{ text: { content: String(s || "").slice(0, 2000) } }] },
});
const embed = (url) => ({
  object: "block",
  type: "embed",
  embed: { url: String(url).slice(0, 2000) },
});

function attachmentList(raw) {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((a) => a && a.url) : [];
  } catch {
    return [];
  }
}

// The Zernio payload has no author field. Only URL shapes that carry an
// explicit username can fill the Creator relation; Instagram reels cannot.
function authorFromUrl(link, platform) {
  try {
    const u = new URL(link.url);
    const parts = u.pathname.split("/").filter(Boolean);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (platform === "X" || host === "x.com" || host === "twitter.com") {
      const si = parts.indexOf("status");
      if (si > 0 && parts[si - 1] && parts[si - 1] !== "i") return parts[si - 1];
    }
    if ((platform === "Threads" || host === "threads.net" || host === "threads.com") && parts[0]?.startsWith("@")) return parts[0];
    if (platform === "TikTok" && parts[0]?.startsWith("@")) return parts[0];
    if (platform === "YouTube" && parts[0]?.startsWith("@")) return parts[0];
    return null;
  } catch {
    return null;
  }
}

function creatorProfileUrl(author, platform) {
  const base = {
    X: `https://x.com/${author}`,
    Threads: `https://www.threads.net/${author}`,
    TikTok: `https://www.tiktok.com/${author}`,
    YouTube: `https://www.youtube.com/${author}`,
  };
  return base[platform] || null;
}

async function findOrCreateCreator(link, platform) {
  const author = authorFromUrl(link, platform);
  if (!author) return null;
  const profileUrl = creatorProfileUrl(author, platform);
  if (!profileUrl) return null;
  const headers = {
    authorization: `Bearer ${NOTION_TOKEN}`,
    "content-type": "application/json",
    "Notion-Version": NOTION_VERSION,
  };
  const q = await fetch(`https://api.notion.com/v1/data_sources/${NOTION_DS.profile}/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      filter: {
        or: [
          { property: "Profile URL", url: { contains: `/${author}` } },
          { property: "Name", title: { contains: `@${author}` } },
        ],
      },
      page_size: 10,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (q.ok) {
    const qb = await q.json().catch(() => ({}));
    if (qb.results?.length) return qb.results[0].id;
  }
  const c = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers,
    body: JSON.stringify({
      parent: { type: "data_source_id", data_source_id: NOTION_DS.profile },
      properties: {
        Name: titleText(`@${author} · ${platform}`),
        Platform: select(platform),
        Kategori: select("Creator"),
        "Profile URL": { url: profileUrl },
        Sumber: select("Webhook DM"),
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const cb = await c.json().catch(() => ({}));
  if (!c.ok) throw new Error(`notion creator ${c.status}: ${cb?.message || ""}`.slice(0, 300));
  log("info", "notion_creator_created", { author, page_id: cb.id });
  return cb.id;
}

async function notionBody(link) {
  const platform = notionPlatform(link.platform);
  const children = [];
  if (link.caption) children.push(paragraph(link.caption));
  for (const att of attachmentList(link.attachments)) {
    children.push(paragraph(`Lampiran · ${att.originalType || att.type || "attachment"}`));
    children.push(embed(att.url));
  }

  if (link.kind === "profile") {
    return {
      parent: { type: "data_source_id", data_source_id: NOTION_DS.profile },
      properties: {
        Name: titleText(link.suggested_name),
        Platform: select(platform),
        Kategori: select("Creator"),
        Tag: multi(["DM", platform]),
        "Profile URL": { url: link.url },
        Sumber: select("Webhook DM"),
      },
      children,
    };
  }
  const postOn = Array.from(new Set((link.caption || "").split(/[^A-Za-z]+/).map((w) => w.trim()).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).filter((w) => NOTION_PLATFORMS.includes(w))));
  let creatorId = null;
  try {
    creatorId = await findOrCreateCreator(link, platform);
  } catch (e) {
    log("error", "notion_creator_lookup_failed", { link_id: link.id, error: String(e?.message || e).slice(0, 300) });
  }
  // Link-only cover: Notion stores an external file URL, not an uploaded image.
  const cover = await ogImageUrl(link.url);
  return {
    parent: { type: "data_source_id", data_source_id: NOTION_DS.post },
    properties: {
      Name: titleText(link.suggested_name),
      "Post URL": { url: link.url },
      Platform: select(platform),
      Status: { status: { name: "Inbox" } },
      ...(cover ? { "Files & media": { files: [{ name: "Cover", type: "external", external: { url: cover } }] } } : {}),
      ...(creatorId ? { Creator: { relation: [{ id: creatorId }] } } : {}),
      ...(postOn.length ? { "Post on": multi(postOn) } : {}),
    },
    children,
  };
}

let syncing = false;
async function syncPending() {
  NOTION_TOKEN = NOTION_TOKEN || readNotionToken();
  if (!NOTION_TOKEN || syncing) return;
  const rows = db
    .prepare("SELECT * FROM links WHERE status='pending' ORDER BY created_at LIMIT 20")
    .all();
  if (!rows.length) return;
  syncing = true;
  try {
    for (const link of rows) {
      try {
        const r = await fetch("https://api.notion.com/v1/pages", {
          method: "POST",
          headers: {
            authorization: `Bearer ${NOTION_TOKEN}`,
            "content-type": "application/json",
            "Notion-Version": NOTION_VERSION,
          },
          body: JSON.stringify(await notionBody(link)),
          signal: AbortSignal.timeout(15000),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(`notion ${r.status}: ${body?.message || ""}`.slice(0, 400));
        db.prepare("UPDATE links SET status='synced', error=NULL, synced_at=? WHERE id=?").run(now(), link.id);
        log("info", "notion_synced", { link_id: link.id, page_id: body.id, kind: link.kind });
      } catch (e) {
        const msg = String(e?.message || e).slice(0, 400);
        const attempts = (link.attempts || 0) + 1;
        const status = attempts >= 5 ? "failed" : "pending";
        db.prepare("UPDATE links SET status=?, error=?, attempts=?, synced_at=? WHERE id=?").run(
          status,
          msg,
          attempts,
          now(),
          link.id
        );
        log("error", "notion_sync_failed", { link_id: link.id, attempts, error: msg });
      }
    }
  } finally {
    syncing = false;
  }
}

function health() {
  const out = { ok: true, service: "zernio-webhook", now: now(), checks: {}, stats: {} };
  try {
    const one = db.prepare("SELECT 1 AS x").get();
    out.checks.db = one?.x === 1 ? "ok" : "fail";
  } catch (e) {
    out.checks.db = "fail";
    out.error = String(e);
  }
  out.checks.secret_configured = Boolean(SECRET);
  out.checks.notion_direct = NOTION_TOKEN ? "ok" : "disabled";
  out.filters = {
    senders: ALLOW_SENDERS,
    receivers: ALLOW_RECEIVERS,
    active: Boolean(ALLOW_SENDERS.length || ALLOW_RECEIVERS.length),
  };
  if (!SECRET) out.ok = false;

  try {
    const c = (sql, ...p) => db.prepare(sql).get(...p);
    out.stats.messages = c("SELECT COUNT(*) AS n FROM messages").n;
    out.stats.events = c("SELECT COUNT(*) AS n FROM deliveries").n;
    out.stats.filtered = c("SELECT COUNT(*) AS n FROM deliveries WHERE status='filtered'").n;
    out.stats.links_pending = c("SELECT COUNT(*) AS n FROM links WHERE status='pending'").n;
    out.stats.links_failed = c("SELECT COUNT(*) AS n FROM links WHERE status='failed'").n;
    out.stats.links_total = c("SELECT COUNT(*) AS n FROM links").n;
    out.stats.events_24h = c("SELECT COUNT(*) AS n FROM deliveries WHERE received_at >= ?", new Date(Date.now() - 864e5).toISOString()).n;
    out.stats.last_event_at = getMeta("last_event_at");
    out.stats.last_filtered_at = getMeta("last_filtered_at");
    const le = getMeta("last_error");
    out.stats.last_error = le ? JSON.parse(le) : null;
  } catch (e) {
    out.ok = false;
    out.checks.queries = "fail";
  }
  out.uptime_seconds = Math.round(process.uptime());
  return out;
}

server.listen(PORT, HOST, () => {
  log("info", "listening", { host: HOST, port: PORT, db: DB_PATH });
  console.log(`zernio-webhook listening on http://${HOST}:${PORT}`);
  if (NOTION_TOKEN) {
    setInterval(() => syncPending().catch(() => {}), 60_000).unref();
    syncPending().catch(() => {});
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log("info", "shutdown", { sig });
    server.close(() => {
      try { db.close(); } catch {}
      process.exit(0);
    });
  });
}
