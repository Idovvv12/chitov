// Offline shell: serve cached app files, refresh them in the background.
// Bump VERSION after changing the file list.
const VERSION = 'chitov-v3';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'logic.js', 'foods.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const font = url.host.endsWith('fonts.googleapis.com') || url.host.endsWith('fonts.gstatic.com');
  if (e.request.method !== 'GET' || (url.origin !== location.origin && !font)) return; // APIs go straight to network
  e.respondWith(caches.open(VERSION).then(async cache => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then(r => { if (r.ok) cache.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || fresh;
  }));
});
