// ponytail: 全量 precache、cache-first、ignoreSearch —— 照 yazelin PWA 離線守則
const CACHE = 'lcm-v130';
const ASSETS = ['./', 'index.html', 'style.css', 'skin.js', 'pure.js', 'app.js', 'ai.js', 'presets.json', 'vendor/html2canvas.min.js', 'vendor/mp4-muxer.min.js', 'verify.html', 'demo.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
// 只清自己的 lcm-*:CacheStorage 是 per-origin,yazelin.github.io 所有專案共用同一份,無差別刪會清掉別站的離線包
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('lcm-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // 跨網域一律走網路:額度徽章 /quota、生圖輪詢與取檔都是即時資料,cache-first 會把它們凍在第一次的回應
  if (new URL(e.request.url).origin !== location.origin) return;
  // 頁面導航 network-first:改版一次重整就生效;離線時退回「該頁」快取,找不到才退主頁
  // (原本成功時一律 put 進 'index.html' 鍵、失敗時一律回主頁:開過 verify.html 會把主頁快取蓋成驗證頁)
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html'))));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })));
});
