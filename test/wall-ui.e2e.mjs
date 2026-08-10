/* 共享區前端驗收:真的開瀏覽器跑一輪投稿→清單→預覽→打開來用→展示模式→刪除。
   自己起兩個服務(靜態站 8917、wrangler dev 8799),跑完關掉,不碰線上資料。
   跑法:node test/wall-ui.e2e.mjs
   前提:本機有 google-chrome 與全域 playwright(不是這個 repo 的相依,沒裝就跳過);
        worker/.dev.vars 的 ALLOWED_ORIGINS 要含 http://127.0.0.1:8917。
   註:短碼服務不收 127.0.0.1 這個來源,所以那兩個請求在瀏覽器層假造,共享區 API 打的是真的 worker。 */
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLAYWRIGHT = process.env.PLAYWRIGHT_PATH
  || '/home/ct/.nvm/versions/node/v22.17.1/lib/node_modules/playwright/index.mjs';
let chromium;
try { ({ chromium } = await import(PLAYWRIGHT)); }
catch (e) { console.log('跳過:找不到 playwright(' + PLAYWRIGHT + ')。裝了再跑,或用 PLAYWRIGHT_PATH 指路。'); process.exit(0); }

// 自己把表建起來再清空,不要假設本機 D1 已經有表(本機狀態不進版控,換台機器或清掉就沒了)
const d1 = (args) => spawnSync('npx', ['wrangler', 'd1', 'execute', 'k-rider-signups', '--local', ...args],
  { cwd: join(ROOT, 'worker'), stdio: 'ignore' });
d1(['--file', 'wall-schema.sql']);
d1(['--command', 'DELETE FROM chat_wall_submissions']);

const kids = [];
const spawnBg = (cmd, args, cwd) => { const c = spawn(cmd, args, { cwd, stdio: 'ignore', detached: true }); kids.push(c); return c; };
// detached + 殺行程群組:wrangler 底下有 workerd 孫行程,只 kill 父層會留下佔埠的殭屍
const stopAll = () => kids.forEach((c) => { try { process.kill(-c.pid); } catch (e) { try { c.kill(); } catch (e2) {} } });
process.on('exit', stopAll);

spawnBg('python3', ['-m', 'http.server', '8917', '--bind', '127.0.0.1'], ROOT);
spawnBg('npx', ['wrangler', 'dev', '--port', '8799', '--local'], join(ROOT, 'worker'));

let up = false;
for (let i = 0; i < 240 && !up; i++) { // wrangler dev 冷啟動可能要幾十秒
  await new Promise((r) => setTimeout(r, 500));
  try {
    const a = await fetch('http://127.0.0.1:8917/');
    const b2 = await fetch('http://127.0.0.1:8799/api/wall/events/chat-2026-08-12/submissions', { headers: { origin: 'http://127.0.0.1:8917' } });
    up = a.ok && b2.ok;
  } catch (e) {}
}
if (!up) { stopAll(); console.error('本機服務起不來(靜態站 8917 或 wrangler dev 8799)'); process.exit(1); }

const SITE = 'http://127.0.0.1:8917/';
const t = [];
const check = async (name, fn) => { try { await fn(); t.push(['ok', name]); } catch (e) { t.push(['FAIL', name + ' → ' + e.message]); } };

const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
const ctx = await b.newContext({ serviceWorkers: 'block' }); // sw 的 cache-first 會端舊檔,測 UI 一律擋掉
const p = await ctx.newPage();
p.on('console', (m) => { if (m.type() === 'error') console.log('  頁面錯誤:', m.text().slice(0, 160)); });

await p.addInitScript(() => { try { localStorage.setItem('lcm-wall-api', 'http://127.0.0.1:8799'); } catch (e) {} });

