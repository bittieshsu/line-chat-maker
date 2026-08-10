/* LINE 對話製造機 — 單檔 vanilla JS,狀態=一份 JSON,人與 AI 都用它 */
'use strict';

const DEMO = {
  settings: { title: 'C# Taiwan交流聚會', members: 1947, bg: '#7d9bc1', bgImage: null, font: '', sysColor: '#2d3b4e', theme: 'light', skin: 'memo', playfulness: 0.5, aiFab: true, frameLevel: 'phone', notch: 'island', radius: 32, buttons: true, homebar: true, watermark: true, wmText: 'LINE 對話製造機', clock: '16:08', signal: 4, wifi: true, battery: 87, battText: true, sbAlarm: true, sbArrows: true, sbVolte: true, sbSignal: true, sbBatt: true, glow: 0, glowColor: '#96b9ff', darkUI: false, backlight: 0, backColor: '#06c755', height: 'fixed', heightPx: 768, mode: 'group', draft: '', announceOn: false, embedAutoplay: false, announce: '下次聚會 7/26(六)14:00 台北;新朋友先看記事本' },
  people: [
    { id: 'p1', name: '中年攻城屍', avatar: null },
    { id: 'p2', name: '小白++', avatar: null },
  ],
  messages: [
    { type: 'date', text: '7月15日 (三)' },
    { type: 'msg', side: 'left', personId: 'p1', text: '現在有AI 是有點想做side project 只是不知道要做什麼', time: '下午3:42', read: '', quote: null },
    { type: 'skip', text: '⋯⋯大家熱烈討論(略)⋯⋯' },
    { type: 'msg', side: 'right', text: '做一個許願池發社群上給大家許願', time: '下午4:06', read: '已讀 8', quote: { name: '中年攻城屍', text: '現在有AI 是有點想做side project…' } },
    { type: 'msg', side: 'left', personId: 'p2', text: '欸 好耶', time: '下午4:06', read: '', quote: null },
  ],
};

let state;               // 目前草稿的 state(其餘程式碼照用)
let currentId = null;    // 目前草稿 id
let currentName = '';    // 目前草稿名稱
let avatarTarget = null; // personId 等待換頭像
let bgTarget = false;   // 等待上傳背景圖
let imgTarget = null;   // 等待換圖的 image 訊息 index
let reactTarget = null; // 等待上傳表情小圖的訊息 index

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
  window.LCM_PURE.normalizeSides(s); // 缺 side/personId 的 left 訊息(頭像會空一格)
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
  // 每次啟用都跑一次 migrate:IndexedDB 裡的舊草稿不經匯入路徑,壞在檔案裡的訊息只有這裡救得到
  currentId = d.id; currentName = d.name; state = migrate(d.state);
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

async function fetchPresets() { // 讀內建範例清單(presets.json,precache);失敗回 null
  try {
    const res = await fetch('./presets.json');
    if (!res.ok) return null;
    const presets = await res.json();
    return Array.isArray(presets) && presets.length ? presets : null;
  } catch (e) { console.warn('內建範例載入失敗', e); return null; }
}
async function seedPresets() { // 首次啟動:把內建範例種成草稿,新使用者一開「草稿」分頁就看得到
  const presets = await fetchPresets();
  if (!presets) return false;
  let first = null;
  for (let i = presets.length - 1; i >= 0; i--) { // 反序種:陣列首項最後種→updatedAt 最新→列在草稿最上、也是啟用那份
    const p = presets[i];
    const d = await createDraft(migrate(p.state), p.name || (p.state.settings && p.state.settings.title));
    if (i === 0) first = d;
  }
  if (first) { activate(first); return true; }
  return false;
}
// 老使用者(草稿庫非空)手動載入內建範例:只補草稿裡還沒有的(按 name 去重),不動現有創作
async function loadPresetsToDrafts() {
  const presets = await fetchPresets();
  if (!presets) { toast('內建範例載入失敗'); return; }
  const existing = (idbDead ? [] : await draftAll().catch(() => [])).map((d) => d.name);
  const missing = window.LCM_PURE.presetsToLoad(presets, existing);
  if (!missing.length) { toast('內建範例已在你的草稿裡了'); return; }
  for (let i = missing.length - 1; i >= 0; i--) {
    const p = missing[i];
    await createDraft(migrate(p.state), p.name || (p.state.settings && p.state.settings.title));
  }
  renderDrafts();
  toast('已載入 ' + missing.length + ' 份內建範例到草稿');
}

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
    else if (!(await seedPresets())) activate(await createDraft(migrate(JSON.parse(JSON.stringify(DEMO))), '範例'));
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  render();
  importFromQuery();
  const q = new URLSearchParams(location.search);
  if (q.get('wall') === 'display') wallDisplayMode();
  // ?code=xxx 自動帶入活動碼:現場少一個打錯字的環節。伺服器端照樣驗,前端只是省打字。
  if (q.get('code') && q.get('wall') !== 'display') wallPrefillCode(q.get('code'));
}

const $ = (sel) => document.querySelector(sel);
const wmText = () => (state.settings.wmText || '').trim() || 'LINE 對話製造機';
const chatEl = $('#chat');

function glowShadow(st) {
  if (!(st.glow > 0)) return '';
  const hx = (st.glowColor || '#96b9ff').replace('#', '');
  const r = parseInt(hx.slice(0, 2), 16), g = parseInt(hx.slice(2, 4), 16), b = parseInt(hx.slice(4, 6), 16);
  return `0 0 ${st.glow}px rgba(${r},${g},${b},${Math.min(0.9, st.glow / 100)})`;
}

function personOf(m) { return state.people.find((p) => p.id === m.personId) || { id: null, name: '???', avatar: null }; }

