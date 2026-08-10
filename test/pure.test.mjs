// test/pure.test.mjs — 載入「真的」 pure.js(app 也用同一份),測純邏輯而非鏡像複本。
// pure.js 是 plain <script>(掛 window.LCM_PURE);此處用 new Function 注入 root 執行同一段原始碼。
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'pure.js'), 'utf8');
const g = {};
new Function('root', src.replace(/\(typeof window[^;]+;/, '(root);'))(g);
const P = g.LCM_PURE;

import { test } from 'node:test';

// ── isChromaGreen 綠底閘門 ──
test('isChromaGreen:黃悶綠 [114,152,98] 判綠(要去背)', () => assert.equal(P.isChromaGreen(114, 152, 98), true));
test('isChromaGreen:膚色 [240,192,160] 不判綠(整張保留)', () => assert.equal(P.isChromaGreen(240, 192, 160), false));
test('isChromaGreen:純白 [240,240,240] 不判綠', () => assert.equal(P.isChromaGreen(240, 240, 240), false));
test('isChromaGreen:藍天 [135,206,235] 不判綠', () => assert.equal(P.isChromaGreen(135, 206, 235), false));
test('isChromaGreen:飽和綠 [50,200,50] 判綠', () => assert.equal(P.isChromaGreen(50, 200, 50), true));

// ── chromaKeyData:真正的去背迴圈(吃 RGBA 陣列 + 寬高,原地改 alpha)──
function solidGreenWithCenter(w, h, center) { // 四角綠、中央一塊 center 色
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = (i / w) | 0;
    const mid = x > w * 0.3 && x < w * 0.7 && y > h * 0.3 && y < h * 0.7;
    const [r, gg, b] = mid ? center : [110, 152, 98];
    d[i * 4] = r; d[i * 4 + 1] = gg; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
  }
  return d;
}
test('chromaKeyData:綠底四角 → 中央非綠主體保留、綠底變透明', () => {
  const w = 20, h = 20, d = solidGreenWithCenter(w, h, [220, 60, 60]);
  P.chromaKeyData(d, w, h);
  assert.equal(d[3], 0, '角落綠 → alpha 0');
  const c = ((h / 2) | 0) * w + ((w / 2) | 0);
  assert.equal(d[c * 4 + 3], 255, '中央紅色主體 → alpha 255 保留');
});
test('chromaKeyData:四角非綠(膚色底)→ 綠底閘門擋下,整張不動', () => {
  const w = 20, h = 20, d = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let i = 0; i < w * h; i++) { d[i * 4] = 240; d[i * 4 + 1] = 192; d[i * 4 + 2] = 160; d[i * 4 + 3] = 255; }
  P.chromaKeyData(d, w, h);
  assert.equal(d[3], 255, '非綠底不得被挖成透明');
});

// ── planGrid / cellRect 切圖幾何 ──
test('planGrid 依格數選盤面', () => {
  assert.deepEqual(P.planGrid(4), { cols: 2, rows: 2, size: '1024x1024' });
  assert.deepEqual(P.planGrid(5), { cols: 3, rows: 3, size: '1024x1024' });
  assert.deepEqual(P.planGrid(10), { cols: 3, rows: 4, size: '1024x1536' });
});
test('cellRect:2x2 右下格內縮矩形', () => {
  const r = P.cellRect(1024, 1024, { cols: 2, rows: 2 }, 3);
  assert.equal(r.sx, 512 + 512 * 0.08);
  assert.equal(r.sw, 512 * 0.84);
});

// ── validateFillCells 取回指紋防呆 ──
test('validateFillCells:未動 → 不略過', () => {
  const messages = [{ time: '下午3:00', kind: 'sticker', personId: 'p1', side: 'left' }];
  const people = [{ id: 'p1' }, { id: 'p2' }];
  const cells = [{ type: 'sticker', msgIndex: 0, fp: { time: '下午3:00', kind: 'sticker', personId: 'p1', side: 'left' } }, { type: 'avatar', personIndex: 1, personId: 'p2' }];
  const v = P.validateFillCells(cells, messages, people);
  assert.equal(v.skipped, 0);
  assert.equal(v.cells.length, 2);
});
test('validateFillCells:淨零編輯致指紋不符 → 標 skip 不貼錯', () => {
  const messages = [{}, {}, { time: '下午4:00', kind: 'msg', personId: 'p3', side: 'left' }];
  const cells = [{ type: 'sticker', msgIndex: 2, fp: { time: '下午3:00', kind: 'sticker', personId: 'p1', side: 'left' } }];
  const v = P.validateFillCells(cells, messages, [{ id: 'p1' }]);
  assert.equal(v.skipped, 1);
  assert.equal(v.cells[0].skip, true);
});
test('validateFillCells:人物重排 → 用 personId 重新定位', () => {
  const v = P.validateFillCells([{ type: 'avatar', personIndex: 0, personId: 'p1' }], [], [{ id: 'p2' }, { id: 'p1' }]);
  assert.equal(v.skipped, 0);
  assert.equal(v.cells[0].personIndex, 1);
});

