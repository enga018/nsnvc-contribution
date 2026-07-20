// Must be bumped on every deploy that changes index.html/manifest.json —
// this is the only signal that makes the browser treat sw.js as changed and
// install/activate a fresh worker. If it's left stale, already-installed
// PWAs keep serving whatever was cached under the old name indefinitely
// (this has silently happened before: see the v1.25.6 and v1.28.0 fixes).
const CACHE_NAME = 'nsnvc-tracker-v1.29.13';
const urlsToCache = [
  './',
  './index.html',
  './manifest.json'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(urlsToCache))
  );
});

// Same-origin URLs precached at install — resolved against this file's own
// location so they match regardless of the repo's GitHub Pages subpath.
const APP_SHELL_PATHS = new Set(urlsToCache.map(u => new URL(u, self.location).pathname));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const isAppShell = event.request.method === 'GET' &&
    url.origin === self.location.origin &&
    APP_SHELL_PATHS.has(url.pathname);
  // Everything else (Firebase/Firestore, the xlsx CDN script, icons — none
  // of which are precached above) is left to the browser's normal network
  // handling; it was never intentionally cached before either.
  if (!isAppShell) return;

  // Stale-while-revalidate: answer instantly from cache (fast, works
  // offline on patchy connections — see README), but always also refetch
  // in the background and update the cache for next time. A pure
  // cache-first strategy meant this app shell could go stale under the
  // *same* CACHE_NAME indefinitely unless someone remembered to bump the
  // version string; this self-heals within one extra reopen instead.
  event.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(event.request).then(cached => {
        const network = fetch(event.request).then(response => {
          if (response && response.ok) cache.put(event.request, response.clone());
          return response;
        }).catch(() => cached);
        return cached || network;
      })
    )
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    Promise.all([
      clients.claim(),
      caches.keys().then(cacheNames => {
        return Promise.all(
          cacheNames.map(cacheName => {
            if (cacheName !== CACHE_NAME) {
              return caches.delete(cacheName);
            }
          })
        );
      })
    ])
  );
});