// 依整數 seed 產一個 [-1,1] 的穩定偽亂數(重繪同 seed 同值,匯出與預覽一致)
function tiltUnit(seed) {
  const x = Math.sin((seed + 1) * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1; // [-1,1)
}

function render() {
  const st = state.settings;
  $('#set-title').value = st.title;
  $('#set-members').value = st.members;
  $('#set-bg').value = st.bg;
  $('#set-frame-level').value = st.frameLevel;
  $('#set-notch').value = st.notch;
  $('#set-radius').value = st.radius; $('#radius-val').textContent = st.radius;
  $('#set-buttons').checked = !!st.buttons;
  $('#set-homebar').checked = !!st.homebar;
  $('#set-watermark').checked = !!st.watermark;
  $('#set-wmtext').value = st.wmText === undefined ? 'LINE 對話製造機' : st.wmText;
  $('#wm-preview').style.display = st.watermark ? '' : 'none';
  $('#wm-preview').textContent = wmText();
  $('#set-clock').value = st.clock;
  $('#set-signal').value = st.signal; $('#signal-val').textContent = st.signal + '/4';
  $('#set-wifi').checked = !!st.wifi;
  $('#set-battery').value = st.battery; $('#battery-val').textContent = st.battery;
  $('#set-batttext').checked = !!st.battText;
  { // 系統圖示各項開關(舊草稿沒這些 key,undefined 視為開)+ 總開關三態
    const on = { alarm: st.sbAlarm !== false, wifi: !!st.wifi, arrows: st.sbArrows !== false, volte: st.sbVolte !== false, signal: st.sbSignal !== false, batt: st.sbBatt !== false };
    for (const k of ['alarm', 'arrows', 'volte', 'signal', 'batt']) $('#set-sb-' + k).checked = on[k];
    const vals = Object.values(on);
    const all = $('#set-sb-all');
    all.checked = vals.every(Boolean);
    all.indeterminate = !all.checked && vals.some(Boolean);
  }
  $('#set-glow').value = st.glow; $('#glow-val').textContent = st.glow;
  $('#set-glowcolor').value = st.glowColor || '#96b9ff';
  $('#set-darkui').checked = !!st.darkUI;
  $('#set-backlight').value = st.backlight || 0; $('#backlight-val').textContent = st.backlight || 0;
  $('#set-backcolor').value = st.backColor || '#06c755';
  const bl = $('#backlight');
  if (st.backlight > 0) {
    const hx = (st.backColor || '#06c755').replace('#', '');
    const r = parseInt(hx.slice(0, 2), 16), g = parseInt(hx.slice(2, 4), 16), b = parseInt(hx.slice(4, 6), 16);
    const a1 = (st.backlight / 100 * 0.85).toFixed(2), a2 = (st.backlight / 100 * 0.35).toFixed(2);
    bl.style.display = '';
    bl.style.background = `radial-gradient(ellipse 62% 58% at 50% 50%, rgba(${r},${g},${b},${a1}) 0%, rgba(${r},${g},${b},${a1}) 45%, rgba(139,92,246,${a2}) 66%, transparent 82%)`;
  } else { bl.style.display = 'none'; }
  document.body.classList.toggle('dark', !!st.darkUI);
  $('#set-height').value = st.height || 'auto';
  $('#set-heightpx').value = st.heightPx || 768;
  $('#lbl-heightpx').style.display = st.height === 'fixed' ? '' : 'none';
  $('#set-mode').value = st.mode || 'group';
  $('#set-syscolor').value = st.sysColor || '#2d3b4e';
  $('#set-theme').value = st.theme || 'light';
  const eff = window.LCM_SKINS.resolveSkin(st);
  const skinSel = document.querySelector('#set-skin');
  if (skinSel) skinSel.value = eff;
  const realOnly = document.querySelector('#real-only');
  if (realOnly) realOnly.hidden = eff !== 'real'; // 佈景/系統色只在真實 skin 下有意義
  $('#set-aifab').checked = st.aiFab !== false;
  $('#ai-fab').style.display = st.aiFab === false ? 'none' : '';
  if (eff === 'real') { // 系統顏色:狀態列+表頭底色,依亮度自動配黑/白前景(僅真實 skin;玩樂 skin 交給 skin CSS)
    const sys = st.sysColor || '#2d3b4e';
    const lum = 0.2126 * parseInt(sys.slice(1, 3), 16) + 0.7152 * parseInt(sys.slice(3, 5), 16) + 0.0722 * parseInt(sys.slice(5, 7), 16);
    const sysFg = lum > 150 ? '#17181a' : '#fff';
    for (const sel of ['#phone .statusbar', '#phone .linehead']) { const n = $(sel); n.style.background = sys; n.style.color = sysFg; }
  } else { // 玩樂 skin:清掉 inline 色,讓 .phone.skin-* CSS 生效
    for (const sel of ['#phone .statusbar', '#phone .linehead']) { const n = $(sel); n.style.background = ''; n.style.color = ''; }
  }
  const fsel = $('#set-font');
  if (st.font && !Array.from(fsel.options).some((o) => o.value === st.font)) {
    const o = document.createElement('option'); o.value = st.font; o.textContent = st.font.replace(/"/g, '') + '(本機)';
    fsel.insertBefore(o, fsel.querySelector('option[value="__local"]'));
  }
  fsel.value = st.font || '';
  $('#grp-hw').style.display = st.frameLevel === 'phone' ? '' : 'none';
  $('#grp-sb').style.display = st.frameLevel === 'chat' ? 'none' : '';

  const phone = $('#phone');
  phone.className = 'phone level-' + st.frameLevel + (st.height === 'fixed' ? ' fixedh' : '') + ' theme-' + (st.theme || 'light') + (st.mode === 'dm' ? ' mode-dm' : ' mode-group') + ' skin-' + window.LCM_SKINS.resolveSkin(st);
  phone.style.setProperty('--playful', st.playfulness == null ? 0.5 : st.playfulness);
  const pf = document.querySelector('#set-playful'); if (pf) pf.value = st.playfulness == null ? 0.5 : st.playfulness;
  const screen = $('#phone .screen');
  screen.style.fontFamily = st.font || '';
  screen.style.height = st.height === 'fixed' ? (st.heightPx || 768) + 'px' : '';
  if (st.frameLevel === 'phone') {
    screen.style.borderRadius = st.radius + 'px';
    phone.style.borderRadius = (st.radius + 8) + 'px';
    screen.style.boxShadow = glowShadow(st);
  } else {
    screen.style.borderRadius = '';
    phone.style.borderRadius = '';
    screen.style.boxShadow = glowShadow(st) || '0 8px 30px rgba(0,0,0,0.12)';
  }
  $('#notch').className = 'notch ' + st.notch;
  const sbPad = st.frameLevel === 'phone' ? Math.max(20, Math.round(st.radius * 0.62)) : 14;
  $('#phone .statusbar').style.padding = `0.35rem ${sbPad}px 0.1rem`;
  // 瀏海/動態島寬度動態夾住:不得壓到左時鐘或右圖示叢(實測寬度,含電量數字開關等變因)
  if (st.frameLevel === 'phone' && (st.notch === 'notch' || st.notch === 'island')) {
    const scrW = $('#phone .screen').offsetWidth;
    const side = Math.max($('#clock').offsetWidth, $('#phone .sicons').offsetWidth);
    const maxW = scrW - 2 * (sbPad + side + 6);
    const base = st.notch === 'notch' ? 132 : 78;
    $('#notch').style.width = Math.max(56, Math.min(base, maxW)) + 'px';
  } else {
    $('#notch').style.width = '';
  }
  document.querySelectorAll('.sbtn').forEach((n) => { n.style.display = st.frameLevel === 'phone' && st.buttons ? '' : 'none'; });
  $('#phone .homebar').style.display = st.frameLevel !== 'chat' && st.homebar ? '' : 'none';

  // 狀態列(單一套 icon)
  $('#clock').textContent = st.clock || '16:08';
  $('#wifi-a').style.display = st.wifi ? '' : 'none';
  const bh = Math.max(0.8, 9.6 * st.battery / 100); // 直立電池:由下往上填
  $('#batt-fill-a').setAttribute('height', String(bh));
  $('#batt-fill-a').setAttribute('y', String(4.6 + 9.6 - bh));
  $('#batt-text-a').textContent = st.battery + '%';
  $('#batt-text-a').style.display = st.battText && st.sbBatt !== false ? '' : 'none';
  $('#sig-a-fill').style.clipPath = 'inset(0 ' + (4 - st.signal) * 25 + '% 0 0)'; // 楔形依格數裁切
  $('#alarm-a').style.display = st.sbAlarm !== false ? '' : 'none';
  $('#arrows-a').style.display = st.sbArrows !== false ? '' : 'none';
  $('#volte-a').style.display = st.sbVolte !== false ? '' : 'none';
  $('#sig-a').style.display = st.sbSignal !== false ? '' : 'none';
  $('#batt-a').style.display = st.sbBatt !== false ? '' : 'none';
  if ($('#draft').textContent !== (st.draft || '')) $('#draft').textContent = st.draft || '';
  $('#set-announce').checked = !!st.announceOn;
  $('#set-embplay').checked = !!st.embedAutoplay;
  $('#announce').style.display = st.announceOn && st.frameLevel !== 'chat' ? '' : 'none';
  if ($('#announce-text').textContent !== (st.announce || '')) $('#announce-text').textContent = st.announce || '';

  const dm = st.mode === 'dm';
  $('#chat-title').textContent = st.title;
  $('#chat-members').textContent = !dm && st.members > 0 ? `(${(+st.members).toLocaleString('en-US')})` : ''; // LINE 千分位
  $('#chat-members').style.display = !dm && st.members > 0 ? '' : 'none';
  if (eff === 'real') {
    chatEl.style.background = st.bg;
    chatEl.style.backgroundImage = st.bgImage ? `url(${st.bgImage})` : '';
  } else { // 玩樂 skin:清掉 inline 背景色/圖,讓 .phone.skin-* .line-chat 的 CSS 生效
    chatEl.style.background = '';
    chatEl.style.backgroundImage = '';
  }
  chatEl.style.backgroundSize = 'cover';
  chatEl.style.backgroundPosition = 'center';

  chatEl.innerHTML = '';
  state.messages.forEach((m, i) => {
    let node;
    if (m.type === 'skip' || m.type === 'date') {
      node = el('div', m.type);
      const span = el('span'); span.contentEditable = true; span.textContent = m.text;
      span.addEventListener('input', () => { m.text = span.textContent; save(); });
      node.appendChild(span);
    } else if (m.side === 'right') {
      node = el('div', 'msg me');
      const brow = el('div', 'brow'); // 泡泡+時間同列:時間貼泡泡左下,永不換行(LINE 行為)
      if (m.read || m.time) {
        const meta = el('span', 'read'); meta.contentEditable = true; meta.textContent = [m.read, m.time].filter(Boolean).join('\n');
        meta.style.display = 'inline-block'; meta.style.whiteSpace = 'pre'; meta.style.textAlign = 'right';
        meta.addEventListener('input', () => { const t = meta.innerText.split('\n'); m.read = t.length > 1 ? t[0] : ''; m.time = t[t.length - 1]; save(); });
        brow.appendChild(meta);
      }
      brow.appendChild(content(m, i));
      node.appendChild(brow);
      const rr = reactsRow(m, i); if (rr) node.appendChild(rr);
    } else {
      const prev = state.messages[i - 1];
      const cont = prev && prev.type === 'msg' && prev.side === 'left' && prev.personId === m.personId;
      node = el('div', cont ? 'msg cont' : 'msg');
      if (!cont) {
        const p = personOf(m);
        const av = el('img', 'av'); av.alt = '';
        if (p.avatar) av.src = p.avatar; else av.removeAttribute('src');
        av.title = '點擊換頭像;右鍵下載頭像'; av.addEventListener('click', () => { avatarTarget = p.id; $('#file-avatar').click(); });
        av.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!p.avatar) { toast('這個人物還沒有頭像'); return; } downloadCellImage(p.avatar, 'avatar-' + window.LCM_PURE.safeFileName(p.name) + '.png'); });
        node.appendChild(av);
      }
      const body = el('div', 'mbody');
      if (!cont && state.settings.mode !== 'dm') {
        const p = personOf(m);
        const who = el('span', 'who'); who.contentEditable = true; who.textContent = p.name;
        who.addEventListener('input', () => { p.name = who.textContent; save(); });
        body.appendChild(who);
      }
      const brow = el('div', 'brow'); // 泡泡+時間同列
      brow.appendChild(content(m, i));
      const time = el('span', 'time'); time.contentEditable = true; time.textContent = m.time || '';
      time.addEventListener('input', () => { m.time = time.textContent; save(); });
      brow.appendChild(time);
      body.appendChild(brow);
      const rr = reactsRow(m, i); if (rr) body.appendChild(rr);
      node.appendChild(body);
    }
    node.appendChild(controls(m, i));
    node.style.setProperty('--tilt', tiltUnit(i).toFixed(2) + 'deg'); // 基礎 ±1deg;各 skin 以 --tilt-range 放大;seed(訊息位置索引)穩定 → 重繪/匯出不跳
    chatEl.appendChild(node);
  });
  if (state.settings.height === 'fixed') chatEl.scrollTop = chatEl.scrollHeight;
}

