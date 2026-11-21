/* Service Worker: Offline-Betrieb, Updates und Klicks auf Benachrichtigungen */
const CACHE = 'fristfuchs-v1.15.0';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'vendor/pdfjs/pdf.min.mjs',
  'vendor/pdfjs/pdf.worker.min.mjs',
];
// Große Bibliotheken ändern sich selten: aus dem Speicher, ohne bei jedem Start zu laden
const CACHE_FIRST = /\/vendor\//;
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', event => {
  // cache: 'reload' umgeht den HTTP-Zwischenspeicher des Browsers,
  // damit eine neue Version nicht versehentlich alte Dateien übernimmt.
  event.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS.map(url => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const key = req.mode === 'navigate' ? 'index.html' : req;

  if (CACHE_FIRST.test(url.pathname)) {
    event.respondWith(caches.match(key).then(hit => hit || fetchAndStore(req, key)));
    return;
  }
  // Netzwerk zuerst: online immer der neueste Stand, offline der gespeicherte
  event.respondWith(
    withTimeout(fetchAndStore(req, key, true), NETWORK_TIMEOUT_MS)
      .catch(() => caches.match(key, { ignoreSearch: req.mode === 'navigate' }))
      .then(res => res || fetch(req))
  );
});

async function fetchAndStore(req, key, noHttpCache = false) {
  const res = await fetch(noHttpCache ? new Request(req, { cache: 'no-cache' }) : req);
  if (res.ok) {
    const cache = await caches.open(CACHE);
    cache.put(key, res.clone());
  }
  return res;
}
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const id = event.notification.data && event.notification.data.id;
  const url = new URL(id ? `./?id=${encodeURIComponent(id)}` : './', self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if ('focus' in client) { client.navigate(url).catch(() => {}); return client.focus(); }
      }
      return self.clients.openWindow(url);
    })
  );
});
