// =====================================================================
// TenisCash Service Worker — recebe push e mostra notificação
// =====================================================================

// Cache only the public scanner shell. Never cache APIs, authentication,
// catalogue photos, captured photographs or other application pages.
const SCANNER_CACHE = 'teniscash-scanner-shell-20261109-parallel-1';
const SCANNER_SHELL = [
  '/bipar.html', '/scanner-barcode-policy.js?v=20261109-parallel-1',
  '/scanner-confirm.js?v=20260915-resume-2', '/scanner-view.js?v=20261018-recent-reads-1',
  '/scanner-camera.js?v=20261018-live-fast-2', '/scanner-round.js?v=20261109-replacement-1',
  '/bipar-transfer.js?v=20261002-actions-1', '/scanner-photo-storage.js?v=20261109-parallel-1',
  '/scan-action-photos.js?v=20261109-archive-1', '/bipar-actions.js?v=20261109-mobile-durable-1',
  '/vendor/barcode/zxing-reader-3.1.4.js', '/scanner-auto.js?v=20261109-parallel-1',
  '/scanner-regions.js?v=20260914-worker-1', '/scanner-ocr.js?v=20261109-parallel-1',
];
const SCANNER_ALLOWED = new Set(SCANNER_SHELL.map(path => path.split('?')[0]).concat([
  '/scanner-barcode-worker.js', '/vendor/barcode/zxing_reader.wasm',
  '/vendor/ocr/tesseract.min.js', '/vendor/ocr/worker.min.js', '/vendor/ocr/eng.traineddata.gz',
  '/vendor/ocr/tesseract-core-lstm.wasm.js', '/vendor/ocr/tesseract-core-simd-lstm.wasm.js',
  '/vendor/ocr/tesseract-core-relaxedsimd-lstm.wasm.js',
]));
function scannerCacheRequest(request) {
  const url = new URL(request.url);
  const allowedQuery = url.pathname === '/bipar.html' ? ['v', 'mode', 'storeId'] : ['v'];
  if (request.method !== 'GET' || url.origin !== self.location.origin || !SCANNER_ALLOWED.has(url.pathname) ||
      request.headers.has('authorization') || [...url.searchParams.keys()].some(key => !allowedQuery.includes(key))) return null;
  // Store/mode belong to the URL and original local events, never a cached context.
  if (url.pathname === '/bipar.html') return new URL('/bipar.html', self.location.origin).href;
  return url.href;
}
self.addEventListener('install', event => {
  // Do not skipWaiting: an update must not replace the worker of an active
  // scanning session. A first installation still becomes active normally.
  // Offline caching is optional; quota/network failure must not disable push.
  event.waitUntil(caches.open(SCANNER_CACHE).then(cache => cache.addAll(SCANNER_SHELL)).catch(() => {}));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Preserve a previously usable offline shell if the new precache failed.
    try {
      const cache = await caches.open(SCANNER_CACHE);
      const complete = (await Promise.all(SCANNER_SHELL.map(path => cache.match(path)))).every(Boolean);
      if (complete) for (const key of await caches.keys()) if (key.startsWith('teniscash-scanner-shell-') && key !== SCANNER_CACHE) await caches.delete(key);
    } catch (_) {}
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const key = scannerCacheRequest(event.request);
  if (!key) return;
  event.respondWith((async () => {
    let cache;
    try { cache = await caches.open(SCANNER_CACHE); } catch (_) { return fetch(event.request); }
    try {
      const response = await fetch(event.request);
      if (!response.ok || response.redirected || response.type === 'opaque') throw Error('Scanner shell unavailable');
      // Keep the HTML installed with this complete shell. An active older
      // worker may receive a new deployment's HTML before its scripts arrive;
      // caching that response would break the previous offline fallback.
      // Online navigation still receives the fresh response below.
      // Cache quota failure must not turn a successful network read into error.
      if (new URL(event.request.url).pathname !== '/bipar.html') {
        try { await cache.put(key, response.clone()); } catch (_) {}
      }
      return response;
    } catch (error) {
      const saved = await cache.match(key);
      if (saved) return saved;
      for (const name of await caches.keys()) {
        if (!name.startsWith('teniscash-scanner-shell-') || name === SCANNER_CACHE) continue;
        const previous = await (await caches.open(name)).match(key);
        if (previous) return previous;
      }
      throw error;
    }
  })());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch { payload = { title: 'TenisCash', body: event.data ? event.data.text() : '' }; }

  const title = payload.title || 'TenisCash';
  const options = {
    body: payload.body || '',
    icon: '/icon-192.svg',
    badge: '/icon-192.svg',
    tag: payload.tag || 'tc-msg',
    data: { url: payload.url || '/app.html' },
    requireInteraction: false,
    renotify: true,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/app.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // aviso de torneio/treino: reaproveita a aba do /torneios.html e leva pro link
      if (url.includes('/torneios.html')) {
        for (const c of clients) {
          if (c.url.includes('/torneios.html')) {
            return c.focus().then((w) => (w && w.navigate ? w.navigate(url) : w)).catch(() => self.clients.openWindow(url));
          }
        }
        return self.clients.openWindow(url);
      }
      // se já tem aba aberta do app, foca nela
      for (const c of clients) {
        if (c.url.includes('/app.html') || c.url.includes('/mensagens.html')) {
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