// ── 表情回應:灰笑臉 icon(自繪,非 LINE 資產)+ emoji 或小圖;有回應才顯示整列 ──
const RICON_SVG = '<svg class="ricon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9.2"/><circle cx="8.6" cy="10" r="1.15" fill="currentColor" stroke="none"/><circle cx="15.4" cy="10" r="1.15" fill="currentColor" stroke="none"/><path d="M8 14.2c1 1.5 2.4 2.3 4 2.3s3-.8 4-2.3" stroke-linecap="round"/></svg>';
function reactsRow(m, i) {
  if (!m.react || !m.react.length) return null;
  const row = el('div', 'reacts');
  row.innerHTML = RICON_SVG;
  m.react.forEach((r, ri) => {
    if (typeof r === 'string' && r.startsWith('data:')) {
      const img = document.createElement('img'); img.className = 'remoji'; img.src = r; img.alt = ''; img.title = '點擊移除這顆';
      img.addEventListener('click', () => { m.react.splice(ri, 1); if (!m.react.length) m.react = null; save(); render(); });
      row.appendChild(img);
    } else {
      const sp = el('span', 'remoji'); sp.contentEditable = true; sp.textContent = r;
      sp.addEventListener('input', () => { m.react[ri] = sp.textContent; save(); });
      sp.addEventListener('blur', () => { if (!sp.textContent.trim()) { m.react.splice(ri, 1); if (!m.react.length) m.react = null; save(); render(); } });
      row.appendChild(sp);
    }
  });
  const radd = el('span', 'radd');
  const mk = (label, title, fn) => { const b = el('button'); b.textContent = label; b.title = title; b.addEventListener('click', fn); radd.appendChild(b); };
  mk('+表情', '加一顆 emoji(點了直接改字,清空即移除)', () => { m.react.push('😆'); save(); render(); });
  mk('+圖', '上傳小圖當表情(例如自家貼圖角色)', () => { reactTarget = i; $('#file-avatar').click(); });
  row.appendChild(radd);
  return row;
}

const PLAY_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const FILE_SVG = '<svg viewBox="0 0 24 24" width="22" height="22" fill="#5b8def" aria-hidden="true"><path d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V8h4.5L13 3.5z"/></svg>';

function content(m, i) {
  const kind = m.kind || 'text';
  if (kind === 'image' || kind === 'sticker') {
    const box = el('div', kind === 'image' ? 'imgmsg' : 'sticker');
    const img = document.createElement('img');
    img.src = m.img || 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150"><rect width="200" height="150" fill="#d8dde5"/><text x="100" y="80" text-anchor="middle" font-size="15" fill="#7a8091">' + (kind === 'sticker' ? '點我上傳貼圖' : '點我上傳圖片') + '</text></svg>');
    img.alt = '';
    box.title = '點擊換圖';
    box.addEventListener('click', () => { imgTarget = i; $('#file-avatar').click(); });
    box.appendChild(img);
    return box;
  }
  if (kind === 'voice') {
    const b = el('div', 'bubble');
    const v = el('div', 'voice');
    v.innerHTML = PLAY_SVG + '<span class="vbars">' + [8, 12, 6, 14, 9, 12, 5, 10].map((hgt) => `<i style="height:${hgt}px"></i>`).join('') + '</span>';
    const dur = el('span'); dur.contentEditable = true; dur.textContent = m.dur || '0:12';
    dur.addEventListener('input', () => { m.dur = dur.textContent; save(); });
    v.appendChild(dur);
    b.appendChild(v);
    return b;
  }
  if (kind === 'file') {
    const b = el('div', 'bubble');
    const f = el('div', 'file');
    f.innerHTML = FILE_SVG;
    const meta = el('span', 'fmeta');
    const fn = el('span', 'fname'); fn.contentEditable = true; fn.textContent = m.fname || '報告.pdf';
    fn.addEventListener('input', () => { m.fname = fn.textContent; save(); });
    const fz = el('span', 'fsize'); fz.contentEditable = true; fz.textContent = m.fsize || '2.4 MB';
    fz.addEventListener('input', () => { m.fsize = fz.textContent; save(); });
    meta.appendChild(fn); meta.appendChild(fz);
    f.appendChild(meta);
    b.appendChild(f);
    return b;
  }
  return bubble(m);
}

function bubble(m) {
  const p = el('div', 'bubble');
  if (m.quote) {
    const q = el('div', 'q');
    const qp = state.people.find((x) => x.name === m.quote.name); // 名字對得上人物就帶他的頭像
    const qa = document.createElement('img'); qa.className = 'qav'; qa.alt = '';
    if (qp && qp.avatar) qa.src = qp.avatar;
    q.appendChild(qa);
    const qtxt = el('span', 'qtxt');
    const nm = el('strong'); const nmt = el('span'); nmt.contentEditable = true; nmt.textContent = m.quote.name;
    nmt.addEventListener('input', () => { m.quote.name = nmt.textContent; save(); }); nm.appendChild(nmt);
    const qt = el('span'); qt.contentEditable = true; qt.textContent = m.quote.text;
    qt.addEventListener('input', () => { m.quote.text = qt.textContent; save(); });
    qtxt.appendChild(nm); qtxt.appendChild(qt); q.appendChild(qtxt); p.appendChild(q);
  }
  const txt = el('div', 'btxt'); const ts = el('span'); ts.contentEditable = true; ts.textContent = m.text;
  ts.addEventListener('input', () => { m.text = ts.textContent; save(); }); txt.appendChild(ts);
  p.appendChild(txt);
  return p;
}

function controls(m, i) {
  const c = el('div', 'ctl');
  const btn = (label, title, fn) => { const b = el('button'); b.textContent = label; b.title = title; b.addEventListener('click', fn); c.appendChild(b); };
  btn('↑', '上移', () => { if (i > 0) { state.messages.splice(i - 1, 0, state.messages.splice(i, 1)[0]); save(); render(); } });
  btn('↓', '下移', () => { if (i < state.messages.length - 1) { state.messages.splice(i + 1, 0, state.messages.splice(i, 1)[0]); save(); render(); } });
  if (m.type === 'msg') {
    if ((m.kind === 'image' || m.kind === 'sticker') && m.imgPrompt && window.lcmRegenImage) btn('重生', 'AI 重畫這張圖(可還原)', () => window.lcmRegenImage(i));
    if ((m.kind === 'image' || m.kind === 'sticker') && m.img) btn('下載', '下載這張圖,改完可用「點擊換圖」重新上傳', () => downloadCellImage(m.img, m.kind === 'sticker' ? 'sticker-' + i + '.png' : 'image-' + i + '.jpg'));
    btn('⇄', '換邊', () => { if (m.side === 'left') { m.side = 'right'; m.read = m.read || ''; } else { m.side = 'left'; m.personId = m.personId || state.people[0].id; } save(); render(); });
    if ((m.kind || 'text') === 'text') btn('引', '加/移除引用回覆', () => { m.quote = m.quote ? null : { name: '某人', text: '被引用的訊息' }; save(); render(); });
    btn('心', '加/移除表情回應', () => { m.react = m.react && m.react.length ? null : ['😆']; save(); render(); });
    if (m.side === 'left') {
      btn('換人', '換成下一位既有人物', () => { const idx = state.people.findIndex((p) => p.id === m.personId); m.personId = state.people[(idx + 1) % state.people.length].id; save(); render(); });
      btn('新人', '建立新人物並指給這則訊息', () => { const p = { id: 'p' + Date.now(), name: '新朋友(點我改名)', avatar: null }; state.people.push(p); m.personId = p.id; save(); render(); });
    }
  }
  btn('✕', '刪除', () => { state.messages.splice(i, 1); save(); render(); });
  return c;
}

function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }

// ── 下載對話內單張圖:輸出使用者上傳/AI 生成的原圖(data URL),供外部改圖後,再走既有「點擊換圖/換頭像」重新上傳 ──
// 刻意不加浮水印/隱形識別:這是可再編輯的素材源;合成後的 PNG/MP4 匯出才會烙印。與 PNG/JSON 匯出同一套 a.download 手法。
function downloadCellImage(dataUrl, filename) {
  const a = document.createElement('a');
  a.download = window.LCM_PURE.downloadName(dataUrl, filename); // 檔名安全化 + 副檔名邏輯見 pure.js
  a.href = dataUrl;
  a.click();
}