// 短碼服務不收 127.0.0.1 這個來源,本機驗收時在瀏覽器層假造它;共享區 API 仍打真的 wrangler dev。
const stash = new Map();
const stub = async (page) => {
  await page.route('**/api/short-url', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    const code = 'a1b2c3d4';
    stash.set(code, body.state);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code, shortUrl: 'http://x/s/' + code }) });
  });
  await page.route('**/api/template/*', async (route) => {
    const code = route.request().url().split('/').pop();
    const st = stash.get(code);
    if (!st) return route.fulfill({ status: 404, body: '{}' });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: st }) });
  });
};
await stub(p);
await p.goto(SITE, { waitUntil: 'load' });
await p.waitForTimeout(2500);

await check('共享區分頁點得開,而且沒有作品時給提示', async () => {
  await p.click('.tabs [data-pane="wall"]');
  await p.waitForTimeout(1200);
  const txt = await p.locator('#wall-list').innerText();
  if (!/還沒有人投稿|載入中/.test(txt)) throw new Error('清單區文字不對:' + txt.slice(0, 60));
});

await check('缺欄位時投稿被擋下來(不會直接送出)', async () => {
  const before = await p.locator('.wall-item').count();
  await p.click('#wall-post summary');
  await p.click('#wall-submit');
  await p.waitForTimeout(1200);
  const after = await p.locator('.wall-item').count();
  if (after !== before) throw new Error(`沒填欄位竟然投稿成功了:${before} → ${after}`);
});

await check('填齊欄位可以投稿,牆上長出那筆', async () => {
  await p.fill('#wall-name', '測試員');
  await p.fill('#wall-title', '冷凍庫裡的鞋');
  await p.fill('#wall-code', 'local-code');
  await p.check('#wall-consent');
  await p.click('#wall-submit');
  await p.waitForTimeout(4000);
  const txt = await p.locator('#wall-list').innerText();
  if (!txt.includes('冷凍庫裡的鞋')) throw new Error('投稿後牆上沒有那筆:' + txt.slice(0, 80));
  if (!txt.includes('測試員')) throw new Error('沒顯示投稿者名字');
});

await check('自己投的作品有刪除鈕(別人的不會有)', async () => {
  const n = await p.locator('.wall-acts button', { hasText: '刪除' }).count();
  if (n !== 1) throw new Error('刪除鈕數量是 ' + n + ',預期 1');
});

let before = 0;
await check('預覽跳出覆蓋層,裡面是真的渲染出來的對話', async () => {
  before = await p.locator('#phone .msg, #phone .bubble, #chat > div').count();
  await p.locator('.wall-acts button', { hasText: '預覽' }).first().click();
  await p.waitForTimeout(2500);
  if (!(await p.locator('.wall-mask .phone').count())) throw new Error('覆蓋層裡沒有渲染出手機');
  const inner = await p.locator('.wall-mask').innerText();
  if (inner.length < 20) throw new Error('覆蓋層內容太少,可能沒渲染:' + inner);
});

await check('關掉預覽後,手上原本的草稿沒被動到', async () => {
  await p.locator('.wall-modal-head button', { hasText: '關閉' }).click();
  await p.waitForTimeout(800);
  const after = await p.locator('#phone .msg, #phone .bubble, #chat > div').count();
  if (after !== before) throw new Error(`原本草稿的訊息數被改了:${before} → ${after}`);
});

