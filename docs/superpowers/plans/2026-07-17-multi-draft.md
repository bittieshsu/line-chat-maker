# 多草稿管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 匯入(`#s=`、`?id=`、JSON 檔)一律開成新草稿,永不覆蓋創作;草稿存 IndexedDB(實測配額 6.4GB),附草稿管理分頁。

**Architecture:** 單檔 vanilla JS(app.js)。`lcm-state` localStorage 降為「收件匣」(AI/Playwright 注入 + 舊版遷移共用一條規則);草稿本體進 IndexedDB store `drafts`;`state` 變數與其後 40+ 個 `save()` 呼叫點介面不變,`save()` 內部改為 debounce 300ms 寫 IDB。啟動改 async `boot()`。

**Tech Stack:** vanilla JS、IndexedDB(wrapper 參考 line-sticker-studio app.js)、Playwright 驗收(跑在 scratchpad,不進 repo)。

**Spec:** `docs/superpowers/specs/2026-07-17-multi-draft-design.md`

## Global Constraints

- 正體中文 UI 文案,不用 emoji;程式風格照 app.js 現況(單引號、分號、緊湊單行)。
- 零新依賴、零 build step;repo 不新增 node_modules。
- `save()` 對外簽名不變(無參數呼叫);`state` 仍是全域可變綁定。
- SKILL.md 記載的 `localStorage.setItem('lcm-state', ...)` 注入契約必須繼續可用。
- 草稿絕不自動淘汰;IDB 失敗降級記憶體模式,不擋創作。
- 驗收工具:`NODE_PATH=<裝了 playwright 的 node_modules> node <script>`(Playwright);本機 server:`python3 -m http.server 8917 --directory <這個 repo>`。

---

### Task 1: 儲存層 + 開機流程(IDB、收件匣、#s=、?id=)

**Files:**
- Modify: `app.js:19-40`(state/load/save 區)
- Modify: `app.js:458-473`(importFromQuery)
- Modify: `app.js:483-489`(JSON 匯入、重設)
- Modify: `app.js:526`(`render()` → `boot()`)
- Test: `<scratchpad>/lcm-accept.js`(Playwright 驗收,Task 1 先跑情境 2/6/7)

**Interfaces:**
- Produces(後續 task 依賴,簽名如下):
  - `function save()` / `function flushSave()` / `function persistNow()`
  - `async function createDraft(s, name)` → `{id, name, updatedAt, state}`
  - `function activate(d)`(flushSave + 切換 currentId/currentName/state + 記 lcm-current)
  - `async function adoptIncoming(s)` → 去重後的草稿物件
  - `function migrate(s)`(原 load() 的 settings 補欄位邏輯)
  - `const draftPut/draftGet/draftAll/draftDelete`、`let idbDead`、`function toast(msg)`
  - `async function renderDrafts()`(Task 1 先放空殼 `async function renderDrafts() {}`,Task 2 實作)

- [ ] **Step 1: 寫驗收腳本(先寫先跑,紅燈)**

`<scratchpad>/lcm-accept.js` 全文(含全部 8 情境;Task 1 結束時 2/3/6/7/8 應綠,4/5 待 Task 2/3):