// ── 設定面板 ──
$('#set-title').addEventListener('input', (e) => { state.settings.title = e.target.value; save(); render(); });
$('#set-members').addEventListener('input', (e) => { state.settings.members = +e.target.value || 0; save(); render(); });
$('#set-bg').addEventListener('input', (e) => { state.settings.bg = e.target.value; save(); render(); });
$('#set-frame-level').addEventListener('change', (e) => { state.settings.frameLevel = e.target.value; save(); render(); });
$('#set-notch').addEventListener('change', (e) => { state.settings.notch = e.target.value; save(); render(); });
$('#set-radius').addEventListener('input', (e) => { state.settings.radius = +e.target.value; save(); render(); });
$('#set-buttons').addEventListener('change', (e) => { state.settings.buttons = e.target.checked; save(); render(); });
$('#set-homebar').addEventListener('change', (e) => { state.settings.homebar = e.target.checked; save(); render(); });
$('#set-signal').addEventListener('input', (e) => { state.settings.signal = +e.target.value; save(); render(); });
$('#set-wifi').addEventListener('change', (e) => { state.settings.wifi = e.target.checked; save(); render(); });
$('#set-sb-alarm').addEventListener('change', (e) => { state.settings.sbAlarm = e.target.checked; save(); render(); });
$('#set-sb-arrows').addEventListener('change', (e) => { state.settings.sbArrows = e.target.checked; save(); render(); });
$('#set-sb-volte').addEventListener('change', (e) => { state.settings.sbVolte = e.target.checked; save(); render(); });
$('#set-sb-signal').addEventListener('change', (e) => { state.settings.sbSignal = e.target.checked; save(); render(); });
$('#set-sb-batt').addEventListener('change', (e) => { state.settings.sbBatt = e.target.checked; save(); render(); });
$('#set-sb-all').addEventListener('change', (e) => {
  const v = e.target.checked;
  Object.assign(state.settings, { sbAlarm: v, wifi: v, sbArrows: v, sbVolte: v, sbSignal: v, sbBatt: v });
  save(); render();
});
$('#set-battery').addEventListener('input', (e) => { state.settings.battery = +e.target.value; save(); render(); });
$('#set-batttext').addEventListener('change', (e) => { state.settings.battText = e.target.checked; save(); render(); });
$('#set-glow').addEventListener('input', (e) => { state.settings.glow = +e.target.value; save(); render(); });
$('#set-glowcolor').addEventListener('input', (e) => { state.settings.glowColor = e.target.value; save(); render(); });
$('#set-darkui').addEventListener('change', (e) => { state.settings.darkUI = e.target.checked; save(); render(); });
$('#set-backlight').addEventListener('input', (e) => { state.settings.backlight = +e.target.value; save(); render(); });
$('#set-backcolor').addEventListener('input', (e) => { state.settings.backColor = e.target.value; save(); render(); });
$('#draft').addEventListener('input', () => { state.settings.draft = $('#draft').textContent; save(); });
$('#set-announce').addEventListener('change', (e) => { state.settings.announceOn = e.target.checked; save(); render(); });
$('#set-embplay').addEventListener('change', (e) => { state.settings.embedAutoplay = e.target.checked; save(); });
$('#announce-text').addEventListener('input', () => { state.settings.announce = $('#announce-text').textContent; save(); });
$('#set-bgimg').addEventListener('click', () => { bgTarget = true; $('#file-avatar').click(); });
$('#clear-bgimg').addEventListener('click', () => { state.settings.bgImage = null; save(); render(); });
$('#set-watermark').addEventListener('change', (e) => { state.settings.watermark = e.target.checked; save(); render(); });
$('#set-wmtext').addEventListener('input', (e) => { state.settings.wmText = e.target.value; save(); render(); });
$('#set-clock').addEventListener('input', (e) => { state.settings.clock = e.target.value; save(); render(); });
$('#set-height').addEventListener('change', (e) => { state.settings.height = e.target.value; save(); render(); });
$('#set-mode').addEventListener('change', (e) => { state.settings.mode = e.target.value; save(); render(); });
$('#set-syscolor').addEventListener('input', (e) => { state.settings.sysColor = e.target.value; save(); render(); });
$('#syscolor-reset').addEventListener('click', () => { state.settings.sysColor = state.settings.theme === 'dark' ? '#0f1216' : '#2d3b4e'; save(); render(); });
$('#set-theme').addEventListener('change', (e) => {
  state.settings.theme = e.target.value; // 切佈景順手帶合理系統色(仍可再改)
  state.settings.sysColor = e.target.value === 'dark' ? '#0f1216' : '#2d3b4e';
  save(); render();
});
// 填 skin 選單(六款,含真實)
(function initSkinPicker() {
  const sel = document.querySelector('#set-skin');
  sel.innerHTML = '';
  for (const s of window.LCM_SKINS.SKINS) {
    const o = document.createElement('option');
    o.value = s.id; o.textContent = s.label;
    sel.appendChild(o);
  }
})();
document.querySelector('#set-skin').addEventListener('change', (e) => {
  state.settings.skin = e.target.value;
  save(); render();
});
document.querySelector('#set-playful').addEventListener('input', (e) => {
  state.settings.playfulness = parseFloat(e.target.value);
  document.querySelector('#phone').style.setProperty('--playful', state.settings.playfulness);
  // 只動 CSS 變數即時反映,不必整頁重繪;仍需存檔
  save();
});
$('#set-aifab').addEventListener('change', (e) => { state.settings.aiFab = e.target.checked; save(); render(); });
$('#set-heightpx').addEventListener('input', (e) => { state.settings.heightPx = Math.max(300, +e.target.value || 768); save(); render(); });
$('#set-font').addEventListener('change', async (e) => {
  const v = e.target.value;
  if (v === '__local') { // 讀本機字體清單(Chromium 限定),讀完回填 optgroup 再讓使用者挑
    e.target.value = state.settings.font || '';
    if (!('queryLocalFonts' in window)) { alert('此瀏覽器不支援讀取本機字體(需要 Chrome / Edge)。'); return; }
    try {
      const fams = Array.from(new Set((await window.queryLocalFonts()).map((f) => f.family)));
      let og = e.target.querySelector('optgroup');
      if (!og) { og = document.createElement('optgroup'); og.label = '本機字體'; e.target.appendChild(og); }
      og.innerHTML = '';
      fams.forEach((f) => { const o = document.createElement('option'); o.value = `"${f}"`; o.textContent = f; og.appendChild(o); });
      toast('本機字體已載入(' + fams.length + ' 款),再從選單挑一次');
    } catch (err) { console.warn('本機字體讀取失敗', err); }
    return;
  }
  state.settings.font = v; save(); render();
});

// ── 新增 ──
function addLeft() {
  let pid = state.people[0] && state.people[0].id;
  for (let i = state.messages.length - 1; i >= 0; i--) { const m = state.messages[i]; if (m.type === 'msg' && m.side === 'left') { pid = m.personId; break; } }
  if (!pid) { const p = { id: 'p' + Date.now(), name: '新朋友', avatar: null }; state.people.push(p); pid = p.id; }
  state.messages.push({ type: 'msg', side: 'left', personId: pid, text: '點我改文字', time: '下午4:00', read: '', quote: null }); save(); render();
}
function lastLeftPid() { for (let i = state.messages.length - 1; i >= 0; i--) { const m = state.messages[i]; if (m.type === 'msg' && m.side === 'left') return m.personId; } return state.people[0] && state.people[0].id; }

// ── 圖片上傳(頭像 96 PNG / 背景 800 JPEG / 圖片訊息 480 JPEG / 貼圖 320 PNG 保留透明) ──
$('#file-avatar').addEventListener('change', (e) => {
  const f = e.target.files[0]; if (!f) return;
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    if (bgTarget) {
      const sc = Math.min(1, 800 / img.width);
      c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      state.settings.bgImage = c.toDataURL('image/jpeg', 0.85);
      bgTarget = false;
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
    } else if (reactTarget !== null) {
      const m = state.messages[reactTarget];
      c.width = c.height = 64;
      const s = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 64, 64);
      if (m) (m.react = m.react || []).push(c.toDataURL('image/png'));
      reactTarget = null;
    } else if (avatarTarget) {
      c.width = c.height = 96;
      const s = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 96, 96);
      const p = state.people.find((x) => x.id === avatarTarget);
      if (p) p.avatar = c.toDataURL('image/png');
      avatarTarget = null;
    }
    save(); render();
  };
  img.src = URL.createObjectURL(f);
  e.target.value = '';
});

