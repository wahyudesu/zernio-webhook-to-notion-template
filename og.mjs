// Extract a link's Open Graph image as a URL only. Nothing is uploaded to
// Notion; images over 5 MB are rejected (a smaller variant is tried first).
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const decodeEntities = (s) =>
  s
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");

const META_PATTERNS = [
  /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*>/i,
  /<meta[^>]+name=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["'][^>]*>/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+name=["'](?:og:image|twitter:image)["'][^>]*>/i,
];

async function imageBytes(url, timeoutMs) {
  try {
    const head = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    const n = Number(head.headers.get("content-length"));
    if (head.ok && Number.isFinite(n) && n > 0) return n;
    const range = await fetch(url, { headers: { range: "bytes=0-0" }, signal: AbortSignal.timeout(timeoutMs) });
    const m = /bytes\s+0-0\/(\d+)/i.exec(range.headers.get("content-range") || "");
    if (m) return Number(m[1]);
    // No advertised size: stream until the limit, without keeping the bytes.
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok || !res.body) return null;
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > MAX_IMAGE_BYTES) return total;
    }
    return total;
  } catch {
    return null;
  }
}

function variants(url) {
  const list = [url];
  if (url.includes("pbs.twimg.com/")) {
    list.push(url.replace(/name=large/, "name=medium"));
    list.push(url.replace(/name=(large|medium)/, "name=small"));
  }
  const size = url.match(/_s\d+x\d+_/);
  if (size) list.push(url.replace(size[0], "_s320x320_"));
  return [...new Set(list)];
}

export async function ogImageUrl(url, timeoutMs = 8000) {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const res = await fetch(u, {
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0", accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok || !/html/i.test(res.headers.get("content-type") || "")) return null;
    const html = (await res.text()).slice(0, 600000);
    for (const re of META_PATTERNS) {
      const m = html.match(re);
      if (!m) continue;
      let candidate = decodeEntities(m[1]).trim();
      if (!candidate) continue;
      try {
        candidate = new URL(candidate, u).toString();
      } catch {
        continue;
      }
      if (!/^https?:$/.test(new URL(candidate).protocol)) continue;
      for (const v of variants(candidate)) {
        const bytes = await imageBytes(v, timeoutMs);
        if (bytes !== null && bytes <= MAX_IMAGE_BYTES) return v.slice(0, 2000);
      }
    }
    return null;
  } catch {
    return null;
  }
}