```js
/* line-chat-maker 多草稿驗收:對應 spec 驗收 1-8 */
const { chromium } = require('playwright');
const assert = require('assert');
const BASE = 'http://localhost:8917/';
const b64u = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const share = (title) => ({ settings: { title }, people: [{ id: 'p1', name: '甲', avatar: null }], messages: [{ type: 'msg', side: 'left', personId: 'p1', text: title, time: '上午9:00', read: '', quote: null }] });
const drafts = (page) => page.evaluate(() => new Promise((res, rej) => {
  const rq = indexedDB.open('line-chat-maker');
  rq.onsuccess = () => { const rq2 = rq.result.transaction('drafts').objectStore('drafts').getAll(); rq2.onsuccess = () => res(rq2.result); rq2.onerror = () => rej(rq2.error); };
  rq.onerror = () => rej(rq.error);
}));
const cur = (page) => page.evaluate(() => ({ id: localStorage.getItem('lcm-current'), title: state.settings.title }));
(async () => {
  const browser = await chromium.launch();
  const fresh = async () => { const ctx = await browser.newContext({ serviceWorkers: 'block' }); const page = await ctx.newPage(); page.on('dialog', (d) => d.accept()); return { ctx, page }; };
  const boot = (page, url) => page.goto(url || BASE, { waitUntil: 'load' }).then(() => page.waitForFunction(() => window.state && state.messages));
  let n = 0; const ok = (m) => console.log('  PASS ' + m) || n++;

  { // 1+6. 編輯中同分頁開 #s= 連結 → 原草稿完好、新草稿開啟;reload 還原
    const { ctx, page } = await fresh();
    await boot(page);
    await page.fill('#set-title', 'MYWORK');
    await page.waitForTimeout(500);
    await page.evaluate((h) => { location.hash = h; }, '#s=' + b64u(share('FRIEND')));
    await page.waitForFunction(() => window.state && state.settings.title === 'FRIEND');
    let all = await drafts(page);
    assert.strictEqual(all.length, 2, '應有兩份草稿');
    assert(all.some((d) => d.state.settings.title === 'MYWORK'), '原創作 MYWORK 必須還在');
    assert.strictEqual((await cur(page)).title, 'FRIEND', '目前應是朋友的');
    ok('1 匯入不覆蓋');
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.state && state.messages);
    assert.strictEqual((await cur(page)).title, 'FRIEND', 'reload 還原目前草稿');
    assert.strictEqual((await drafts(page)).length, 2, 'reload 草稿數不變');
    ok('6 重新整理還原');
    await ctx.close();
  }
  { // 2+7. lcm-state 收件匣:注入 → 變新草稿(AI 路徑 + 舊版遷移同規則)
    const { ctx, page } = await fresh();
    await page.addInitScript((s) => { if (!localStorage.getItem('__seeded')) { localStorage.setItem('__seeded', '1'); localStorage.setItem('lcm-state', s); } }, JSON.stringify(share('LEGACY')));
    await boot(page);
    const all = await drafts(page);
    assert.strictEqual(all.length, 1, '收件匣應成為唯一草稿');
    assert.strictEqual(all[0].state.settings.title, 'LEGACY');
    assert.strictEqual(await page.evaluate(() => localStorage.getItem('lcm-state')), null, 'lcm-state 應被消化');
    assert.strictEqual((await cur(page)).title, 'LEGACY');
    ok('2/7 收件匣 + 舊版遷移');
    await ctx.close();
  }
  { // 3. 同一條連結開兩次 → 不疊副本
    const { ctx, page } = await fresh();
    const url = BASE + '#s=' + b64u(share('DUP'));
    await boot(page, url);
    const n1 = (await drafts(page)).length;
    await boot(page, url);
    const all = await drafts(page);
    assert.strictEqual(all.length, n1, '第二次開同連結不新增');
    assert.strictEqual((await cur(page)).title, 'DUP');
    ok('3 連結去重');
    await ctx.close();
  }
  { // 4. 草稿刪到最後一份 → 自動範例(Task 2 後綠)
    const { ctx, page } = await fresh();
    await boot(page);
    await page.click('.tabs [data-pane="drafts"]');
    await page.waitForSelector('.draft-item');
    await page.click('.draft-item .draft-acts button:has-text("刪除")');
    await page.waitForFunction(() => document.querySelectorAll('.draft-item').length === 1 && document.querySelector('.draft-item input').value === '範例');
    assert((await drafts(page)).length === 1);
    ok('4 刪到最後自動範例');
    await ctx.close();
  }
  { // 5. 照片→JPEG、貼圖→PNG(Task 3 後綠)
    const { ctx, page } = await fresh();
    await boot(page);
    await page.evaluate(() => { state.messages = []; save(); render(); });
    for (const kind of ['image', 'sticker']) {
      await page.click(`#chat-addbar [data-add="${kind}"]`);
      const sel = kind === 'image' ? '.imgmsg' : '.sticker';
      const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click(sel)]);
      await fc.setFiles({ name: 'x.png', mimeType: 'image/png', buffer: PNG1 });
      await page.waitForFunction((k) => { const m = state.messages.find((x) => x.kind === k); return m && m.img; }, kind);
    }
    const [imgFmt, stkFmt] = await page.evaluate(() => [state.messages.find((m) => m.kind === 'image').img.slice(0, 15), state.messages.find((m) => m.kind === 'sticker').img.slice(0, 14)]);
    assert.strictEqual(imgFmt, 'data:image/jpeg', '照片訊息應存 JPEG');
    assert.strictEqual(stkFmt, 'data:image/png', '貼圖應存 PNG');
    ok('5 照片 JPEG/貼圖 PNG');
    await ctx.close();
  }
  { // 8. ?id= 短連結(mock worker)→ 開新草稿
    const { ctx, page } = await fresh();
    await ctx.route('**/api/template/**', (r) => r.fulfill({ json: { state: share('SHORT') } }));
    await boot(page);
    await page.fill('#set-title', 'MINE2');
    await page.waitForTimeout(500);
    await boot(page, BASE + '?id=abc123');
    await page.waitForFunction(() => window.state && state.settings.title === 'SHORT');
    const all = await drafts(page);
    assert(all.some((d) => d.state.settings.title === 'MINE2'), '?id= 匯入不得覆蓋');
    assert.strictEqual((await cur(page)).title, 'SHORT');
    assert.strictEqual(await page.evaluate(() => location.search), '', '?id= 應被清掉');
    ok('8 短連結開新草稿');
    await ctx.close();
  }
  await browser.close();
  console.log(`\n全綠:${n} 情境通過`);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
