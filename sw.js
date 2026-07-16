// Must be bumped on every deploy that changes index.html/manifest.json —
// this is the only signal that makes the browser treat sw.js as changed and
// install/activate a fresh worker. If it's left stale, already-installed
// PWAs keep serving whatever was cached under the old name indefinitely
// (this has silently happened before: see the v1.25.6 and v1.28.0 fixes).
const CACHE_NAME = 'nsnvc-tracker-v1.29.10';
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

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          return response;
        }
        return fetch(event.request);
      })
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
