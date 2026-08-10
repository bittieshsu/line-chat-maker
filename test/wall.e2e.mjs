/* 共享區端點驗收。自己起 wrangler dev(本機 D1),跑完關掉,不碰線上資料。
   跑法:node test/wall.e2e.mjs
   前提:worker/.dev.vars 有 WALL_UPLOAD_CODE 與 WALL_ADMIN_TOKEN(不進版控) */
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'worker');
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const EVENT = 'chat-test-0812';
const ORIGIN = 'https://yazelin.github.io'; // 白名單裡的 Origin,不帶會被 403

const req = (path, method, body, token) => fetch(BASE + path, {
  method,
  headers: {
    origin: ORIGIN,
    ...(body ? { 'content-type': 'application/json' } : {}),
    ...(token ? { authorization: 'Bearer ' + token } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const post = (p, b, t) => req(p, 'POST', b, t);
const del = (p, t) => req(p, 'DELETE', null, t);
const get = (p) => req(p, 'GET', null, null);

// 自己把表建起來,不要假設本機 D1 已經有表(本機狀態不進版控)
spawnSync('npx', ['wrangler', 'd1', 'execute', 'k-rider-signups', '--local', '--file', 'wall-schema.sql'],
  { cwd: WORKER_DIR, stdio: 'ignore' });

// detached + 殺整個行程群組:wrangler 底下還有 workerd 孫行程,只 kill npx 會留下佔著埠不放的殭屍
const proc = spawn('npx', ['wrangler', 'dev', '--port', String(PORT), '--local'], { cwd: WORKER_DIR, stdio: 'ignore', detached: true });
const stop = () => { try { process.kill(-proc.pid); } catch (e) { try { proc.kill(); } catch (e2) {} } };
process.on('exit', stop);

let up = false;
for (let i = 0; i < 240 && !up; i++) { // wrangler dev 冷啟動可能要幾十秒
  await new Promise((r) => setTimeout(r, 500));
  try { up = (await get(`/api/wall/events/${EVENT}/submissions`)).ok; } catch (e) {}
}
if (!up) { stop(); console.error('wrangler dev 起不來'); process.exit(1); }

const t = [];
const check = async (name, fn) => { try { await fn(); t.push(['ok', name]); } catch (e) { t.push(['FAIL', name + ' → ' + e.message]); } };

const CODE = 'Xk9-_aB2'; // 真實的短碼是 base64url,含大小寫與 - _
let ownerToken = '', id = '';

await check('帶正確活動碼可以投稿', async () => {
  const r = await post('/api/wall/submissions', { event: EVENT, code: CODE, name: '亞澤', title: '冷凍庫裡的鞋', msgCount: 18, consent: true, uploadCode: 'local-code' });
  assert.strictEqual(r.status, 201, '投稿沒回 201,實得 ' + r.status);
  const d = await r.json();
  ownerToken = d.ownerToken; id = d.submission.id;
  assert.ok(ownerToken && id, '沒拿到 ownerToken 或 id');
});

await check('清單抓得到剛投的那筆', async () => {
  const d = await (await get(`/api/wall/events/${EVENT}/submissions`)).json();
  const hit = (d.submissions || []).find((s) => s.code === CODE);
  assert.ok(hit, '清單裡沒有剛投的作品');
  assert.strictEqual(hit.title, '冷凍庫裡的鞋');
  assert.strictEqual(hit.msg_count, 18);
});

await check('清單不會夾帶作品內容(只回輕量欄位)', async () => {
  const d = await (await get(`/api/wall/events/${EVENT}/submissions`)).json();
  const hit = d.submissions[0];
  for (const k of ['state', 'messages', 'owner_token_hash']) assert.ok(!(k in hit), `清單不該回 ${k}`);
});

await check('負控制:沒帶活動碼投不進去', async () => {
  const r = await post('/api/wall/submissions', { event: EVENT, code: 'Bb2c3d4E', name: '路人', consent: true });
  assert.strictEqual(r.status, 403, '沒帶碼竟然不是 403,實得 ' + r.status);
});

await check('負控制:活動碼錯投不進去', async () => {
  const r = await post('/api/wall/submissions', { event: EVENT, code: 'Bb2c3d4E', name: '路人', consent: true, uploadCode: 'wrong-code' });
  assert.strictEqual(r.status, 403);
});

await check('負控制:沒勾同意投不進去', async () => {
  const r = await post('/api/wall/submissions', { event: EVENT, code: 'Cc3d4e5F', name: '路人', consent: false, uploadCode: 'local-code' });
  assert.strictEqual(r.status, 400);
});

await check('負控制:拿別人的 token 刪不掉', async () => {
  const r = await del('/api/wall/submissions/' + id, 'someone-elses-token');
  assert.strictEqual(r.status, 403, '別人的 token 竟然刪得掉,實得 ' + r.status);
});

await check('同一場同一份作品不能重複投稿', async () => {
  const r = await post('/api/wall/submissions', { event: EVENT, code: CODE, name: '亞澤', consent: true, uploadCode: 'local-code' });
  assert.strictEqual(r.status, 409);
});

await check('作者帶自己的 token 刪得掉', async () => {
  assert.strictEqual((await del('/api/wall/submissions/' + id, ownerToken)).status, 200);
  const d = await (await get(`/api/wall/events/${EVENT}/submissions`)).json();
  assert.ok(!(d.submissions || []).some((s) => s.code === CODE), '刪完清單裡還在');
});

await check('管理權杖刪得掉任何一筆', async () => {
  const d = await (await post('/api/wall/submissions', { event: EVENT, code: 'Dd4e5f6A', name: '別人', consent: true, uploadCode: 'local-code' })).json();
  assert.strictEqual((await del('/api/wall/submissions/' + d.submission.id, 'local-admin')).status, 200);
});

stop();
for (const [s, n] of t) console.log(`  ${s === 'ok' ? 'ok  ' : 'FAIL'}  ${n}`);
const failed = t.filter((x) => x[0] === 'FAIL').length;
console.log(`\n${t.length - failed}/${t.length} 通過`);
process.exit(failed ? 1 : 0);
