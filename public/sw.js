/*
 * StudyOS service worker — minimal offline app shell.
 *
 * Strategy:
 *  - Navigations: network-first, fall back to the cached shell when offline.
 *    This keeps deploys fresh (users always get the new index.html when online)
 *    while still booting the app offline.
 *  - Hashed build assets (/assets/*): cache-first. Filenames are
 *    content-hashed, so a cached entry is immutable and always correct.
 *  - /api/* and Supabase endpoints: never cached — always the network.
 *  - Icons/manifest: stale-while-revalidate.
 *
 * Bump CACHE_VERSION whenever the shell strategy itself changes (not needed
 * for normal deploys — hashed asset names change on their own).
 */
const CACHE_VERSION = 'studyos-shell-v1';
const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase etc. — never intercepted
  if (url.pathname.startsWith('/api/')) return; // API — always live

  // Hashed build assets: immutable → cache-first.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }))
    );
    return;
  }

  // Navigations: network-first with cached shell fallback (offline boot).
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put('/index.html', copy));
          }
          return res;
        })
        .catch(() => caches.match('/index.html').then((hit) => hit || Response.error()))
    );
    return;
  }

  // Everything else (icons, manifest): stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((hit) => {
      const refresh = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || refresh;
    })
  );
});
