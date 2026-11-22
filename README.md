# Zernio webhook → SQLite → Notion

A dependency-free Node template that receives Zernio inbox webhooks, verifies the
`X-Zernio-Signature` HMAC, stores allowed conversations in SQLite, extracts shared
links, and syncs them into Notion. The public endpoint can be exposed with a
Cloudflare quick tunnel.

## Quick start

Requirements: Node 24+ (`node:sqlite`) and `cloudflared` on `PATH`. Bundled copies
in `runtime/bin/node` and `bin/cloudflared` are used automatically when present.

```bash
cp .env.example .env                      # fill in your secret and usernames
cp notion-token-path.example.txt notion-token-path.txt
./run.sh                                 # starts server + tunnel, prints the URL
./check.sh                               # one-line JSON health report; exit 0 = healthy
./stop.sh                                # stop both processes
./links.sh pending                       # JSON array of links waiting for Notion
```

Register `https://<tunnel-url>/webhooks/zernio` in Zernio with the same signing
secret. `run.sh` creates a new quick-tunnel URL each time, so re-register the URL
after every restart. Keep your own `data/registered-url.txt` if you automate this.

## Notion setup

Edit the two data-source IDs in `server.mjs` (`NOTION_DS.profile` and
`NOTION_DS.post`) to match your workspace. The integration needs edit access to
both databases.

- Profile links go to a contacts database with Name, Platform, Kategori, Tag,
  Profile URL and Sumber properties.
- Post links go to a post database with Name, Post URL, Platform, Status,
  Files & media and Creator properties.
- Creators are linked from the author in the URL (`x.com/<user>/status/…`,
  Threads, TikTok, YouTube). Instagram reels carry no author in the payload, so
  their Creator stays empty.
- `Catatan`, `Kategori` and `Tag` on posts are intentionally left empty. No
  "Dari DM … ke …" line is written to the page body.
- Each post stores the link's `og:image` (or `twitter:image`) **only as an
  external URL** in `Files & media`. It is never uploaded and never set as a page
  cover, so it costs no Notion media storage. Images over 5 MB are rejected; a
  smaller variant is tried first (X `large → medium → small`, Instagram
  `s640x640 → s320x320`).

The Notion token is read from the file whose path is in `notion-token-path.txt`;
keep that file and the token out of git.

## Endpoints

- `POST /webhooks/zernio` — signature-verified webhook receiver.
- `GET /health` — health JSON with DB checks and sync stats.

## Files

| Path | Purpose |
|---|---|
| `server.mjs` | HTTP server, SQLite storage, link extraction, Notion sync |
| `og.mjs` | og:image extraction with a 5 MB size guard |
| `.env.example` | configuration template |
| `check.sh`, `run.sh`, `stop.sh`, `links.sh` | operations scripts |
| `test-local.mjs` | local signed-event smoke test |

Generated at runtime and gitignored: `.env`, `notion-token-path.txt`, `data/`,
`logs/`, `run/`.

## Security

Never commit `.env`, the Notion token, webhook signatures, or runtime data.
The allow-list in `.env` controls which DM conversations are stored.