```

注意:`window.state` 判斷式利用 top-level `let state` 屬於全域語彙環境,`page.evaluate` 讀得到 `state`,但 `window.state` 是 undefined;所以 waitForFunction 一律寫 `typeof state !== 'undefined' && state && ...`。**寫腳本時把上面每個 `window.state && state.x` 改成 `typeof state !== 'undefined' && state && state.x`**(下同)。

- [ ] **Step 2: 起 server、跑腳本,確認紅燈**

```bash
python3 -m http.server 8917 --directory <這個 repo> &
NODE_PATH=<裝了 playwright 的 node_modules> node <scratchpad>/lcm-accept.js
```
Expected: FAIL(情境 1:舊行為覆蓋,`MYWORK 必須還在` 斷言失敗,或 IDB 不存在)

- [ ] **Step 3: 實作儲存層(取代 app.js:19-40)**

刪掉原 `let state = load();`、`load()`、`save()`(19-40 行),換成:

```js
let state;               // 目前草稿的 state(其餘程式碼照用)
let currentId = null;    // 目前草稿 id
let currentName = '';    // 目前草稿名稱
let avatarTarget = null; // personId 等待換頭像
let bgTarget = false;    // 等待上傳背景圖
let imgTarget = null;    // 等待換圖的 image 訊息 index

// ── 草稿儲存:IndexedDB(wrapper 參考 line-sticker-studio);lcm-state 降為收件匣 ──
const IDB_NAME = 'line-chat-maker', IDB_STORE = 'drafts';
let _idb = null, idbDead = false;
function idbOpen() {
  if (_idb) return _idb;
  _idb = new Promise((res, rej) => {
    const rq = indexedDB.open(IDB_NAME, 1);
    rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains(IDB_STORE)) rq.result.createObjectStore(IDB_STORE, { keyPath: 'id' }); };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  return _idb;
}
function idbTx(fn, mode) {
  return idbOpen().then((db) => new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, mode || 'readonly');
    const rq = fn(tx.objectStore(IDB_STORE));
    tx.oncomplete = () => res(rq && rq.result);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  }));
}
const draftPut = (d) => idbTx((s) => s.put(d), 'readwrite');
const draftGet = (id) => idbTx((s) => s.get(id));
const draftAll = () => idbTx((s) => s.getAll());
const draftDelete = (id) => idbTx((s) => s.delete(id), 'readwrite');