// ── safeFileName ──
test('safeFileName:非法字元換底線、空白退未命名', () => {
  assert.equal(P.safeFileName('a/b:c*?'), 'a_b_c_');
  assert.equal(P.safeFileName('中年攻城屍'), '中年攻城屍');
  assert.equal(P.safeFileName('  '), '未命名');
});

// ── presetsToLoad:老使用者「載入內建範例」時,只挑草稿裡還沒有的(按 name 去重)──
test('presetsToLoad:只回傳現有草稿沒有的', () => {
  const presets = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
  assert.deepEqual(P.presetsToLoad(presets, ['B']).map((p) => p.name), ['A', 'C']);
  assert.deepEqual(P.presetsToLoad(presets, ['A', 'B', 'C']), []);
  assert.deepEqual(P.presetsToLoad(presets, []).map((p) => p.name), ['A', 'B', 'C']);
  assert.deepEqual(P.presetsToLoad(null, ['x']), []);
});

// ── downloadName:副檔名跟實際型別 ──
test('downloadName:jpeg 頭像存 .jpg、png 保持、無法辨識退 png', () => {
  assert.equal(P.downloadName('data:image/jpeg;base64,AA', 'avatar-小白.png'), 'avatar-小白.jpg');
  assert.equal(P.downloadName('data:image/png;base64,AA', 'sticker-3.png'), 'sticker-3.png');
  assert.equal(P.downloadName('data:image/webp;base64,AA', 'a.png'), 'a.webp');
  assert.equal(P.downloadName('nope', 'image-2.jpg'), 'image-2.png');
});

// ── normalizeSides:AI 漏寫 side/personId 的訊息(畫面上是一格沒有頭像的空白)──
const PEOPLE = [{ id: 'p1', name: '媽' }, { id: 'p2', name: '妹' }];
test('normalizeSides:缺 side 與 personId 的圖片訊息,補成 left + 前一位左邊發話者', () => {
  const s = { people: PEOPLE, messages: [
    { type: 'msg', side: 'left', personId: 'p1', text: '你先不要動' },
    { type: 'msg', side: 'right', text: '幹' },
    { type: 'msg', kind: 'image', imgDesc: '洗手檯上的東西' },   // ← 缺 side/personId
  ] };
  assert.equal(P.normalizeSides(s), 2);
  assert.deepEqual({ side: s.messages[2].side, personId: s.messages[2].personId }, { side: 'left', personId: 'p1' });
});
test('normalizeSides:不動已經正確的訊息(right 不會被改成 left)', () => {
  const s = { people: PEOPLE, messages: [
    { type: 'msg', side: 'right', text: '我' },
    { type: 'msg', side: 'left', personId: 'p2', text: '她' },
    { type: 'date', text: '10月14日 (三)' },
  ] };
  assert.equal(P.normalizeSides(s), 0);
  assert.equal(s.messages[0].side, 'right');
  assert.equal(s.messages[2].personId, undefined);
});
test('normalizeSides:指向已刪人物的 personId 也接回前一位發話者', () => {
  const s = { people: PEOPLE, messages: [
    { type: 'msg', side: 'left', personId: 'p2', text: '在' },
    { type: 'msg', side: 'left', personId: 'p9', text: '幽靈' },
  ] };
  assert.equal(P.normalizeSides(s), 1);
  assert.equal(s.messages[1].personId, 'p2');
});
test('normalizeSides:沒有人物時原樣不動(交給呼叫端先補人)', () => {
  const s = { people: [], messages: [{ type: 'msg', kind: 'sticker' }] };
  assert.equal(P.normalizeSides(s), 0);
  assert.equal(s.messages[0].side, undefined);
});
