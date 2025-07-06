// Service Worker
const CACHE_VERSION = "v1.0.0";
const CACHE_NAME = `traffic-map-${CACHE_VERSION}`;

// キャッシュ対象
const STATIC_CACHE_URLS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/app.js",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png",
];

const EXTERNAL_CACHE_URLS = [
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://unpkg.com/supercluster@8.0.1/dist/supercluster.min.js",
  "https://unpkg.com/@turf/turf@6/turf.min.js",
  "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.11.0/dist/tf.min.js",
];

// インストール
self.addEventListener("install", (event) => {
  console.log("[ServiceWorker] Install");

  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => {
        console.log("[ServiceWorker] Caching static assets");

        const staticPromises = STATIC_CACHE_URLS.map((url) =>
          cache
            .add(url)
            .catch((err) => console.error(`Failed to cache ${url}:`, err))
        );

        const externalPromises = EXTERNAL_CACHE_URLS.map((url) =>
          fetch(url)
            .then((response) => {
              if (response.ok) {
                return cache.put(url, response);
              }
            })
            .catch((err) =>
              console.error(`Failed to cache external ${url}:`, err)
            )
        );

        return Promise.all([...staticPromises, ...externalPromises]);
      })
      .then(() => self.skipWaiting())
  );
});

// アクティベート
self.addEventListener("activate", (event) => {
  console.log("[ServiceWorker] Activate");

  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheName !== CACHE_NAME) {
              console.log("[ServiceWorker] Deleting old cache:", cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => self.clients.claim())
  );
});

// フェッチ
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // APIリクエストはネットワーク優先
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // 地理院タイルはネットワーク優先
  if (url.hostname === "cyberjapandata.gsi.go.jp") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, responseClone);
            });
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // その他はキャッシュ優先
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        // バックグラウンドで更新
        fetch(request).then((response) => {
          if (response.ok) {
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(request, response);
            });
          }
        });
        return cachedResponse;
      }

      return fetch(request).then((response) => {
        if (response.ok) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseClone);
          });
        }
        return response;
      });
    })
  );
});

// バックグラウンド同期
self.addEventListener("sync", (event) => {
  if (event.tag === "sync-traffic-data") {
    console.log("[ServiceWorker] Syncing traffic data");
    event.waitUntil(syncTrafficData());
  }
});

async function syncTrafficData() {
  // 実装省略
  console.log("[ServiceWorker] Background sync completed");
}