let quotaWarned = false;
function saveFailed(e) {
  console.warn('草稿寫入失敗', e);
  if (e && e.name === 'QuotaExceededError' && !quotaWarned) { quotaWarned = true; alert('本機儲存空間滿了:請到「草稿」分頁刪除舊草稿,或先匯出 JSON 備份。'); }
}
function persistNow() {
  if (idbDead || !currentId) return;
  draftPut({ id: currentId, name: currentName || (state.settings && state.settings.title) || '未命名', updatedAt: Date.now(), state }).catch(saveFailed);
}
let saveTimer = null;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { saveTimer = null; persistNow(); }, 300); }
function flushSave() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; persistNow(); } }

function migrate(s) {
  if (s.settings.frameLevel === undefined) s.settings.frameLevel = s.settings.frame === false ? 'chat' : 'phone';
  const d = DEMO.settings;
  for (const k of Object.keys(d)) if (s.settings[k] === undefined) s.settings[k] = d[k];
  return s;
}
function newId() { return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
async function createDraft(s, name) {
  const d = { id: newId(), name: name || (s.settings && s.settings.title) || '未命名', updatedAt: Date.now(), state: s };
  if (!idbDead) await draftPut(d).catch(saveFailed);
  return d;
}
function activate(d) {
  flushSave();
  currentId = d.id; currentName = d.name; state = d.state;
  try { localStorage.setItem('lcm-current', currentId); } catch (e) {}
}
async function adoptIncoming(s) {
  migrate(s);
  const all = idbDead ? [] : await draftAll().catch(() => []);
  const latest = all.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (latest && JSON.stringify(latest.state) === JSON.stringify(s)) return latest;
  return createDraft(s);
}
function toast(msg) {
  const t = el('div', 'toast'); t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 3200);
}
async function renderDrafts() {} // Task 2 實作

