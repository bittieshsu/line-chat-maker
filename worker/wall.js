/* 共享區端點。掛在 lcm-ai-proxy 底下,共用它的 Origin 白名單與 D1 綁定,但不吃 AI 額度。
   投稿要活動碼(WALL_UPLOAD_CODE, secret);刪改要作者 token 或管理權杖(WALL_ADMIN_TOKEN, secret)。
   這裡只存「哪些短碼要公開展示」的索引,作品本體在 shorturl 那邊。 */
import { normalizeEvent, normalizeCode, normalizeName, normalizeTitle, sha256, safeEqual } from './wall-lib.js';

const bearer = (req) => { const h = req.headers.get('authorization') || ''; return h.startsWith('Bearer ') ? h.slice(7).trim() : ''; };

async function canEdit(req, env, row) {
  const token = bearer(req);
  if (!token) return false;
  const admin = String(env.WALL_ADMIN_TOKEN || '').trim();
  if (admin && safeEqual(token, admin)) return true;
  return safeEqual(await sha256(token), row.owner_token_hash);
}

// 回 Response 表示這條路由由共享區處理完了;回 null 表示不是共享區的路徑,交回原本的路由。
export async function handleWall(req, env, cors, err, okOrigin) {
  const p = new URL(req.url).pathname;
  if (!p.startsWith('/api/wall/')) return null;
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...cors } });
  if (!okOrigin) return err(403, '共享區只服務 line-chat-maker 網頁。');

  // 清單:唯讀,只回輕量欄位(不含作品內容,內容點開才向 shorturl 取)
  const list = p.match(/^\/api\/wall\/events\/([a-z0-9-]+)\/submissions$/);
  if (list && req.method === 'GET') {
    const event = normalizeEvent(list[1]);
    if (!event) return err(400, '梯次代號不合法。');
    const { results } = await env.DB.prepare(
      'SELECT id, code, title, display_name, msg_count, created_at FROM chat_wall_submissions WHERE event_id = ? AND hidden = 0 ORDER BY created_at DESC LIMIT 200'
    ).bind(event).all();
    return json({ ok: true, submissions: results || [] });
  }

  // 投稿:要活動碼
  if (p === '/api/wall/submissions' && req.method === 'POST') {
    let body = {};
    try { body = await req.json(); } catch (e) { return err(400, '請求格式不是 JSON。'); }
    const event = normalizeEvent(body.event);
    const code = normalizeCode(body.code);
    const name = normalizeName(body.name);
    const title = normalizeTitle(body.title);
    const count = Math.max(0, Math.min(9999, Number(body.msgCount) || 0));
    if (!event) return err(400, '梯次代號不合法。');
    if (!code) return err(400, '作品短碼不合法,請先按「分享連結」產生。');
    if (!name) return err(400, '請填一個顯示名稱。');
    if (body.consent !== true) return err(400, '請勾選展示同意。');

    const expect = String(env.WALL_UPLOAD_CODE || '').trim();
    if (!expect) return err(503, '這場活動還沒開放投稿。');
    if (!safeEqual(String(body.uploadCode || '').trim(), expect)) return err(403, '活動碼不對。');

    const dup = await env.DB.prepare('SELECT id FROM chat_wall_submissions WHERE event_id = ? AND code = ?').bind(event, code).first();
    if (dup) return err(409, '這份作品已經在牆上了。');

    const ownerToken = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO chat_wall_submissions (id, event_id, code, title, display_name, msg_count, consent, owner_token_hash, hidden, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 0, ?)'
    ).bind(id, event, code, title, name, count, await sha256(ownerToken), now).run();

    return json({ ok: true, ownerToken, submission: { id, code, title, display_name: name, msg_count: count, created_at: now } }, 201);
  }

  // 改標題 / 刪除:作者或管理員
  const one = p.match(/^\/api\/wall\/submissions\/([a-f0-9-]{36})$/i);
  if (one && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const row = await env.DB.prepare('SELECT id, owner_token_hash FROM chat_wall_submissions WHERE id = ?').bind(one[1]).first();
    if (!row) return err(404, '找不到這筆作品。');
    if (!(await canEdit(req, env, row))) return err(403, '沒有權限改這筆作品。');
    if (req.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM chat_wall_submissions WHERE id = ?').bind(row.id).run();
      return json({ ok: true });
    }
    let body = {};
    try { body = await req.json(); } catch (e) { return err(400, '請求格式不是 JSON。'); }
    await env.DB.prepare('UPDATE chat_wall_submissions SET title = ? WHERE id = ?').bind(normalizeTitle(body.title), row.id).run();
    return json({ ok: true });
  }

  return err(404, '共享區只有 GET /api/wall/events/<梯次>/submissions、POST /api/wall/submissions,以及對單筆的 PATCH 與 DELETE。');
}
