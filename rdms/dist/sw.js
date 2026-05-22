/**
 * SDBA RDMS — Service Worker
 * Cache-first strategy for app shell. All data is in IndexedDB.
 */
// Bump this when changing SW logic so the activate handler evicts the
// previous cache wholesale. The cache-first read path keys on this name,
// so a new value = a guaranteed-clean cache on next load.
const CACHE_NAME = 'rdms-v2';

// Install: skip precache (Vite hashes filenames), cache on first fetch instead
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Helper: a response is cache-worthy only if it actually succeeded.
// `basic` filters out opaque cross-origin responses we don't want to cache
// for same-origin requests (a stray redirect or CORS error response can
// look like success but contain HTML/error text that breaks CSS / JS).
function isCacheable(response) {
  if (!response) return false;
  if (!response.ok) return false;              // 4xx / 5xx
  if (response.status === 0) return false;     // opaque
  if (response.type === 'opaque') return false; // cross-origin no-cors
  return true;
}

// Fetch: cache-first for same-origin, network-first for external (fonts, icons).
// Critical invariant: we NEVER cache a non-ok response. This is what kept
// poisoning the dev experience — a 404 served while Vite was reloading would
// stick around in the cache and the next load returned unstyled HTML.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Skip HMR / dev-only requests — Vite's `@vite/client` etc. should never
  // be intercepted. They're identified by the `@` segment in the path.
  if (url.pathname.startsWith('/@') || url.pathname.includes('/node_modules/')) return;

  // External resources (Google Fonts, etc.): network-first with cache fallback
  if (url.origin !== self.location.origin) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (isCacheable(response)) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Same-origin: cache-first, but only write to the cache on a clean 2xx.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (isCacheable(response)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
