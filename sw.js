const CACHE_NAME = 'transcriber-v3.1';   // ★ 版数を必ず上げる
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
  // 必要に応じてCSS・JSなど追加
];

self.addEventListener('install', e => {
  self.skipWaiting();  // 即時インストール
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(ASSETS))
  );
});

self.addEventListener('activate', e => {
  clients.claim();     // 即時アクティベート＆制御権取得
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
    .then(() => self.clients.matchAll())   // ★ 更新を各クライアントへ通知
    .then(clients => clients.forEach(c => c.postMessage('sw-updated')))
  );
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(res => res || fetch(e.request))
  );
});