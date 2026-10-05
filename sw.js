// Bump this cache version on every deploy that changes index.html/manifest.json —
// this is the only signal that makes the browser treat sw.js as changed and
// install/activate a fresh worker. If it's left stale, already-installed
// PWAs keep serving whatever was cached under the old name indefinitely
// (this has silently happened before: see the v1.25.6 and v1.28.0 fixes).
const CACHE_NAME = 'nsnvc-tracker-v1.35.9';
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './ledger.js',
  './store.js',
  './util.js',
  './cache.js',
  './state.js',
  './firebase.js'
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

  // Network-first: always use the current deployed app shell when online.
  // The previous stale-while-revalidate strategy returned the cached HTML/JS
  // immediately, so a normal browser session could keep running an older app
  // even after a new service worker had been deployed. Cache is only the
  // offline fallback now.
  event.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      fetch(event.request).then(response => {
        if (response && response.ok) cache.put(event.request, response.clone());
        return response;
      }).catch(() => cache.match(event.request))
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
