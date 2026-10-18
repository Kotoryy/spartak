// Кэширует оболочку приложения, чтобы оно открывалось без интернета, и показывает push-уведомления.
// Данные матчей хранятся в localStorage самим приложением.
const CACHE = 'spartak-shell-v2';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin) {
    // Сначала сеть (чтобы обновления доходили), при офлайне — кэш
    e.respondWith(fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))));
  } else if (url.hostname === 'a.espncdn.com' || (url.hostname.endsWith('thesportsdb.com') && url.pathname.includes('/images/'))) {
    // Эмблемы команд: из кэша, если уже скачаны
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request).then((res) => {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res;
    })));
  }
});

self.addEventListener('push', (e) => {
  let msg = {};
  try { msg = e.data.json(); } catch { msg = { title: 'Спартак', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(msg.title || 'Спартак', {
    body: msg.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: msg.tag,
    renotify: true,
    vibrate: msg.goal ? [200, 100, 200, 100, 400] : [200],
    data: { url: msg.url || './' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || './', self.registration.scope);
  const id = target.searchParams.get('match');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const win = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (win) {
      if (id) win.postMessage({ type: 'open-match', id });
      return win.focus();
    }
    return self.clients.openWindow(target.href);
  }));
});