// ── 隱形識別三層:iTXt metadata + alpha-LSB 藏字串 + 平滑藍場紋 ──
// 對外只承諾「提高濫用成本、可供識別」;開源工具擋不住有心人。驗證頁:verify.html
// 格紋用座標偽隨機而非文字遮罩:字型渲染跨平台不一致,幾何格紋才能在驗證端位元級重現
const BRAND_TEXT = 'LCM1|line-chat-maker 示意圖(非真實對話)|https://yazelin.github.io/line-chat-maker/';
function blockSign(i, j) { // 場紋節點 ±1;週期 8 節點(128px),裁切後可搜尋比對
  let h = Math.imul((i & 7) + 1, 73856093) ^ Math.imul((j & 7) + 1, 19349663);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
  return ((h ^ (h >>> 15)) & 1) ? 1 : -1;
}
function brandField(im, W, H) { // 只嵌藍場紋:PNG 與 MP4 共用。影片的 iTXt/alpha-LSB 兩層在 yuv420 編碼會失真,只有場紋撐得住重壓縮(實測見 docs/watermark.md)
  const d = im.data;
  // 場紋:16px 節點 ±1 → smoothstep 雙線性內插成平滑場,只動藍色通道 ±2
  // 硬邊格紋在平坦底色會 banding(實測肉眼可見);平滑消除邊緣、藍通道利用人眼對藍的低解析度
  const ss = (t) => t * t * (3 - 2 * t);
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]; // 4x4 有序抖動:round 會產生量化等高線(平坦底色可見),抖散成高頻微噪;區塊均值不變
  const nCols = (W >> 4) + 2;
  const rowA = new Float64Array(nCols), rowB = new Float64Array(nCols);
  for (let y = 0; y < H; y++) {
    const gy = y >> 4;
    if ((y & 15) === 0 || y === 0) for (let g = 0; g < nCols; g++) { rowA[g] = blockSign(g, gy); rowB[g] = blockSign(g, gy + 1); }
    const fy = ss(((y & 15) + 0.5) / 16);
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      if (d[p + 3] < 250) continue; // 半透明像素 premultiply 會失真,跳過
      const gx = x >> 4, fx = ss(((x & 15) + 0.5) / 16);
      const s = (rowA[gx] * (1 - fx) + rowA[gx + 1] * fx) * (1 - fy) + (rowB[gx] * (1 - fx) + rowB[gx + 1] * fx) * fy;
      // 近白/近黑:振幅減半(截波後只剩單邊 -1..0),白上 -2 平滑斑實測可見、-1 是折衷;
      // 訊號弱化由偵測端的平坦區統計補(白圖平坦區雜訊近零,半幅訊號 SNR 仍夠)
      const b0 = d[p + 2];
      const a = (b0 >= 253 || b0 <= 2) ? 1 : 2;
      const v = b0 + Math.floor(a * s + (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16);
      d[p + 2] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
}
function brandPixels(canvas) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const im = ctx.getImageData(0, 0, W, H), d = im.data;
  brandField(im, W, H);
  const bytes = new TextEncoder().encode(BRAND_TEXT); // alpha LSB:2 bytes 長度 + UTF-8
  const all = [(bytes.length >> 8) & 255, bytes.length & 255, ...bytes];
  for (let k = 0; k < all.length * 8 && k * 4 + 3 < d.length; k++) {
    const bit = (all[k >> 3] >> (7 - (k & 7))) & 1;
    d[k * 4 + 3] = (d[k * 4 + 3] & 254) | bit;
  }
  ctx.putImageData(im, 0, 0);
}
const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; } return t; })();
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function pngWithMeta(canvas) { // IHDR 後插一個 iTXt chunk(tEXt 只吃 Latin-1,中文要 iTXt)
  const src = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), (ch) => ch.charCodeAt(0));
  const enc = new TextEncoder();
  const body = Uint8Array.from([...enc.encode('Comment'), 0, 0, 0, 0, 0, ...enc.encode(BRAND_TEXT)]);
  const chunk = new Uint8Array(12 + body.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, body.length);
  chunk.set(enc.encode('iTXt'), 4);
  chunk.set(body, 8);
  dv.setUint32(8 + body.length, crc32(chunk.subarray(4, 8 + body.length)));
  const out = new Uint8Array(src.length + chunk.length);
  out.set(src.subarray(0, 33)); out.set(chunk, 33); out.set(src.subarray(33), 33 + chunk.length); // 33 = PNG 簽名 8 + IHDR 25
  let s = ''; for (let i = 0; i < out.length; i += 32768) s += String.fromCharCode.apply(null, out.subarray(i, i + 32768));
  return 'data:image/png;base64,' + btoa(s);
}

// ── 匯出 PNG:SVG foreignObject 真渲染(與預覽像素一致);失敗時 html2canvas 備援 ──
function cleanClone() {
  const clone = $('#phone-wrap').cloneNode(true);
  const wmp = clone.querySelector('.wm-preview'); if (wmp) wmp.remove();
  clone.querySelectorAll('.ctl, .chat-addbar, .radd').forEach((n) => n.remove());
  clone.querySelectorAll('[contenteditable]').forEach((n) => n.removeAttribute('contenteditable'));
  return clone;
}

async function renderCanvasNative() {
  const src = $('#phone-wrap');
  const w = src.offsetWidth, h = src.offsetHeight, scale = 2;
  // 邊距=各視覺效果的實際外溢量,陰影/光暈/背光都不能被切
  const st = state.settings;
  let pad = 44;                                            // level-screen/chat 陰影(8+30)
  if (st.frameLevel === 'phone') pad = Math.max(pad, 96);  // 機身陰影(24+60)
  if (st.glow > 0) pad = Math.max(pad, st.glow + 20);      // 螢幕光暈
  if (st.backlight > 0) pad = Math.max(pad, 210);          // 背光(inset -130 + blur 60)
  const css = await (await fetch('style.css')).text();
  const wrapEl = document.createElement('div');
  wrapEl.setAttribute('style', `--accent:#06c755;--fg:#1c1917;--muted:#6b6560;--border:#e5e2de;padding:${pad}px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans TC','Microsoft JhengHei',sans-serif;line-height:1.6;color:#1c1917;`);
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  wrapEl.appendChild(styleEl);
  wrapEl.appendChild(cleanClone());
  const xhtml = new XMLSerializer().serializeToString(wrapEl);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${(w + pad * 2) * scale}" height="${(h + pad * 2) * scale}" viewBox="0 0 ${w + pad * 2} ${h + pad * 2}"><foreignObject width="${w + pad * 2}" height="${h + pad * 2}">${xhtml}</foreignObject></svg>`;
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = (w + pad * 2) * scale; canvas.height = (h + pad * 2) * scale;
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  canvas.toDataURL('image/png'); // 提早觸發 taint 檢查,污染會在這裡丟例外
  return canvas;
}

async function renderCanvasFallback() {
  return html2canvas($('#phone-wrap'), {
    scale: 2, backgroundColor: null, logging: false,
    onclone: (doc) => {
      doc.querySelectorAll('.ctl, .chat-addbar, .radd').forEach((n) => n.remove());
      doc.querySelectorAll('[contenteditable]').forEach((n) => n.removeAttribute('contenteditable'));
    },
  });
}