async function boot() {
  try { await idbOpen(); } catch (e) { idbDead = true; console.warn('IndexedDB 不可用,本次僅記憶體運作,請匯出 JSON 備份', e); }
  try { // 收件匣:AI/Playwright 注入 + 舊版一次性遷移,同一條規則
    const inbox = JSON.parse(localStorage.getItem('lcm-state'));
    if (inbox && inbox.messages) { activate(await adoptIncoming(inbox)); localStorage.removeItem('lcm-state'); }
  } catch (e) {}
  const h = location.hash.match(/^#s=(.+)$/);
  if (h) { // 長連結 → 開新草稿,原創作不動
    try {
      const s = JSON.parse(decodeURIComponent(escape(atob(h[1].replace(/-/g, '+').replace(/_/g, '/')))));
      history.replaceState(null, '', location.pathname + location.search);
      if (s && s.messages) { activate(await adoptIncoming(s)); toast('已開成新草稿;你原本的創作都在「草稿」分頁'); }
    } catch (e) { console.warn('hash 匯入失敗', e); }
  }
  if (!currentId) {
    const all = idbDead ? [] : await draftAll().catch(() => []);
    const d = all.find((x) => x.id === localStorage.getItem('lcm-current')) || all.sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (d) activate(d);
    else activate(await createDraft(migrate(JSON.parse(JSON.stringify(DEMO))), '範例'));
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  render();
  importFromQuery();
}
```

同時刪掉原第 20-22 行的三個舊變數宣告(已併入上方)。

- [ ] **Step 4: 改寫 importFromQuery(app.js 原 458-473)**

IIFE 改具名函式(boot 尾端呼叫),取回後走 adoptIncoming:

```js
// 短連結載入:?id=code → 向 worker 取回,開成新草稿(主要分享路徑)
async function importFromQuery() {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) return;
  try {
    const r = await fetch(SHORTURL_API + '/api/template/' + encodeURIComponent(id));
    const d = await r.json();
    if (d && d.state && Array.isArray(d.state.messages)) {
      history.replaceState(null, '', location.pathname);
      activate(await adoptIncoming(d.state));
      render(); renderDrafts();
      toast('已開成新草稿;你原本的創作都在「草稿」分頁');
    }
  } catch (e) { console.warn('短連結載入失敗', e); }
}
```

- [ ] **Step 5: JSON 匯入與重設(app.js 原 483-489)**

```js
$('#file-json').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { const s = JSON.parse(await f.text()); if (!s.messages) throw new Error('缺 messages'); activate(await adoptIncoming(s)); render(); renderDrafts(); toast('已開成新草稿;原創作在「草稿」分頁'); }
  catch (err) { alert('JSON 讀不進來:' + err.message); }
  e.target.value = '';
});
$('#reset').addEventListener('click', () => { if (confirm('清空目前這份草稿,回到範例?')) { state = migrate(JSON.parse(JSON.stringify(DEMO))); save(); render(); } });
```

- [ ] **Step 6: 檔尾 `render();` 改 `boot();`(app.js:526)**

- [ ] **Step 7: 跑驗收,情境 1/2/3/6/7/8 綠**

```bash
NODE_PATH=<裝了 playwright 的 node_modules> node <scratchpad>/lcm-accept.js
```
Expected: 情境 4(等 `.draft-item`)與 5(JPEG)仍紅,其餘 PASS。可先把 4/5 區塊暫時註記略過確認其餘全綠。

- [ ] **Step 8: Commit**

```bash
git add app.js && git commit -m "feat(drafts): 草稿改存 IndexedDB,匯入(#s=/?id=/JSON)一律開新草稿不覆蓋"
```

### Task 2: 草稿分頁 UI

**Files:**
- Modify: `index.html:33-37`(tabs)、`index.html`(pane-exportset 之後加 pane)
- Modify: `app.js`(實作 renderDrafts、draft-new、分頁點擊)
- Modify: `style.css`(draft-item、toast)

**Interfaces:**
- Consumes: Task 1 的 `draftAll/draftGet/draftPut/draftDelete/createDraft/activate/migrate/persistNow/saveFailed/idbDead/el`
- Produces: `#pane-drafts`、`.draft-item`(內含 `input` 名稱、`.draft-acts` 按鈕:開啟/複製/刪除)、`#draft-new`

- [ ] **Step 1: index.html 加分頁**

tabs 列(34-36 行後)加:
```html
      <button class="tab" data-pane="drafts">草稿</button>
```
`</section>`(pane-exportset 結尾)之後加:
```html
    <section class="pane" id="pane-drafts">
      <p class="hint">每份創作都自動即時保存在這台裝置;匯入分享連結會開成新草稿,不會覆蓋。跨裝置或長期備份請用「匯出腳本 JSON」。</p>
      <button id="draft-new">新增空白草稿</button>
      <div id="draft-list"></div>
    </section>
```
(先確認 index.html 是否已有 `.hint` 樣式,沒有就在 style.css 一併補:`.hint { font-size: 0.8rem; color: var(--muted); }`)

- [ ] **Step 2: app.js 以實作取代 `async function renderDrafts() {}` 空殼**

