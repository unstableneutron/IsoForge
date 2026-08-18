const CACHE_NAME = 'isoforge-shell-v2';

// Get the base path from the service worker's location
const swPath = self.location.pathname;
const basePath = swPath.substring(0, swPath.lastIndexOf('/') + 1);

const urlsToCache = [
  basePath,
  `${basePath}manifest.json`,
  `${basePath}favicon.ico`,
  `${basePath}logo192.png`,
  `${basePath}logo512.png`
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || ['/api/', '/mcp', '/ws/'].some(path => url.pathname.startsWith(path))) return;

  // Navigations are network-first so a new celld deployment is visible
  // immediately. Content-hashed build assets remain safe to serve cache-first.
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request)
      .then(response => {
        if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()));
        return response;
      })
      .catch(() => caches.match(event.request).then(response => response || caches.match(basePath))));
    return;
  }

  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    if (response.ok && response.type === 'basic') {
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, response.clone()));
    }
    return response;
  })));
});

self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];

  event.waitUntil(Promise.all([
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName);
          }
        })
      );
    }),
    self.clients.claim()
  ]));
});
