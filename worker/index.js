/* lcm-ai-proxy:line-chat-maker 的免費體驗代理(「刷亞澤的信用卡」)
   Groq key 只存在 Cloudflare secret,絕不進前端。
   五道閘:Origin 白名單 / model 鎖定+請求形狀 / 每 IP 每日額度 / 全站每日熔斷 / max_tokens 上限。
   自架:見同目錄 README.md。 */
import { handleWall } from './wall.js';

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const okOrigin = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
    const cors = {
      'access-control-allow-origin': okOrigin ? origin : 'null',
      'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS', // PATCH/DELETE 是共享區改標題與刪除用的
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-max-age': '86400',
    };
    const err = (status, message) => new Response(JSON.stringify({ error: { message } }), { status, headers: { 'content-type': 'application/json', ...cors } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const pathname = new URL(req.url).pathname;
    if (req.method === 'GET' && pathname === '/quota') { // 唯讀查額度(給前端徽章),不計入用量
      if (!okOrigin) return err(403, '這個免費代理只服務 line-chat-maker 網頁。');
      const day = new Date().toISOString().slice(0, 10);
      const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
      let mine = 0, all = 0, imgMine = 0, imgAll = 0, glmMine = 0, glmAll = 0;
      try {
        const q = 'SELECT n FROM lcm_quota WHERE day = ?1 AND ip = ?2';
        const a = await env.DB.prepare(q).bind(day, ip).first();
        const b = await env.DB.prepare(q).bind(day, '__global__').first();
        const ci = await env.DB.prepare(q).bind(day, 'img:' + ip).first();
        const di = await env.DB.prepare(q).bind(day, '__img_global__').first();
        const gi = await env.DB.prepare(q).bind(day, 'glm:' + ip).first();
        const gj = await env.DB.prepare(q).bind(day, '__glm_global__').first();
        mine = a ? a.n : 0; all = b ? b.n : 0; imgMine = ci ? ci.n : 0; imgAll = di ? di.n : 0; glmMine = gi ? gi.n : 0; glmAll = gj ? gj.n : 0;
      } catch (e) {} // 表還沒建=零用量
      return new Response(
        JSON.stringify({
          ipUsed: mine, ipLimit: +env.IP_DAILY || 60, globalUsed: all, globalLimit: +env.GLOBAL_DAILY || 1200,
          imgUsed: imgMine, imgLimit: +env.IMG_IP_DAILY || 2, imgGlobalUsed: imgAll, imgGlobalLimit: +env.IMG_GLOBAL_DAILY || 20,
          glmUsed: glmMine, glmLimit: +env.GLM_IP_DAILY || 20, glmGlobalUsed: glmAll, glmGlobalLimit: +env.GLM_GLOBAL_DAILY || 200,
        }),
        { headers: { 'content-type': 'application/json', ...cors } },
      );
    }
    // ── AI 補圖:代理 codex-image-service(cimg key 只在 secret;圖像額度獨立於文字) ──
    if (pathname.startsWith('/images/')) {
      if (!okOrigin) return err(403, '這個免費代理只服務 line-chat-maker 網頁。');
      const imgBase = (env.CODEX_IMAGE_BASE || 'https://ching-tech.ddns.net/codex-image').replace(/\/+$/, '');
      const imgHeaders = { authorization: 'Bearer ' + env.CODEX_IMAGE_KEY, 'user-agent': 'lcm-ai-proxy/1.0' };
      const day = new Date().toISOString().slice(0, 10);
      const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
      if (req.method === 'POST' && pathname === '/images/jobs') { // 建圖(計額度)
        const raw = await req.text();
        if (raw.length > 40_000) return err(413, '請求太大。');
        let body;
        try { body = JSON.parse(raw); } catch { return err(400, '請求不是合法 JSON。'); }
        if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 12_000) return err(400, 'prompt 格式不對。');
        const size = ['1024x1024', '1024x1536', '1536x1024'].includes(body.size) ? body.size : '1024x1024';
        const imgIpLimit = +env.IMG_IP_DAILY || 2;
        const imgGlobalLimit = +env.IMG_GLOBAL_DAILY || 20;
        let ic;
        try { ic = await bump(env.DB, day, 'img:' + ip, '__img_global__'); }
        catch (e) {
          await env.DB.exec('CREATE TABLE IF NOT EXISTS lcm_quota (day TEXT NOT NULL, ip TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, ip))');
          ic = await bump(env.DB, day, 'img:' + ip, '__img_global__');
        }
        if (ic.global > imgGlobalLimit) return err(429, '今天全站的 AI 補圖額度用完了(生圖走亞澤的 ChatGPT 額度,比文字貴)。明天再來。');
        if (ic.ip > imgIpLimit) return err(429, `你今天的 AI 補圖額度用完了(每天 ${imgIpLimit} 次)。明天再來,或自己上傳圖片。`);
        const upstream = await fetch(imgBase + '/v1/images/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...imgHeaders },
          body: JSON.stringify({ prompt: body.prompt, size, quality: 'medium', count: 1 }),
        });
        return new Response(await upstream.text(), { status: upstream.status, headers: { 'content-type': 'application/json', ...cors } });
      }
      if (req.method === 'GET' && /^\/images\/jobs\/[A-Za-z0-9_-]+$/.test(pathname)) { // 輪詢(不計額度)
        const id = pathname.split('/').pop();
        const upstream = await fetch(imgBase + '/v1/images/jobs/' + id, { headers: imgHeaders });
        return new Response(await upstream.text(), { status: upstream.status, headers: { 'content-type': 'application/json', ...cors } });
      }
      if (req.method === 'GET' && pathname === '/images/file') { // 取成品(CORS 中轉,canvas 才切得動);只准 /generated/ 下的 png
        const p = new URL(req.url).searchParams.get('p') || '';
        if (!/^\/generated\/[A-Za-z0-9_.-]+\.png$/.test(p)) return err(400, '路徑不合法。');
        const upstream = await fetch(imgBase + p, { headers: imgHeaders });
        return new Response(upstream.body, { status: upstream.status, headers: { 'content-type': 'image/png', 'cache-control': 'no-store', ...cors } });
      }
      return err(404, 'images 路由:POST /images/jobs、GET /images/jobs/<id>、GET /images/file?p=/generated/xx.png。');
    }

    { // 共享區:自己處理權限與 CORS,不吃 AI 額度;不是它的路徑會回 null 讓下面繼續
      const res = await handleWall(req, env, cors, err, okOrigin);
      if (res) return res;
    }

    if (req.method !== 'POST' || pathname !== '/chat/completions') return err(404, '這個免費代理只有 POST /chat/completions、GET /quota、/images/* 與 /api/wall/*。');
    if (!okOrigin) return err(403, '這個免費代理只服務 line-chat-maker 網頁。想自架:repo 的 worker/ 目錄照 README 部署,用自己的 key。');

    const raw = await req.text();
    if (raw.length > 400_000) return err(413, '請求太大。');
    let body;
    try { body = JSON.parse(raw); } catch { return err(400, '請求不是合法 JSON。'); }
    if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 150) return err(400, 'messages 格式不對。');

    const writerModel = env.WRITER_MODEL || 'glm-5.2';
    const wantWriter = body.model === writerModel && !!env.LLMSHARE_API_KEY; // 編劇=glm-5.2 路由到朋友的 llm-share

    // 額度:每 IP 每日+全站熔斷(D1;表不存在時自建一次)
    const day = new Date().toISOString().slice(0, 10); // UTC 日界,台北時間早上 8 點重置
    const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
    const ipLimit = +env.IP_DAILY || 60;
    const globalLimit = +env.GLOBAL_DAILY || 1200;
    let counts;
    try { counts = await bump(env.DB, day, ip); }
    catch (e) {
      await env.DB.exec('CREATE TABLE IF NOT EXISTS lcm_quota (day TEXT NOT NULL, ip TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, ip))');
      counts = await bump(env.DB, day, ip);
    }
    if (counts.global > globalLimit) return err(429, '今天全站的免費體驗額度被大家用完了(亞澤的信用卡在冒煙)。明天再來,或到連線設定填自己的 Groq API Key(免費申請,額度歸你)。');
    if (counts.ip > ipLimit) return err(429, `你今天的免費體驗額度用完了(每天 ${ipLimit} 次 AI 呼叫,約 3 個作品)。想繼續:連線設定填自己的 Groq API Key(免費申請)。`);

    // 編劇(GLM)另有一道更小的獨立額度:保護朋友的 key(Origin 標頭可偽造,共用的全站 1200 不夠緊)
    if (wantWriter) {
      let gc;
      try { gc = await bump(env.DB, day, 'glm:' + ip, '__glm_global__'); }
      catch (e) {
        await env.DB.exec('CREATE TABLE IF NOT EXISTS lcm_quota (day TEXT NOT NULL, ip TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, ip))');
        gc = await bump(env.DB, day, 'glm:' + ip, '__glm_global__');
      }
      if (gc.global > (+env.GLM_GLOBAL_DAILY || 200)) return err(429, '今天全站的免費「劇本強化」額度用完了。明天再來,或連線設定填自己的 API Key,或用「複製 prompt」貼到你自己的 AI。');
      if (gc.ip > (+env.GLM_IP_DAILY || 20)) return err(429, '你今天的免費「劇本強化」額度用完了。想繼續:連線設定填自己的 API Key,或用「複製 prompt(免費)」貼到你自己的 AI。');
    }

    // 鎖定 model 與欄位:這不是萬用 LLM 代理。編劇(glm-5.2)路由到 llm-share;其餘一律鎖 Groq。secret 沒設時退回 Groq。
    let clean, upURL, upHeaders;
    if (wantWriter) {
      clean = {
        model: writerModel,
        messages: body.messages,
        max_tokens: Math.max(1, Math.min(+body.max_tokens || 8192, 8192)),
        reasoning_effort: 'none', // GLM 是思考型:不關掉會把預算全花在 reasoning、content 回空白
      };
      upURL = (env.LLMSHARE_BASE || 'https://llm-share.duotify.com/v1').replace(/\/+$/, '') + '/chat/completions';
      upHeaders = { 'content-type': 'application/json', authorization: 'Bearer ' + env.LLMSHARE_API_KEY, 'user-agent': 'lcm-ai-proxy/1.0' };
    } else {
      clean = {
        model: env.MODEL || 'openai/gpt-oss-120b',
        messages: body.messages,
        max_tokens: Math.min(+body.max_tokens || 4096, 4096),
      };
      if (Array.isArray(body.tools)) clean.tools = body.tools;
      if (body.tool_choice !== undefined) clean.tool_choice = body.tool_choice;
      upURL = 'https://api.groq.com/openai/v1/chat/completions';
      upHeaders = {
        'content-type': 'application/json',
        authorization: 'Bearer ' + env.GROQ_API_KEY,
        'user-agent': 'lcm-ai-proxy/1.0 (+https://github.com/yazelin/line-chat-maker)', // Groq 前的 CF 防護會擋無 UA 的雲端請求
      };
    }
    const upstream = await fetch(upURL, { method: 'POST', headers: upHeaders, body: JSON.stringify(clean) });
    const text = await upstream.text();
    return new Response(text, { status: upstream.status, headers: { 'content-type': 'application/json', ...cors } });
  },
};

async function bump(db, day, ip, globalKey) {
  const sql = 'INSERT INTO lcm_quota (day, ip, n) VALUES (?1, ?2, 1) ON CONFLICT(day, ip) DO UPDATE SET n = n + 1 RETURNING n';
  const mine = await db.prepare(sql).bind(day, ip).first();
  const all = await db.prepare(sql).bind(day, globalKey || '__global__').first();
  return { ip: mine.n, global: all.n };
}
