// MTL Lab Inventory — Service Worker for offline support
const CACHE_NAME = 'mtl-inventory-v7';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './styles.css',
  './js/app.js',
  './js/data.js',
  './js/firebase-config.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './MBG Logo.png',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500&display=swap',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js'
];

// Install: cache all assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        // Cache assets one by one to handle failures gracefully
        return Promise.allSettled(
          ASSETS_TO_CACHE.map(url => cache.add(url).catch(() => {}))
        );
      })
      .then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: cache-first strategy for app assets, network-first for others
self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  // Skip cross-origin requests that aren't fonts
  const url = new URL(event.request.url);

  // Cache-first for same-origin, font, and Firebase SDK requests
  if (url.origin === self.location.origin || url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com' || url.origin === 'https://www.gstatic.com') {
    event.respondWith(
      caches.match(event.request)
        .then((cached) => {
          if (cached) return cached;
          return fetch(event.request)
            .then((response) => {
              // Cache successful responses
              if (response && response.status === 200) {
                const responseToCache = response.clone();
                caches.open(CACHE_NAME).then((cache) => {
                  cache.put(event.request, responseToCache).catch(() => {});
                });
              }
              return response;
            })
            .catch(() => {
              // If network fails and not cached, return cached index.html as fallback
              return caches.match('./index.html');
            });
        })
    );
  }
});
