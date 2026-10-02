/* 离线外壳。VERSION 参与缓存名，发版必须改这一行 —— 但缓存策略本身是"网络优先"，
   所以漏改版本号只会让离线兜底用旧副本，不会像 cache-first 那样把 js/css 永久钉死
   在旧版、造出"新 HTML 配旧 JS"的鬼状态。 */

const VERSION = 'slant-v1.0.0';
const SHELL_CACHE = `${VERSION}-shell`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

const SHELL = [
  './',
  './index.html',
  './css/game.css',
  './js/main.js',
  './manifest.webmanifest',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/textures/paper-256.png',
];

self.addEventListener('install', (event) => {
  // allSettled：前缀形态下少一个文件也不能让整个安装失败，那样就永远没有离线兜底了。
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => Promise.allSettled(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== SHELL_CACHE && key !== RUNTIME_CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 不代理第三方，也不替它们背缓存

  event.respondWith(
    (async () => {
      let net = null;
      try {
        net = await fetch(req);
      } catch {
        net = null; // 离线 / 断网，退缓存
      }
      if (net && net.ok && net.type !== 'opaque') {
        const cache = await caches.open(RUNTIME_CACHE);
        cache.put(req, net.clone()).catch(() => {});
      }
      if (net) return net;
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw new Error('offline: ' + url.pathname);
    })(),
  );
});