// ── 匯出 MP4:重演播放時序,固定 30fps foreignObject 逐幀渲染(氣泡淡入/捲動內插)→ WebCodecs H.264 → mp4-muxer 封裝 ──
let _exportCss = null;
async function exportFrameCanvas(scale, fixedW, fixedH) {
  const src = $('#phone-wrap');
  const w = src.offsetWidth, h = src.offsetHeight;
  const st = state.settings;
  let pad = 44;
  if (st.frameLevel === 'phone') pad = Math.max(pad, 96);
  if (st.glow > 0) pad = Math.max(pad, st.glow + 20);
  if (st.backlight > 0) pad = Math.max(pad, 210);
  if (!_exportCss) _exportCss = await (await fetch('style.css')).text();
  const clone = cleanClone();
  const chat = clone.querySelector('.line-chat');
  const sTop = chatEl.scrollTop;
  if (chat && sTop > 0) { // 序列化不保留 scrollTop:包一層 translateY 模擬捲動
    const wrap = document.createElement('div');
    while (chat.firstChild) wrap.appendChild(chat.firstChild);
    wrap.style.transform = `translateY(-${sTop}px)`;
    chat.appendChild(wrap);
    chat.style.overflow = 'hidden';
  }
  const wrapEl = document.createElement('div');
  wrapEl.setAttribute('style', `--accent:#06c755;--fg:#1c1917;--muted:#6b6560;--border:#e5e2de;padding:${pad}px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans TC','Microsoft JhengHei',sans-serif;line-height:1.6;color:#1c1917;`);
  const styleEl = document.createElement('style');
  styleEl.textContent = _exportCss;
  wrapEl.appendChild(styleEl);
  wrapEl.appendChild(clone);
  const xhtml = new XMLSerializer().serializeToString(wrapEl);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${(w + pad * 2) * scale}" height="${(h + pad * 2) * scale}" viewBox="0 0 ${w + pad * 2} ${h + pad * 2}"><foreignObject width="${w + pad * 2}" height="${h + pad * 2}">${xhtml}</foreignObject></svg>`;
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = fixedW; canvas.height = fixedH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#faf9f7'; ctx.fillRect(0, 0, fixedW, fixedH); // 尺寸微差時的底色
  ctx.drawImage(img, 0, 0, (w + pad * 2) * scale, (h + pad * 2) * scale);
  if (st.watermark) {
    const wp = Math.round(fixedW / 20);
    ctx.font = `${Math.round(fixedW / 30)}px sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fillText(wmText(), fixedW - wp + 2, fixedH - wp + 2);
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillText(wmText(), fixedW - wp, fixedH - wp);
  }
  return canvas;
}
$('#export-mp4').addEventListener('click', async () => {
  if (!('VideoEncoder' in window) || typeof Mp4Muxer === 'undefined') { alert('匯出 MP4 需要支援 WebCodecs 的瀏覽器(建議 Chrome / Edge)。'); return; }
  const btn = $('#export-mp4');
  const oldLabel = btn.textContent;
  btn.disabled = true;
  const nodes = Array.from(chatEl.children);
  const draftEl = $('#draft');
  const draftText = state.settings.draft || '';
  try {
    _exportCss = null;
    // 解析度量「完整草稿」狀態(最高版面);打字過程輸入列從單行自然長高,不預先撐高
    const src = $('#phone-wrap');
    const st = state.settings;
    let pad = 44;
    if (st.frameLevel === 'phone') pad = Math.max(pad, 96);
    if (st.glow > 0) pad = Math.max(pad, st.glow + 20);
    if (st.backlight > 0) pad = Math.max(pad, 210);
    const rawW = src.offsetWidth + pad * 2, rawH = src.offsetHeight + pad * 2;
    let scale = Math.min(2, Math.sqrt(8_000_000 / (rawW * rawH)), 4000 / rawW, 4000 / rawH); // H.264 級別與硬體編碼上限
    const W = Math.floor(rawW * scale / 2) * 2, H = Math.floor(rawH * scale / 2) * 2;
    // 時序表(與播放一致):開場停 0.8s → 每則 0.65s → 停 0.7s → 草稿 75ms/字 → 收尾 1.5s
    // 訊息步只回報「要捲多少」,實際捲動交給幀迴圈內插成平滑動畫
    const steps = [
      // 封面(= MP4 第一幀/縮圖):完整對話已載入、捲到最上,看得到開頭;供分享時當預覽圖
      { hold: 900, apply() { nodes.forEach((n) => { n.style.visibility = ''; n.classList.remove('appear'); n.style.opacity = ''; n.style.transform = ''; }); if (draftText) draftEl.textContent = ''; chatEl.scrollTop = 0; } },
      // 清空,準備逐則重演
      { hold: 250, apply() { nodes.forEach((n) => { n.style.visibility = 'hidden'; n.classList.remove('appear'); }); chatEl.scrollTop = 0; } },
    ];
    nodes.forEach((n) => steps.push({ hold: 650, bubble: n, apply() {
      n.style.visibility = '';
      const nb = n.getBoundingClientRect(), cb = chatEl.getBoundingClientRect();
      return nb.bottom > cb.bottom ? nb.bottom - cb.bottom : 0;
    } }));
    if (draftText) {
      steps.push({ hold: 700, apply() {} });
      for (let i = 1; i <= draftText.length; i++) { const k = i; steps.push({ hold: 75, apply() { draftEl.textContent = draftText.slice(0, k); } }); }
    }
    steps.push({ hold: 1500, apply() {} });
    // 攤成絕對時間軸,固定 30fps(CFR,剪輯軟體友善):氣泡淡入+捲動逐幀內插,靜止段重用畫面只重編碼
    const FPS = 30, ANIM = 300; // ANIM 對齊 lcmIn 0.3s
    const events = []; let totalMs = 0;
    steps.forEach((s) => { events.push({ at: totalMs, step: s }); totalMs += s.hold; });
    const totalFrames = Math.round(totalMs * FPS / 1000);
    const easeOut = (p) => 1 - (1 - p) * (1 - p);

    const muxer = new Mp4Muxer.Muxer({ target: new Mp4Muxer.ArrayBufferTarget(), video: { codec: 'avc', width: W, height: H }, fastStart: 'in-memory' });
    let encErr = null;
    const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encErr = e; } });
    encoder.configure({ codec: 'avc1.640033', width: W, height: H, bitrate: 6_000_000 });
    const anims = []; // 進行中的氣泡動畫 {node, scrollFrom, scrollBy, startMs}
    let ei = 0, dirty = true, lastCanvas = null;
    for (let f = 0; f < totalFrames; f++) {
      const nowMs = f * 1000 / FPS;
      while (ei < events.length && events[ei].at <= nowMs) {
        const { at, step } = events[ei++];
        const scrollBy = step.apply() || 0;
        if (step.bubble) anims.push({ node: step.bubble, scrollFrom: chatEl.scrollTop, scrollBy, startMs: at, baseTf: getComputedStyle(step.bubble).transform });
        dirty = true;
      }
      for (let k = anims.length - 1; k >= 0; k--) {
        const a = anims[k], p = (nowMs - a.startMs) / ANIM;
        if (p >= 1) {
          a.node.style.opacity = ''; a.node.style.transform = '';
          chatEl.scrollTop = a.scrollFrom + a.scrollBy;
          anims.splice(k, 1);
        } else {
          const e2 = easeOut(Math.max(p, 0));
          const s = (0.82 + 0.18 * e2).toFixed(3);            // 進場 scale .82→1 的俏皮 pop(取代單純上移)
          const base = a.baseTf && a.baseTf !== 'none' ? a.baseTf + ' ' : ''; // 保留該則 skin 傾斜,不被進場 transform 覆蓋
          a.node.style.opacity = e2.toFixed(3);
          a.node.style.transform = `${base}scale(${s})`;
          if (a.scrollBy) chatEl.scrollTop = a.scrollFrom + a.scrollBy * e2;
        }
        dirty = true;
      }
      if (dirty) {
        lastCanvas = await exportFrameCanvas(scale, W, H);
        const fctx = lastCanvas.getContext('2d'); // 每次重繪就把隱形場紋烤進去(靜止段沿用同一張,場紋逐幀一致 → 驗證端多幀平均更穩)
        const fim = fctx.getImageData(0, 0, W, H);
        brandField(fim, W, H);
        fctx.putImageData(fim, 0, 0);
        dirty = false;
      }
      const frame = new VideoFrame(lastCanvas, { timestamp: Math.round(f * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
      encoder.encode(frame, { keyFrame: f % 60 === 0 });
      frame.close();
      if (encErr) throw encErr;
      btn.textContent = `匯出中 ${f + 1}/${totalFrames}`;
      await new Promise((r) => setTimeout(r, 0));
    }
    await encoder.flush();
    muxer.finalize();
    const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
    const a = document.createElement('a');
    a.download = 'line-chat.mp4';
    a.href = URL.createObjectURL(blob);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
    toast(`MP4 已匯出(${Math.round(totalMs / 1000)} 秒,${W}x${H},30fps,無聲;每幀都帶隱形識別場紋,可在驗證頁查驗)`);
  } catch (e) {
    console.warn('MP4 匯出失敗', e);
    alert('MP4 匯出失敗:' + ((e && e.message) || e));
  }
  btn.disabled = false;
  btn.textContent = oldLabel;
  render();
});

$('#export-png').addEventListener('click', async () => {
  let canvas;
  try { canvas = await renderCanvasNative(); }
  catch (e) { console.warn('foreignObject 匯出失敗,改用 html2canvas', e); canvas = await renderCanvasFallback(); }
  if (state.settings.watermark) {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const pad = Math.round(canvas.width / 20);
    ctx.font = `${Math.round(canvas.width / 30)}px sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(wmText(), canvas.width - pad + 2, canvas.height - pad + 2);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillText(wmText(), canvas.width - pad, canvas.height - pad);
  }
  brandPixels(canvas);
  const a = document.createElement('a');
  a.download = 'line-chat.png';
  a.href = pngWithMeta(canvas);
  a.click();
});

// ── 匯出 HTML:可內嵌片段(scoped CSS,貼進任何頁面即用) ──
$('#export-html').addEventListener('click', async () => {
  const cssRaw = await (await fetch('style.css')).text();
  const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, ''); // 剝註解,避免規則被誤判丟棄
  const keep = /^(\.phone|\.screen|\.statusbar|\.linehead|\.inputbar|\.homebar|\.notch|\.line-chat|\.announce)/;
  const scoped = css.split('}').map((chunk) => {
    const i = chunk.indexOf('{');
    if (i < 0) return '';
    const sels = chunk.slice(0, i).trim().split(',').map((s) => s.trim()).filter((s) => keep.test(s));
    if (!sels.length) return '';
    return sels.map((s) => '.lcm-embed ' + s).join(',') + '{' + chunk.slice(i + 1) + '}';
  }).filter(Boolean).join('\n');
  const clone = cleanClone();
  const wm = state.settings.watermark ? '<div style="text-align:right;font:12px/1.6 sans-serif;color:rgba(0,0,0,0.45)">' + wmText().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>' : '';
  const reset = '.lcm-embed *{margin:0;padding:0;border:0;border-radius:0;box-shadow:none;box-sizing:border-box;background:none;font:inherit;color:inherit;}';
  const autoplay = !!state.settings.embedAutoplay;
  const embJs = `<script>(function(){var s=document.currentScript,r=s.closest('.lcm-embed');s.remove();var c=r.querySelector('.line-chat');function bottom(){if(c)c.scrollTop=c.scrollHeight}bottom();${autoplay ? "var ms=[].slice.call(r.querySelectorAll('.line-chat>div'));var f=r.querySelector('.fakein'),dt=f?f.textContent:'';var playing=false;function play(){if(playing)return;playing=true;ms.forEach(function(m){m.style.visibility='hidden';m.style.animation='none'});if(f&&dt)f.textContent='';if(c)c.scrollTop=0;var i=0;(function st(){if(i>=ms.length){if(f&&dt){var j=0;setTimeout(function tp(){if(j<dt.length){f.textContent=dt.slice(0,++j);setTimeout(tp,75)}else{playing=false}},700)}else{playing=false}return}var m=ms[i++];m.style.visibility='';void m.offsetWidth;m.style.animation='lcmIn .3s ease-out';if(c){var nb=m.getBoundingClientRect(),qb=c.getBoundingClientRect();if(nb.bottom>qb.bottom)c.scrollTop+=nb.bottom-qb.bottom}setTimeout(st,650)})()}var io=new IntersectionObserver(function(en){if(en[en.length-1].isIntersecting)play()},{threshold:0.4});io.observe(r);" : ''}})();<\/script>`;
  const html = `<!-- LINE 對話製造機產生的內嵌片段:整段貼進你的頁面即可顯示。僅供創作示意 https://yazelin.github.io/line-chat-maker/ -->\n<div class="lcm-embed" style="max-width:24rem;margin:1.5rem auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans TC','Microsoft JhengHei',sans-serif;line-height:1.6;">\n${clone.outerHTML}\n${wm}\n${embJs}\n</div>\n<style>\n${reset}\n${scoped}\n@keyframes lcmIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }\n</style>`;
  try {
    await navigator.clipboard.writeText(html);
    alert('嵌入碼已複製!貼進部落格、CMS 或任何網頁的 HTML 區塊即可顯示。');
  } catch (e) {
    const aEl = document.createElement('a');
    aEl.download = 'line-chat-embed.html';
    aEl.href = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    aEl.click();
  }
});

