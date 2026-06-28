// sw.js — platform-agnostic asset cache for Renewal Rush.
//
// Why this exists: the game pulls ~40-50 MB of expensive media on first load
// (2K PBR textures, the HDR sky, GLB models, the Havok .wasm). HTTP cache
// headers would handle returning visits too, but those are host-specific
// (netlify.toml / vercel.json / nginx / S3 all differ). This service worker
// runs on the CLIENT, so it caches identically no matter where the static
// build is deployed — Netlify, Vercel, Cloudflare Pages, a plain bucket.
//
// Strategy: CacheFirst for heavy, immutable media only. First visit downloads
// normally (and we stash each response); every later visit serves them straight
// from the device's Cache Storage with zero network. HTML/JS/CSS are left to
// the network + the host's own headers (the JS bundle is content-hashed by
// Vite, so it busts itself; we don't want a SW pinning a stale bundle).
//
// Busting the media cache: these filenames are NOT content-hashed (they live in
// public/), so if you ship an updated texture/model, bump CACHE_VERSION below —
// activate() then drops every old cache on the next load.

const CACHE_VERSION = "v1";
const CACHE_NAME = `rr-assets-${CACHE_VERSION}`;

// Heavy media + the content-hashed JS/CSS bundle. NOT html — index.html must
// revalidate so new deploys land. The js/css are Vite-hashed (URL changes per
// build), so CacheFirst can never pin a stale bundle; sw.js itself is excluded
// below so the worker can always update.
const CACHEABLE = /\.(jpe?g|png|webp|avif|hdr|env|glb|gltf|bin|ktx2|dds|basis|wasm|mp3|ogg|wav|woff2?|js|css)$/i;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  // Same-origin only; skip cross-origin (fonts CDN etc.), non-cacheable types,
  // and the worker script itself (so updates always reach the network).
  if (url.origin !== self.location.origin || url.pathname === "/sw.js" || !CACHEABLE.test(url.pathname)) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      // Cache only full, OK responses — a 206 range chunk or an error must not
      // poison the cache with a partial/failed body.
      if (res.status === 200) cache.put(req, res.clone());
      return res;
    }),
  );
});
