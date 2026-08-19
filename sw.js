// ponytail: 全量 precache、cache-first、ignoreSearch/ignoreVary、Range 合成 206 —— 照 yazelin PWA 離線守則
const CACHE = 'lcm-v163';
// ignoreSearch:帶 ?utm= 的路由也命中;ignoreVary:避開 Pages 的 Vary: Accept-Encoding(<video> 送 identity)
const MATCH = { ignoreSearch: true, ignoreVary: true };
const ASSETS = ['./', 'index.html', 'style.css', 'skin.js', 'pure.js', 'app.js', 'ai.js', 'presets.json', 'vendor/html2canvas.min.js', 'vendor/mp4-muxer.min.js', 'verify.html', 'demo.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(ASSETS.map((u) => c.add(u)))).then(() => self.skipWaiting())); });
// 只清自己的 lcm-*:CacheStorage 是 per-origin,yazelin.github.io 所有專案共用同一份,無差別刪會清掉別站的離線包
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('lcm-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
// 從快取的完整回應合成 206:examples/*.mp4 這類較大的檔,Chrome 一律用 Range 抓,
// 拿到「200 但沒有 Content-Range」會判 Format error(命中快取卻播不出來的真因)。
async function rangedResponse(req, res) {
  const range = req.headers.get('range');
  if (!range) return res;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
  if (!m) return res;
  const buf = await res.arrayBuffer();
  const len = buf.byteLength;
  let start = m[1] ? Number(m[1]) : null;
  let end = m[2] ? Number(m[2]) : null;
  if (start === null && end !== null) { start = Math.max(0, len - end); end = len - 1; }
  else { start ??= 0; end = end === null ? len - 1 : Math.min(end, len - 1); }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= len) {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${len}` } });
  }
  const h = new Headers(res.headers);
  h.set('accept-ranges', 'bytes');
  h.set('content-range', `bytes ${start}-${end}/${len}`);
  h.set('content-length', String(end - start + 1));
  return new Response(buf.slice(start, end + 1), { status: 206, headers: h });
}
// 只存完整 200:Cache.put 對 206(Range 回應)會丟 TypeError,存了也是半截檔
const store = (req, res) => { if (res && res.status === 200) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); } };
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // 跨網域一律走網路:額度徽章 /quota、生圖輪詢與取檔都是即時資料,cache-first 會把它們凍在第一次的回應
  if (new URL(e.request.url).origin !== location.origin) return;
  // 頁面導航 network-first:改版一次重整就生效;離線時退回「該頁」快取,找不到才退主頁
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((res) => { store(e.request, res); return res; }).catch(() => caches.match(e.request, MATCH).then((hit) => hit || caches.match('index.html'))));
    return;
  }
  // 其餘 cache-first;命中就回(媒體的 Range 請求靠 rangedResponse 合成 206),沒中才連網並補存
  e.respondWith(caches.match(e.request, MATCH).then((hit) => hit ? rangedResponse(e.request, hit) : fetch(e.request).then((res) => { store(e.request, res); return res; })));
});
