/* 共享區純邏輯:worker 與測試共用同一份(比照 pure.js 的做法,不做鏡像複本) */

export function normalizeEvent(v) {
  const s = String(v || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{2,63}$/.test(s) ? s : null;
}

// 短碼=SHA-256 的 base64url 前 8 碼(碰撞時改發 12 或 16 碼)。
// 是 base64url 不是十六進位,而且**大小寫有意義**,絕對不能 toLowerCase。
export function normalizeCode(v) {
  const s = String(v || '').trim();
  return /^[A-Za-z0-9_-]{8,16}$/.test(s) ? s : null;
}

function clean(v, max) { // 去控制字元、壓多重空白、截長度
  return String(v || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function normalizeName(v) { const s = clean(v, 20); return s.length >= 1 ? s : null; }
export function normalizeTitle(v) { return clean(v, 40); } // 標題可空,空的話前端顯示對話本身的 title

export function safeEqual(a, b) { // 長度不同也走完整長度比對,不因提早 return 洩漏長度
  const x = String(a || ''), y = String(b || '');
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length, 1);
  for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

export async function sha256(v) {
  const bytes = new TextEncoder().encode(String(v || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
