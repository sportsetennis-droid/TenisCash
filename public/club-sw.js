// =====================================================================
// Club Sports & Tennis — Service Worker (push no celular)
// Escopo: /club (cobre /club.html e /clube/...). Não interfere no /sw.js
// do varejo (escopo /). Não faz cache de nada: só recebe e mostra push.
// iOS: push só funciona com o Club instalado na Tela de Início (16.4+).
// =====================================================================

self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', (event) => {
  let p = {};
  try { p = event.data ? event.data.json() : {}; }
  catch (_) { p = { title: 'Club Sports & Tennis', body: event.data ? event.data.text() : '' }; }
  const title = p.title || 'Club Sports & Tennis';
  const options = {
    body: p.body || '',
    icon: '/brand/sports-tennis-icon-192.png',
    badge: '/brand/sports-tennis-icon-192.png',
    tag: p.tag || 'club',
    renotify: true,
    data: { url: p.url || '/club.html#/avisos' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || '/club.html#/avisos';
  const target = new URL(raw, self.location.origin);
  if (target.origin !== self.location.origin) return; // só abre páginas do próprio Club
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      const u = new URL(w.url);
      if (u.pathname === target.pathname && 'focus' in w) {
        try { await w.navigate(target.href); } catch (_) {}
        return w.focus();
      }
    }
    return self.clients.openWindow(target.href);
  })());
});
