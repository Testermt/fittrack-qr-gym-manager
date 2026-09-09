const CACHE_NAME = 'neofit-gym-v2'; // Jab bhi bada update karo, ise v3, v4 kar dena[span_1](start_span)[span_1](end_span)
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/admin.html',
  '/manifest.json'
];

// Install Event - Caching core assets[span_2](start_span)[span_2](end_span)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// Activate Event - Clean up old caches[span_3](start_span)[span_3](end_span)
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch Event - Network First (Hamesha fresh code laayega, offline hone par cache chalega)
self.addEventListener('fetch', (event) => {
  // Skip cross-origin requests like Firebase or CDN scripts
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        return networkResponse;
      })
      .catch(() => {
        // Agar internet nahi hai ya offline hain, tab cache se serve karega
        return caches.match(event.request);
      })
  );
});