// ── 分享連結:短網址(Cloudflare Worker KV);失敗時退回 #s= 長連結 ──
const SHORTURL_API = 'https://shorturl.yazelinj303.workers.dev';
document.querySelector('#share-link').addEventListener('click', async () => {
  let url;
  try {
    const r = await fetch(SHORTURL_API + '/api/short-url', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: 'line-chat-maker', state }),
    });
    const d = await r.json();
    if (!d.shortUrl) throw new Error(d.error || 'no shortUrl');
    url = d.shortUrl;
  } catch (e) {
    console.warn('短網址服務失敗,退回長連結', e);
    const toB64 = (str) => btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    url = location.origin + location.pathname + '#s=' + toB64(JSON.stringify(state));
  }
  try { await navigator.clipboard.writeText(url); alert('分享連結已複製!對方打開就是這段對話(連結保存一年)。'); }
  catch (e) { prompt('手動複製這個連結:', url); }
});

// 短連結載入:?id=code → 向 worker 取回,開成新草稿(主要分享路徑,boot 尾端呼叫)
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
  blank.settings.title = '新對話'; blank.settings.members = 0; blank.settings.draft = ''; blank.settings.announceOn = false; blank.messages = [];
  activate(await createDraft(blank, '新對話'));
  render(); renderDrafts();
});
$('#load-presets').addEventListener('click', loadPresetsToDrafts);
document.querySelector('.tabs [data-pane="drafts"]').addEventListener('click', renderDrafts);

// ── 共享區 ──
// 作品本體不存在這裡:牆上只有短碼索引,內容照樣向 shorturl 取,跟分享連結同一條路。
// 端點可用 localStorage 的 lcm-wall-api 覆寫,只給本機對著 wrangler dev 驗收用;正式站不會有這個值。
const WALL_API = (() => { try { return localStorage.getItem('lcm-wall-api') || 'https://lcm-ai-proxy.yazelinj303.workers.dev'; } catch (e) { return 'https://lcm-ai-proxy.yazelinj303.workers.dev'; } })();
const WALL_EVENT = 'chat-2026-08-12';
const WALL_OWN_KEY = 'lcm-wall-own'; // { 作品id: ownerToken },只存在這台瀏覽器,換裝置就找不回自己的作品

const wallOwn = () => { try { return JSON.parse(localStorage.getItem(WALL_OWN_KEY)) || {}; } catch (e) { return {}; } };
const wallOwnSet = (id, token) => { const m = wallOwn(); m[id] = token; try { localStorage.setItem(WALL_OWN_KEY, JSON.stringify(m)); } catch (e) {} };
const wallOwnDel = (id) => { const m = wallOwn(); delete m[id]; try { localStorage.setItem(WALL_OWN_KEY, JSON.stringify(m)); } catch (e) {} };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function wallList() {
  const r = await fetch(WALL_API + '/api/wall/events/' + WALL_EVENT + '/submissions');
  const d = await r.json();
  return Array.isArray(d.submissions) ? d.submissions : [];
}

async function wallFetchState(code) { // 作品本體在既有短碼服務,共享區只有索引
  const r = await fetch(SHORTURL_API + '/api/template/' + encodeURIComponent(code));
  const d = await r.json();
  if (!d || !d.state || !Array.isArray(d.state.messages)) throw new Error('這份作品讀不回來');
  return d.state;
}

// ponytail: 一次只活一份。render() 只認全域 state 與單一 #phone,同頁要活 N 份得改寫渲染器
// 或開 N 個 iframe,兩個都太重;真的需要多份同時動再說。這招跟匯出內嵌片段用的是同一個做法。
function wallSnapshot(incoming) {
  const keep = state;
  state = migrate(incoming); render();
  const shot = $('#phone').cloneNode(true);
  state = keep; render();
  shot.removeAttribute('id');
  return shot;
}

async function wallPreview(s) {
  let incoming;
  try { incoming = await wallFetchState(s.code); } catch (e) { toast('這份作品讀不回來'); return; }
  const mask = el('div', 'wall-mask');
  const box = el('div', 'wall-modal');
  const head = el('div', 'wall-modal-head');
  const ttl = el('span', 'wall-modal-title');
  ttl.textContent = (s.title || '未命名') + '・' + s.display_name;
  const use = el('button'); use.textContent = '打開來用';
  const close = el('button'); close.textContent = '關閉';
  use.addEventListener('click', () => { mask.remove(); wallOpen(s); });
  close.addEventListener('click', () => mask.remove());
  mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
  head.append(ttl, use, close);
  box.append(head, wallSnapshot(incoming));
  mask.append(box);
  document.body.append(mask);
}

async function wallOpen(s) { // 走跟 ?id= 完全一樣的路徑:一律開成新草稿,不覆蓋
  let incoming;
  try { incoming = await wallFetchState(s.code); } catch (e) { toast('這份作品讀不回來'); return; }
  activate(await adoptIncoming(incoming));
  render(); renderDrafts();
  document.querySelector('.tabs [data-pane="chatset"]').click();
  toast('已開成新草稿,你原本的創作都在「草稿」分頁');
}

async function wallDelete(s) {
  const token = wallOwn()[s.id];
  if (!token) { toast('這不是你投的作品'); return; }
  if (!confirm('確定要把「' + (s.title || '未命名') + '」從共享區移掉?')) return;
  const r = await fetch(WALL_API + '/api/wall/submissions/' + s.id, { method: 'DELETE', headers: { authorization: 'Bearer ' + token } });
  if (r.ok) { wallOwnDel(s.id); toast('已移除'); renderWall(); }
  else toast('移除失敗,重新整理再試一次');
}

async function renderWall() {
  const box = $('#wall-list');
  if (!box) return;
  box.innerHTML = '<p class="hint">載入中…</p>';
  let items = [];
  try { items = await wallList(); } catch (e) { box.innerHTML = '<p class="hint">共享區連不上,等一下再試。</p>'; return; }
  if (!items.length) { box.innerHTML = '<p class="hint">還沒有人投稿,你可以當第一個。</p>'; return; }
  const own = wallOwn();
  box.innerHTML = '';
  items.forEach((s) => {
    const row = el('div', 'wall-item');
    const meta = el('div', 'wall-meta');
    meta.innerHTML = '<strong>' + esc(s.title || '未命名') + '</strong><span>' + esc(s.display_name) + '・' + (s.msg_count || 0) + ' 則・' + fmtTime(Date.parse(s.created_at)) + '</span>';
    const acts = el('div', 'wall-acts');
    const prev = el('button'); prev.textContent = '預覽'; prev.addEventListener('click', () => wallPreview(s));
    const open = el('button'); open.textContent = '打開來用'; open.addEventListener('click', () => wallOpen(s));
    acts.append(prev, open);
    if (own[s.id]) { const d = el('button', 'danger'); d.textContent = '刪除'; d.addEventListener('click', () => wallDelete(s)); acts.append(d); }
    row.append(meta, acts);
    box.append(row);
  });
}

async function wallShortCode() { // 產生(或沿用)這份作品的短碼;同內容同碼,寫入會去重
  // app 欄位不能省:shorturl 靠它決定雜湊哪一段內容,漏了會被當成別的產品的請求擋掉
  const r = await fetch(SHORTURL_API + '/api/short-url', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'line-chat-maker', state }),
  });
  const d = await r.json();
  const code = String(d.code || '').trim();
  if (!/^[a-f0-9]{8,16}$/.test(code)) throw new Error('短碼產不出來,等一下再試');
  return code;
}

