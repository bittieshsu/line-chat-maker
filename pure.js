// pure.js — 無 DOM 的純邏輯,app 與測試共用同一份(避免鏡像測試漂移)。
// plain <script> 掛 window.LCM_PURE;node 測試以 new Function 注入 root 執行同段原始碼。
(function (root) {
  // 底色是否偏綠(gpt-image 綠幕偏黃悶綠);不綠就別去背,免得把主體挖破
  function isChromaGreen(br, bg, bb) { return bg > 50 && bg >= br * 0.95 && bg > bb * 1.2; }

  // 貼圖去背:吃 RGBA 陣列(canvas ImageData.data)與寬高,四角取綠中位數 → 色距去背 + 羽化 + 綠溢抑制,原地改 alpha
  function chromaKeyData(d, w, h) {
    const k = Math.max(4, Math.floor(h / 20));
    const rs = [], gs = [], bs = [];
    const push = (x, y) => { const o = (y * w + x) * 4; rs.push(d[o]); gs.push(d[o + 1]); bs.push(d[o + 2]); };
    for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) { push(x, y); push(w - 1 - x, y); push(x, h - 1 - y); push(w - 1 - x, h - 1 - y); }
    const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
    const br = med(rs), bg = med(gs), bb = med(bs), lo = 45, hi = 95;
    if (!isChromaGreen(br, bg, bb)) return; // 四角不偏綠(沒鋪綠幕、全出血、或主體鋪滿四角)就整張保留
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gr = d[i + 1], b = d[i + 2];
      const dist = Math.sqrt((r - br) ** 2 + (gr - bg) ** 2 + (b - bb) ** 2);
      const a = Math.max(0, Math.min(1, (dist - lo) / (hi - lo))) * 255;
      d[i + 3] = Math.min(d[i + 3], a);
      if (a > 0 && a < 255) { const cap = Math.max(r, b); if (gr > cap) d[i + 1] = Math.min(gr, cap + 12); } // 邊緣綠溢抑制
    }
  }

  // 格盤幾何:依格數選盤面 + 算某格的內縮取樣矩形
  function planGrid(n) {
    if (n <= 4) return { cols: 2, rows: 2, size: '1024x1024' };
    if (n <= 9) return { cols: 3, rows: 3, size: '1024x1024' };
    return { cols: 3, rows: 4, size: '1024x1536' };
  }
  function cellRect(imgW, imgH, grid, i, inset) {
    inset = inset == null ? 0.08 : inset;
    const cw = imgW / grid.cols, ch = imgH / grid.rows;
    const col = i % grid.cols, row = Math.floor(i / grid.cols);
    return { sx: col * cw + cw * inset, sy: row * ch + ch * inset, sw: cw * (1 - inset * 2), sh: ch * (1 - inset * 2) };
  }

  // 取回補圖的指紋防呆:比對每格目標,草稿變動、對不上的標 skip(不靜默貼錯);頭像用穩定 personId 重新定位
  function validateFillCells(cells, messages, people) {
    let skipped = 0;
    const out = cells.map((c) => {
      if (c.type === 'avatar') {
        const idx = c.personId != null ? people.findIndex((p) => p.id === c.personId) : c.personIndex;
        if (idx == null || idx < 0 || !people[idx]) { skipped++; return Object.assign({}, c, { skip: true }); }
        return Object.assign({}, c, { personIndex: idx });
      }
      const m = messages[c.msgIndex], fp = c.fp;
      if (!m || (fp && (m.time !== fp.time || m.kind !== fp.kind || m.personId !== fp.personId || m.side !== fp.side))) { skipped++; return Object.assign({}, c, { skip: true }); }
      return c;
    });
    return { cells: out, skipped };
  }

  // 下載檔名安全化
  function safeFileName(s) { return String(s == null ? '' : s).replace(/[\\/:*?"<>|]+/g, '_').trim() || '未命名'; }
  // 下載檔名的副檔名跟著實際 data URL 型別走(匯入草稿可能帶 jpg 頭像;無法辨識退回 png)
  function downloadName(dataUrl, filename) {
    const mime = (String(dataUrl).match(/^data:image\/([a-z0-9.+-]+)/i) || ['', ''])[1].toLowerCase();
    const ext = mime === 'jpeg' ? 'jpg' : (mime || 'png');
    return filename.replace(/\.[^./]+$/, '') + '.' + ext;
  }

  // 補齊殘缺的 left 訊息:AI 產 [貼圖:…]/[圖片:…] 時偶爾漏掉 side 與 personId。
  // 渲染器把「不是 right」當左邊,補位與分組卻只認 side==='left',這種列會從縫裡漏下去,
  // 畫面上就是一格沒有頭像的空白。統一成「不是 right 就是 left」,personId 跟前一位左邊發話者。
  function normalizeSides(s) {
    const people = (s && s.people) || [];
    if (!people.length || !s || !Array.isArray(s.messages)) return 0;
    const ids = new Set(people.map((p) => p.id));
    let last = people[0].id, fixed = 0;
    for (const m of s.messages) {
      if (m.type !== 'msg' || m.side === 'right') continue;
      if (m.side !== 'left') { m.side = 'left'; fixed++; }
      if (!ids.has(m.personId)) { m.personId = last; fixed++; }
      last = m.personId;
    }
    return fixed;
  }

  // 老使用者手動「載入內建範例」時,只挑草稿裡還沒有的(按 name 去重,不重複塞、不動現有草稿)
  function presetsToLoad(presets, existingNames) {
    const have = new Set(existingNames || []);
    return (presets || []).filter((p) => !have.has(p && p.name));
  }

  root.LCM_PURE = { isChromaGreen, chromaKeyData, planGrid, cellRect, validateFillCells, safeFileName, downloadName, normalizeSides, presetsToLoad };
})(typeof window !== 'undefined' ? window : globalThis);