await check('打開來用會開成新草稿並跳回聊天室分頁', async () => {
  // 先改動手上這份,讓它跟牆上那份不一樣。adoptIncoming 對「跟最新草稿完全相同」的匯入會去重,
  // 不改的話不會多一份草稿,那是刻意行為不是 bug。
  await p.click('.tabs [data-pane="chatset"]');
  await p.waitForTimeout(400);
  await p.click('#chat-addbar [data-add="right"]');
  await p.waitForTimeout(800);
  const draftsBefore = await (async () => { await p.click('.tabs [data-pane="drafts"]'); await p.waitForTimeout(800); return p.locator('#draft-list .draft-item').count(); })();
  await p.click('.tabs [data-pane="wall"]');
  await p.waitForTimeout(1000);
  await p.locator('.wall-acts button', { hasText: '打開來用' }).first().click();
  await p.waitForTimeout(3000);
  const active = await p.locator('.tabs .tab.active').innerText();
  if (!active.includes('聊天室')) throw new Error('沒跳回聊天室分頁,現在在:' + active);
  await p.click('.tabs [data-pane="drafts"]');
  await p.waitForTimeout(800);
  const draftsAfter = await p.locator('#draft-list .draft-item').count();
  if (draftsAfter !== draftsBefore + 1) throw new Error(`草稿沒有多一份:${draftsBefore} → ${draftsAfter}`);
});

await check('展示模式只剩作品,而且顯示標題與作者', async () => {
  const dp = await ctx.newPage();
  await dp.setViewportSize({ width: 900, height: 460 }); // 模擬簡報裡那個矮 iframe
  await stub(dp);
  await dp.goto(SITE + '?wall=display', { waitUntil: 'load' });
  await dp.waitForTimeout(4000);
  if (!(await dp.locator('.wall-stage .phone').count())) throw new Error('展示模式沒有渲染出作品');
  const cap = await dp.locator('.wall-cap').innerText();
  if (!cap.includes('冷凍庫裡的鞋')) throw new Error('展示模式的字幕不對:' + cap);
  if (await dp.locator('.panel').isVisible().catch(() => false)) throw new Error('展示模式竟然還看得到左邊的面板');
  // 矮 iframe 裡手機要被縮到裝得下,而且字幕要看得見
  const box = await dp.locator('.wall-stage').boundingBox();
  const capBox = await dp.locator('.wall-cap').boundingBox();
  if (!box || box.height > 460) throw new Error('作品沒有被縮進畫面,高度 ' + (box && box.height));
  if (!capBox || capBox.y + capBox.height > 460) throw new Error('字幕被擠出畫面了');
  await dp.screenshot({ path: join(ROOT, 'wall-display.png') // 已 gitignore;要看就開這個檔 });
  await dp.close();
});

await check('帶碼網址會自動填好活動碼,而且碼不留在網址列', async () => {
  const cp = await ctx.newPage();
  await cp.addInitScript(() => { try { localStorage.setItem('lcm-wall-api', 'http://127.0.0.1:8799'); } catch (e) {} });
  await cp.goto(SITE + '?code=local-code', { waitUntil: 'load' });
  await cp.waitForTimeout(3000);
  const v = await cp.locator('#wall-code').inputValue();
  if (v !== 'local-code') throw new Error('活動碼沒帶入,實得:' + v);
  const active = await cp.locator('.tabs .tab.active').innerText();
  if (!active.includes('共享區')) throw new Error('沒切到共享區分頁,現在在:' + active);
  if (cp.url().includes('code=')) throw new Error('碼還留在網址列:' + cp.url());
  await cp.close();
});

await check('刪掉自己的作品,牆上就沒了(順便讓這支測試可以重複跑)', async () => {
  await p.click('.tabs [data-pane="wall"]');
  await p.waitForTimeout(1200);
  p.once('dialog', (d) => d.accept());
  await p.locator('.wall-acts button', { hasText: '刪除' }).first().click();
  await p.waitForTimeout(2500);
  const txt = await p.locator('#wall-list').innerText();
  if (txt.includes('冷凍庫裡的鞋')) throw new Error('刪完牆上還在:' + txt.slice(0, 60));
});

await b.close();
stopAll();
for (const [s, n] of t) console.log(`  ${s === 'ok' ? 'ok  ' : 'FAIL'}  ${n}`);
const failed = t.filter((x) => x[0] === 'FAIL').length;
console.log(`\n${t.length - failed}/${t.length} 通過`);
process.exit(failed ? 1 : 0);
