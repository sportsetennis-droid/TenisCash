// =====================================================================
// TenisCash Service Worker — recebe push e mostra notificação
// =====================================================================

self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

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