```js
// ── 草稿分頁 ──
const fmtTime = (t) => new Date(t).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
async function renderDrafts() {
  const box = $('#draft-list');
  if (!box) return;
  if (idbDead) { box.innerHTML = '<p class="hint">此瀏覽器無法本機保存(私密視窗?),請用「匯出腳本 JSON」備份。</p>'; return; }
  const all = (await draftAll().catch(() => [])).sort((a, b) => b.updatedAt - a.updatedAt);
  box.innerHTML = '';
  all.forEach((d) => {
    const row = el('div', 'draft-item' + (d.id === currentId ? ' cur' : ''));
    const name = document.createElement('input');
    name.value = d.name; name.title = '點擊改名';
    name.addEventListener('change', async () => {
      const v = name.value.trim() || '未命名';
      if (d.id === currentId) { currentName = v; persistNow(); }
      else { const full = await draftGet(d.id); if (full) { full.name = v; await draftPut(full).catch(saveFailed); } }
      renderDrafts();
    });
    const meta = el('span', 'draft-meta');
    meta.textContent = `${fmtTime(d.updatedAt)} · ${Math.max(1, Math.round(JSON.stringify(d.state).length / 1024))} KB`;
    const acts = el('span', 'draft-acts');
    const mk = (label, title, fn) => { const b = el('button'); b.textContent = label; b.title = title; b.addEventListener('click', fn); acts.appendChild(b); };
    if (d.id !== currentId) mk('開啟', '切換到這份草稿', async () => { const full = await draftGet(d.id); if (full) { activate(full); render(); renderDrafts(); } });
    mk('複製', '複製一份', async () => { const full = await draftGet(d.id); if (full) { await createDraft(JSON.parse(JSON.stringify(full.state)), full.name + ' 副本'); renderDrafts(); } });
    mk('刪除', '刪除這份草稿', async () => {
      if (!confirm(`刪除「${d.name}」?此動作無法復原。`)) return;
      await draftDelete(d.id).catch(() => {});
      if (d.id === currentId) {
        currentId = null;
        const rest = (await draftAll().catch(() => [])).sort((a, b) => b.updatedAt - a.updatedAt);
        if (rest[0]) activate(rest[0]); else activate(await createDraft(migrate(JSON.parse(JSON.stringify(DEMO))), '範例'));
        render();
      }
      renderDrafts();
    });
    row.appendChild(name); row.appendChild(meta); row.appendChild(acts);
    box.appendChild(row);
  });
}
$('#draft-new').addEventListener('click', async () => {
  const blank = migrate(JSON.parse(JSON.stringify(DEMO)));
  blank.settings.title = '新對話'; blank.messages = [];
  activate(await createDraft(blank, '新對話'));
  render(); renderDrafts();
});
document.querySelector('.tabs [data-pane="drafts"]').addEventListener('click', renderDrafts);
```

放在「腳本 JSON 進出」區塊之後。注意 tabs 的既有 click 綁定(app.js:503-506)照舊處理 active 樣式,這裡只是多掛一個 renderDrafts。

- [ ] **Step 3: style.css 加樣式(檔尾)**

```css
/* 草稿分頁 */
.draft-item { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem 0.5rem; padding: 0.45rem 0.5rem; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 0.5rem; }
.draft-item.cur { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.draft-item input { flex: 1 1 8rem; min-width: 6rem; border: none; background: none; font: inherit; color: inherit; border-bottom: 1px dashed transparent; }
.draft-item input:hover, .draft-item input:focus { border-bottom-color: var(--muted); outline: none; }
.draft-meta { font-size: 0.78rem; color: var(--muted); white-space: nowrap; }
.draft-acts { display: flex; gap: 0.3rem; margin-left: auto; }
.draft-acts button { font-size: 0.8rem; padding: 0.15rem 0.5rem; }
.toast { position: fixed; left: 50%; bottom: 1.2rem; transform: translate(-50%, 8px); background: rgba(28, 25, 23, 0.92); color: #fff; padding: 0.55rem 1rem; border-radius: 999px; font-size: 0.88rem; opacity: 0; transition: opacity 0.3s, transform 0.3s; z-index: 99; pointer-events: none; max-width: 92vw; }
.toast.show { opacity: 1; transform: translate(-50%, 0); }
```
若 dark 模式(`body.dark`)下 `--border/--muted` 已有覆寫則自動生效,不另寫。

- [ ] **Step 4: 跑驗收,情境 4 轉綠(5 仍紅)**

