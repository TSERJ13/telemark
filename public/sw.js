const CACHE_NAME = 'telemark-v2';
const ASSETS = [
  '/judge.html',
  '/logo_telemark.png',
  '/logo_telemark_512.png',
  '/manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Try network first, fallback to cache for static assets or offline support
  if (e.request.method === 'GET') {
    e.respondWith(
      fetch(e.request).catch(() => {
        return caches.match(e.request);
      })
    );
  }
});