// 展示模式:給簡報 iframe 嵌用(?wall=display)。整頁只放一份放大的作品,左右鍵切換,
// 每 2 秒輪詢一次,有人投稿兩秒後投影片就自己長出來。
async function wallDisplayMode() {
  document.body.classList.add('wall-display');
  const stage = el('div', 'wall-stage');
  const cap = el('div', 'wall-cap');
  document.body.append(stage, cap);
  let items = [], idx = 0, shown = null;

  const paint = async () => {
    const s = items[idx];
    if (!s) { cap.textContent = '還沒有人投稿'; return; }
    if (s.code === shown) return;
    shown = s.code;
    let incoming;
    try { incoming = await wallFetchState(s.code); } catch (e) { cap.textContent = '這份讀不回來'; return; }
    stage.innerHTML = '';
    const shot = wallSnapshot(incoming);
    stage.append(shot);
    cap.textContent = (s.title || '未命名') + '・' + s.display_name + '　(' + (idx + 1) + '/' + items.length + ')';
    fit(shot);
  };

  // 簡報是用 iframe 嵌這一頁的,高度可能只有幾百 px,不縮的話手機會被切掉、字幕也擠出畫面
  const fit = (shot) => {
    stage.style.transform = 'none'; stage.style.height = 'auto';
    const h = shot.getBoundingClientRect().height || 1;
    const avail = innerHeight - 72; // 留給字幕與上下留白
    const k = Math.min(1, avail / h);
    stage.style.transform = 'scale(' + k.toFixed(3) + ')';
    stage.style.height = Math.round(h * k) + 'px';
  };
  addEventListener('resize', () => { const shot = stage.firstElementChild; if (shot) fit(shot); });

  const poll = async () => {
    let next;
    try { next = await wallList(); } catch (e) { return; }
    const grew = next.length > items.length;
    items = next;
    if (grew) { idx = 0; shown = null; } // 有新作品就跳到最新那份
    paint();
  };

  addEventListener('keydown', (e) => {
    if (items.length < 2) return;
    if (e.key === 'ArrowRight') { idx = (idx + 1) % items.length; shown = null; paint(); }
    if (e.key === 'ArrowLeft') { idx = (idx - 1 + items.length) % items.length; shown = null; paint(); }
  });

  await poll();
  setInterval(poll, 2000);
}

function wallPrefillCode(code) { // 帶碼網址進來:填好活動碼、切到共享區、把投稿區展開
  const el2 = $('#wall-code');
  if (!el2) return;
  el2.value = String(code).trim().slice(0, 64);
  $('#wall-post').open = true;
  document.querySelector('.tabs [data-pane="wall"]').click();
  // 只拿掉 code,其他參數留著(?id= 之類還有人要用);碼不留在網址列,免得被順手截圖出去
  const u = new URL(location.href); u.searchParams.delete('code');
  history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
  toast('活動碼已帶入,填個名字就能投稿');
}

document.querySelector('.tabs [data-pane="wall"]').addEventListener('click', renderWall);
$('#wall-refresh').addEventListener('click', renderWall);
$('#wall-submit').addEventListener('click', async () => {
  const name = $('#wall-name').value.trim();
  const uploadCode = $('#wall-code').value.trim();
  if (!name) { $('#wall-name').focus(); toast('請填顯示名稱'); return; }
  if (!uploadCode) { $('#wall-code').focus(); toast('請填現場公布的活動碼'); return; }
  if (!$('#wall-consent').checked) { toast('請勾選展示同意'); return; }
  const btn = $('#wall-submit'); btn.disabled = true; btn.textContent = '投稿中';
  try {
    const code = await wallShortCode();
    const r = await fetch(WALL_API + '/api/wall/submissions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event: WALL_EVENT, code, name,
        title: $('#wall-title').value.trim() || (state.settings && state.settings.title) || '',
        msgCount: state.messages.length, consent: true, uploadCode,
      }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error((d.error && d.error.message) || '投稿失敗');
    wallOwnSet(d.submission.id, d.ownerToken);
    $('#wall-post').open = false;
    toast('投稿成功,大家看得到了');
    renderWall();
  } catch (e) { toast(e.message || '投稿失敗'); }
  finally { btn.disabled = false; btn.textContent = '投稿'; }
});

// ── 腳本 JSON 進出 ──
$('#export-json').addEventListener('click', () => {
  const a = document.createElement('a');
  a.download = 'line-chat-script.json';
  a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(state, null, 2));
  a.click();
});
$('#import-json').addEventListener('click', () => $('#file-json').click());
$('#file-json').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { const s = JSON.parse(await f.text()); if (!s.messages) throw new Error('缺 messages'); activate(await adoptIncoming(s)); render(); renderDrafts(); toast('已開成新草稿;原創作在「草稿」分頁'); }
  catch (err) { alert('JSON 讀不進來:' + err.message); }
  e.target.value = '';
});
$('#reset').addEventListener('click', () => { if (confirm('清空目前這份草稿,回到範例?')) { state = migrate(JSON.parse(JSON.stringify(DEMO))); save(); render(); } });

window.addEventListener('hashchange', () => { if (location.hash.startsWith('#s=')) location.reload(); });

async function playback() {
  const nodes = Array.from(chatEl.children);
  nodes.forEach((n) => { n.style.visibility = 'hidden'; n.classList.remove('appear'); });
  const draftEl = $('#draft');
  const draftText = state.settings.draft || '';
  if (draftText) draftEl.textContent = ''; // 草稿是「最後打的那句」:播放開頭先清空,結尾逐字打出
  chatEl.scrollTop = 0;
  for (const n of nodes) {
    await new Promise((r) => setTimeout(r, 650));
    n.style.visibility = '';
    n.classList.add('appear');
    // 捲到「剛出現的這則」貼視窗底。不能捲 scrollHeight:hidden 的訊息仍佔空間,會一次捲進空白區
    const nb = n.getBoundingClientRect(), cb = chatEl.getBoundingClientRect();
    if (nb.bottom > cb.bottom) chatEl.scrollTop += nb.bottom - cb.bottom;
  }
  chatEl.scrollTop = chatEl.scrollHeight; // 播完全部可見,補一發真正貼底(appear 動畫位移會差幾 px)
  if (draftText) { // 結尾:打字效果(只動畫面,state 不動;之後 render() 會照 state 還原)
    await new Promise((r) => setTimeout(r, 700));
    for (let i = 1; i <= draftText.length; i++) {
      draftEl.textContent = draftText.slice(0, i);
      await new Promise((r) => setTimeout(r, 75));
    }
  }
  // 清掉進場定格:skin 進場動畫用 fill:both,若留著 .appear 會把泡泡定在結尾的 rotate(0),蓋掉基礎傾斜
  // (且緊接著匯出 PNG 會 clone 到帶 .appear 的節點,有 from:opacity0 半途風險)。清掉後 transform 交還基礎傾斜,基礎規則的 .15s transition 讓它平滑落定。
  await new Promise((r) => setTimeout(r, 500)); // 等最後一則進場動畫跑完再清
  nodes.forEach((n) => n.classList.remove('appear'));
}

document.querySelectorAll('.tabs .tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tabs .tab').forEach((x) => x.classList.toggle('active', x === t));
  document.querySelectorAll('.pane').forEach((pn) => pn.classList.toggle('active', pn.id === 'pane-' + t.dataset.pane));
}));
// 聊天視窗內新增條
$('#preview-toggle').addEventListener('click', () => {
  const on = document.body.classList.toggle('previewing');
  $('#preview-toggle').textContent = on ? '回編輯' : '預覽';
});
$('#chat-addbar').addEventListener('click', (e) => {
  const kind = e.target.dataset && e.target.dataset.add;
  if (!kind) return;
  if (kind === 'play') { playback(); return; }
  if (kind === 'left') addLeft();
  else if (kind === 'right') state.messages.push({ type: 'msg', side: 'right', text: '點我改文字', time: '下午4:00', read: '', quote: null });
  else if (kind === 'skip') state.messages.push({ type: 'skip', text: '⋯⋯(略)⋯⋯' });
  else if (kind === 'date') state.messages.push({ type: 'date', text: '7月15日 週三' });
  else if (kind === 'image' || kind === 'sticker') state.messages.push({ type: 'msg', kind, side: 'left', personId: lastLeftPid(), img: null, time: '下午4:00', read: '' });
  else if (kind === 'voice') state.messages.push({ type: 'msg', kind: 'voice', side: 'left', personId: lastLeftPid(), dur: '0:12', time: '下午4:00', read: '' });
  else if (kind === 'file') state.messages.push({ type: 'msg', kind: 'file', side: 'left', personId: lastLeftPid(), fname: '報告.pdf', fsize: '2.4 MB', time: '下午4:00', read: '' });
  save(); render();
});

boot();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
// footer 版本號:從 sw.js 的 cache 版名讀(單一事實來源),診斷「拿到新版沒」用
fetch('sw.js').then((r) => r.text()).then((s) => { const m = s.match(/lcm-v(\d+)/); if (m) $('#app-ver').textContent = ' v' + m[1]; }).catch(() => {});