```bash
NODE_PATH=<裝了 playwright 的 node_modules> node <scratchpad>/lcm-accept.js
```

- [ ] **Step 5: Commit**

```bash
git add app.js index.html style.css && git commit -m "feat(drafts): 草稿分頁——列表/改名/開啟/複製/刪除,toast 提示"
```

### Task 3: 照片訊息改存 JPEG(貼圖維持 PNG)

**Files:**
- Modify: `app.js:318-325`(圖片上傳 imgTarget 分支)

**Interfaces:**
- Consumes: 既有上傳流程;無新介面。

- [ ] **Step 1: 改 imgTarget 分支**

```js
    } else if (imgTarget !== null) {
      const m = state.messages[imgTarget];
      const sticker = m && m.kind === 'sticker';
      const maxW = sticker ? 320 : 480;
      const sc = Math.min(1, maxW / img.width);
      c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
      const g = c.getContext('2d');
      if (!sticker) { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); } // JPEG 無透明,先鋪白
      g.drawImage(img, 0, 0, c.width, c.height);
      if (m) m.img = sticker ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85);
      imgTarget = null;
    }
```
同時把該區塊上方註解改為:`// ── 圖片上傳(頭像 96 PNG / 背景 800 JPEG / 圖片訊息 480 JPEG / 貼圖 320 PNG 保留透明) ──`

- [ ] **Step 2: 跑驗收,情境 5 轉綠 → 全部 8 情境 PASS**

- [ ] **Step 3: Commit**

```bash
git add app.js && git commit -m "feat(image): 照片訊息改存 JPEG 0.85(白底)——單張從約 490KB 降到約 65KB,貼圖維持 PNG"
```

### Task 4: SW bump + README + SKILL.md

**Files:**
- Modify: `sw.js:2`(`lcm-v31` → `lcm-v32`)
- Modify: `README.md`(特色清單加一條)
- Modify: `skills/line-chat-maker/SKILL.md:16`(注入語意)

- [ ] **Step 1: sw.js CACHE bump**

```js
const CACHE = 'lcm-v32';
```

- [ ] **Step 2: README 特色加一條(放進既有功能清單)**

```markdown
- 多草稿:創作自動即時保存在本機(IndexedDB);開別人的分享連結或匯入 JSON 會開成新草稿,不會覆蓋你的創作
```

- [ ] **Step 3: SKILL.md 注入路徑補一句**

在原「`localStorage.setItem('lcm-state', ...)` → reload」該行(SKILL.md:16)句尾加:

```markdown
(注入內容會開成一份新草稿並自動切換,不會覆蓋使用者既有創作)
```

- [ ] **Step 4: Commit**

```bash
git add sw.js README.md skills/line-chat-maker/SKILL.md && git commit -m "chore: SW v32 + README/SKILL.md 補多草稿說明"
```

### Task 5: 全綠驗收 + 上線

**Files:** 無新檔;跑驗收、push、確認 Pages。

- [ ] **Step 1: 完整驗收(全部 8 情境)**

```bash
NODE_PATH=<裝了 playwright 的 node_modules> node <scratchpad>/lcm-accept.js
```
Expected: `全綠:N 情境通過`(不含被合併計數的 1+6、2+7,共 6 個區塊、8 個 spec 驗收項)

- [ ] **Step 2: 手動煙霧(截圖級確認,可選)**

Playwright 開 http://localhost:8917/ 截圖草稿分頁,肉眼確認版面沒爆。

- [ ] **Step 3: push + Pages 部署確認**

```bash
git push origin master
```
等 1-2 分鐘後 `curl -s https://yazelin.github.io/line-chat-maker/app.js | grep -c adoptIncoming` 應 ≥ 1(Pages 傳播有空窗,別過早下結論)。

- [ ] **Step 4: 收尾**

殺掉 8917 server;回報驗證清單(真改了什麼 → 怎麼驗 → 結果)。
