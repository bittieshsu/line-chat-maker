/* 內建 AI 助手:工具=腳本 JSON 操作(參考 zerotype-agent 的迴圈設計:強制工具+反偷懶+迴圈上限)
   與 app.js 同為 classic script,直接共用全域的 state / save / render / toast。 */
'use strict';
(() => {

// ── 連線設定(只存 localStorage,絕不進 state:草稿與分享連結不能帶到 API key) ──
const PROVIDERS = {
  free: { label: '刷亞澤的信用卡(免費體驗,每日限量)', base: 'https://lcm-ai-proxy.yazelinj303.workers.dev', model: 'openai/gpt-oss-120b', writerModel: 'glm-5.2', keyless: true }, // 執行=Groq gpt-oss;編劇=朋友的 GLM(worker 依 model 路由)。代理見 repo worker/
  groq: { label: 'Groq', base: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b' }, // 2026-07 實測:工具呼叫最穩+繁中最乾淨(qwen3 會捏造 @imgN)
  openai: { label: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-5-mini' },
  gemini: { label: 'Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.1-flash-lite', writerModel: 'gemini-3.1-pro-preview' }, // 2026-07 實測:新申請的 key 拿不到 2.5 世代(404),預設用 3.1;編劇帶 pro
  openrouter: { label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1-mini' },
  ollama: { label: 'Ollama(本機)', base: 'http://localhost:11434/v1', model: 'llama3.2', keyless: true },
  custom: { label: '自訂(OpenAI 相容)', base: '', model: '', keyless: true },
};
function cfg() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem('lcm-ai')) || {}; } catch (e) {}
  if (!PROVIDERS[c.provider]) c = { provider: 'free', base: PROVIDERS.free.base, model: PROVIDERS.free.model, key: '' }; // 新使用者預設=免費體驗,零設定即可玩
  return c;
}
function saveCfg(c) { try { localStorage.setItem('lcm-ai', JSON.stringify(c)); } catch (e) {} }
function writerCfg() { // 編劇/評審模型另設(選填);沒設或設不完整回 null,呼叫端退回主設定
  const c = cfg();
  if (!c.wProvider || !PROVIDERS[c.wProvider]) return null;
  return { provider: c.wProvider, base: c.wBase || '', model: c.wModel || '', key: c.wKey || '' };
}
function writerCfgBad(w) { return w && (!w.model || !w.base || (!PROVIDERS[w.provider].keyless && !w.key)); }

// ── 圖片佔位:dataURL 換成 @imgN 再給模型,套回時還原(模型 round-trip 不會弄丟圖) ──
let imgRegistry = [];
function strip(v) {
  if (typeof v === 'string') {
    if (v.startsWith('data:image')) { imgRegistry.push(v); return '@img' + (imgRegistry.length - 1); }
    return v;
  }
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = strip(v[k]); return o; }
  return v;
}
function rehydrate(v) {
  if (typeof v === 'string') { const m = v.match(/^@img(\d+)$/); return m ? (imgRegistry[+m[1]] ?? null) : v; }
  if (Array.isArray(v)) return v.map(rehydrate);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = rehydrate(v[k]); return o; }
  return v;
}
function scriptOf() { return { settings: state.settings, people: state.people, messages: state.messages }; }

// ── 工具(同一份定義供 agent 迴圈與 WebMCP 註冊) ──
const TOOL_DEFS = [
  { name: 'get_script', description: '讀取目前完整腳本 JSON(圖片以 @imgN 佔位符表示)。', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'apply_script', description: '修改腳本並立即更新畫面:settings 淺合併、people 整組取代、messages 整列取代;三個欄位都可省略,只給要改的。', parameters: { type: 'object', properties: { settings: { type: 'object', description: '只放要改的欄位' }, people: { type: 'array', items: { type: 'object' } }, messages: { type: 'array', items: { type: 'object' } } }, additionalProperties: false } },
  { name: 'append_messages', description: '在對話尾端加入訊息,畫面立即更新。', parameters: { type: 'object', properties: { messages: { type: 'array', items: { type: 'object' } } }, required: ['messages'], additionalProperties: false } },
  { name: 'export_png', description: '把目前畫面匯出成 PNG(會觸發下載)。只在使用者明確要求匯出時使用。', parameters: { type: 'object', properties: {}, additionalProperties: false } },
];
function sanitizeMessages(list) {
  const out = [];
  for (const m of rehydrate(list).filter((x) => x && typeof x === 'object' && typeof x.type === 'string')) {
    if (m.type === 'msg' && typeof m.text === 'string') {
      m.text = m.text.replace(/^[((](?:轉折|高潮|伏筆|鋪陳|開場|收尾|結尾|轉折點|高潮點)[))]\s*/, ''); // 舞台指示滲進台詞的保險
      if (/^[((]略[))]$/.test(m.text.trim())) { out.push({ type: 'skip', text: '⋯⋯(略)⋯⋯' }); continue; } // 「小亮:(略)」→ 正確的省略分隔
    }
    const emptyText = m.type === 'msg' && (m.kind || 'text') === 'text' && !(m.text && String(m.text).trim());
    if (emptyText) { // 模型常把 react/已讀寫成空白訊息:有 react 就併回前一則,純空白直接丟(程式碼保險)
      if (Array.isArray(m.react) && m.react.length && out.length && out[out.length - 1].type === 'msg') {
        const prev = out[out.length - 1];
        prev.react = (Array.isArray(prev.react) ? prev.react : []).concat(m.react);
      }
      continue;
    }
    out.push(m);
  }
  return out;
}
function fixRefs() { // left 訊息的 personId 必須存在;沒人就補一位
  if (!state.people.length) state.people.push({ id: 'p1', name: '朋友', avatar: null });
  window.LCM_PURE.normalizeSides(state); // 「不是 right 就是 left」;缺的 personId 跟前一位左邊發話者
}
async function execTool(name, args) {
  if (name === 'get_script') return JSON.stringify(strip(scriptOf()));
  if (name === 'apply_script') {
    if (args.settings && typeof args.settings === 'object' && !Array.isArray(args.settings)) Object.assign(state.settings, rehydrate(args.settings));
    { // 保險:群名尾帶「(3)」拆成 title+members,避免畫面 (3)(3) 重複
      const tm = String(state.settings.title || '').match(/^(.*?)[  ]*[((](\d+)[))]\s*$/);
      if (tm && tm[1].trim()) { state.settings.title = tm[1].trim(); if (!(+state.settings.members) || +state.settings.members === +tm[2]) state.settings.members = +tm[2]; }
    }
    if (Array.isArray(args.people)) state.people = rehydrate(args.people).filter((p) => p && p.id).map((p) => ({ id: String(p.id), name: String(p.name ?? '朋友'), avatar: typeof p.avatar === 'string' && p.avatar.startsWith('data:') ? p.avatar : null }));
    if (Array.isArray(args.messages)) state.messages = sanitizeMessages(args.messages);
    fixRefs(); save(); render();
    return JSON.stringify({ ok: true, people: state.people.length, messages: state.messages.length });
  }
  if (name === 'append_messages') {
    if (!Array.isArray(args.messages)) throw new Error('messages 必須是陣列');
    state.messages.push(...sanitizeMessages(args.messages));
    fixRefs(); save(); render();
    return JSON.stringify({ ok: true, messages: state.messages.length });
  }
  if (name === 'export_png') { $('#export-png').click(); return JSON.stringify({ ok: true }); }
  throw new Error('未知工具:' + name);
}

// ── Agent 迴圈 ──
const SYSTEM = `你是「LINE 對話製造機」網頁內建的 AI 助手,幫創作者製作 LINE 風格的示意對話截圖。
整個畫面由一份腳本 JSON 驅動:{ settings, people, messages }。你用工具讀取與修改這份腳本,畫面立即更新。

schema 重點:
- settings:title(聊天室名稱)、members(0=不顯示)、skin(外觀風格 "memo"預設/"jelly"/"doodle"/"pop"/"ink"/"real")、mode("group"|"dm")、clock(狀態列時間)、frameLevel("phone"|"screen"|"chat")、watermark、height("auto"|"fixed")、heightPx、draft(輸入框未送出文字)、announceOn/announce(置頂公告)。bg/theme/sysColor 僅 skin="real" 有效,其餘 skin 各自配色。只改需要的欄位。
- mode:"dm"(1對1)時 title 必須=對方(左側那位)的名字、members 給 0;mode:"group" 時 title=群組名稱、members 給合理人數。title **絕不含人數**:劇本群名若尾帶「(3)」,拆開——title 去掉它、members=3(畫面自動顯示人數,寫進 title 會重複)。
- people:[{id,name,avatar}],avatar 是圖片(@imgN 佔位符或 null=灰底圓)。
- messages 依序渲染:
  {"type":"date","text":"7月15日 (三)"} 日期分隔
  {"type":"skip","text":"⋯⋯(略)⋯⋯"} 省略分隔
  {"type":"msg","side":"left","personId":"p1","text":"...","time":"下午3:42","read":"","quote":null} 他人訊息
  {"type":"msg","side":"right","text":"...","time":"下午4:06","read":"已讀"} 自己(綠泡泡),不需 personId;群組的 read 可寫「已讀 8」
  選填 quote:{name,text}=引用回覆;react:["😆"]=表情回應列
  kind:"image"|"sticker"(配 img 欄位)、"voice"(dur:"0:12")、"file"(fname,fsize);kind 省略=文字
- react 是「別人對這則訊息的反應」,放在**被反應的那一則訊息**的 react 欄位(劇本寫「小雯對阿亮上一則按 ❤️」=把 ❤️ 加進阿亮那則的 react)。絕不可為了 react 或已讀狀態建立空白訊息(text 空的 msg 是錯誤)。
- text 只放角色真的打出來的文字。劇本裡的括號註記——(轉折)(高潮)(已讀)(略)(草稿)(react)等——是給你的舞台指示,**絕不可抄進 text**:轉折/高潮照常填內容不含標記;(略)=獨立 skip 分隔則;草稿=settings.draft;已讀=read 欄位。
- 劇本的方括號記法=非文字訊息,轉成對應 kind,描述文字不進 text:[貼圖:描述]→kind:"sticker",img:null,imgDesc:"描述";[圖片:描述]→kind:"image",img:null,imgDesc:"描述";[語音 0:12:…]→kind:"voice",dur:"0:12";[檔案:xx.pdf 2.4MB]→kind:"file",fname,fsize。imgDesc 一定要帶(之後 AI 補圖靠它)。這些非文字訊息**一樣要寫 side**,是別人傳的就要一併帶 personId——漏掉會變成一則沒有頭像的訊息。
- 「(引用某人的「原文」)自己的話」→ 該則訊息 quote:{name:"某人",text:"原文"},text 只放自己的話;「[日期:7月17日 (四)]」→ {type:"date",text:"7月17日 (四)"}。
- read 欄位只在 side:"right"(自己的綠泡泡)有意義;left 訊息不放 read。「已讀不回」=right 訊息 read:"已讀"+下一則時間拉開。
- 時間照台灣 LINE 慣例如「下午4:06」,前後訊息時間要合理遞增。連續同 personId 的 left 訊息會自動省略頭像暱稱。
- **每份對話一定要有「自己」(至少一位角色是 side:"right" 綠泡泡)**:劇本若指明誰是自己/我方(角色設定標了「(自己)」或用「我」),就把他的台詞全設 side:"right"(不給 personId、也不列進 people);若劇本沒指明(三個人都只有名字、沒有「我」),你要挑一位最適合當截圖者的角色當自己(通常是被鬧/負責吐槽/主角那位),其台詞設 side:"right",其餘才是 left。絕不可讓所有人都排在左邊、畫面一顆綠泡泡都沒有——那不像真的 LINE 截圖。群組 members 含自己一起算。

創作流程(使用者的提示通常很簡短,你要把它長成完整作品):
1. 補齊規格:先在心中定好角色個性與關係、劇情弧(起因→轉折→收尾)、要用哪些說故事手法——已讀不回、時間跳躍、日期分隔、「(略)」省略、貼圖、引用回覆、表情回應、輸入框未送出的草稿(draft)都是敘事工具。
2. 產出初稿:依規格用工具一次做完整——settings(title/mode 要相符)、people、messages 全部到位,不要只做一半。
3. 自審修稿:每次修改後你會收到自審要求,用檢查清單重讀腳本;有不合格就繼續修,全部合格才收工。

規則:
- 一律使用繁體中文(zh-TW)回覆。
- 你的第一個回應必須是工具呼叫,不可以只回覆文字、規劃或思考過程;所有思考直接化為工具行動。
- 收到任務直接用工具完成,不要反問、不要只給建議或範例;改完用一句話回報結果。
- 填入大量訊息時務必分批:先用 apply_script 放 settings、people 與前幾則訊息,之後用 append_messages 每批最多 8 則補完;單次工具參數過長容易格式出錯。
- 對話內容要自然口語像真人閒聊,每個人物講話風格一致;適度用貼圖、已讀、時間差說故事。
- @imgN 代表既有圖片:要沿用就原樣保留;不可發明不存在的 @imgN;新的 image/sticker 訊息 img 給 null(顯示佔位圖)。
- 僅供創作示意(部落格配圖、教學、行銷素材);拒絕製作用於詐騙、毀謗、偽造證據的內容。`;

// ── 編劇/評審(創意與執行分離:編劇寫劇本→評審打分及格→執行 AI 只負責詳實填入) ──
const WRITER_SYSTEM = `你是資深編劇,專為「LINE 對話截圖」這種形式寫劇本。

【篇幅】
**總長 40 則訊息以內**(含日期分隔與「(略)」),甜蜜點是 20 到 30 則。這不是美學偏好:執行 AI 每批只能填 8 則、每批要花掉數輪迴圈,劇本超過 40 則就會做到一半停住,使用者只看得到半成品。
寫太長也不好看——一張截圖滑不完,梗會被稀釋。要讓劇情變好就砍掉鋪陳、讓每一則更有力,不要靠加長。

【演出管線】
你的劇本不會被人類觀眾讀到,而是交給一個「執行 AI」逐字轉譯成一張 LINE 風格的對話畫面——觀眾最後看到的只有那張圖。
這個舞台沒有旁白、沒有內心獨白、沒有場景與鏡頭描寫、沒有表情動作說明;所有情緒與劇情,只能用「畫面上真的看得到的東西」演出來。這是 show, don't tell 的 LINE 版——寫任何一行前先問:這個東西會出現在截圖上嗎?不會,就換成畫面演得出來的手法。
**被討論的視覺物件一定要現形**:只要劇情裡有人「傳一張圖/畫了什麼/曬截圖/秀某張照片/看某個東西」,那個東西**本身**就要用「[圖片:描述]」或「[貼圖:描述]」做成一則訊息讓觀眾看到;絕不能只用文字說「那張圖」「一坨黑黑的東西」而畫面上根本沒有那張圖——那是 tell 不是 show,梗會落空。劇情的核心物件(畫作、截圖、照片、梗圖、成績單、菜單…)沒現形 = 犯規。

【舞台元素全覽】你能用的全部元素、劇本記法、畫面效果:
訊息類型(五種,都是正當訊息;「角色A/角色B」是記法佔位,創作時換成你取的名字):
- 文字:「角色A:今晚好冷~」→ 對話泡泡
- 貼圖:「角色A:[貼圖:抱抱的熊]」→ 大張貼圖,無文字;情緒的標點符號
- 圖片:「角色B:[圖片:海邊夕陽]」→ 照片訊息;曬生活、給證據、傳截圖都靠它
- 語音:「角色A:[語音 0:15:大意是想見你]」→ 畫面只有語音條和秒數,觀眾聽不到內容——想讓觀眾知道說了什麼,要用後續訊息呼應(「你剛那句…再說一次?」)
- 檔案:「角色B:[檔案:企劃書.pdf 2.4MB]」→ 檔案訊息;職場戲的道具
結構元素:
- 引用回覆:「角色A:(引用角色B的「我想吃燉飯」)那今晚一起去?」→ 泡泡上方帶原文小框;回應較早的話、製造呼應或翻舊帳
- 表情回應:「(角色B在角色A的上一則按了 ❤️)」→ 貼在對方訊息下的小表情;不是訊息,是無聲的回應——曖昧戲的靈魂
- 已讀:自己(右側綠泡泡)訊息旁的「已讀」;左側訊息沒有已讀標示
- 時間:每則「下午4:06」且遞增;時間差本身就是戲——秒回=在乎,隔一小時=有事發生
- 日期分隔:獨立行「[日期:7月17日 (四)]」→ 跨日必用;跨日本身可以是劇情(冷戰過夜)
- 省略分隔:獨立行「(略)」→ 跳過不重要的過程,兩段高潮之間的剪接
場景設定(開場先決定):
- 1對1(dm):標題=對方的名字;群組:標題=像真的群組名+合理成員數,置頂公告是群組限定武器(可以埋梗)。群組名稱**不要自己加「(人數)」**——成員數是獨立設定,畫面會自動顯示,寫進名字會變成 (3)(3)
- 視角人物(誰是「自己」):不論群組或雙人,都要指定一位角色是「自己」——拿手機截圖的人,他的台詞在右側綠泡泡。在開頭角色設定裡於該角色名後標「(自己)」,執行端才知道誰排右邊。少了這個,畫面會變成所有人都擠在左邊、一顆綠泡泡都沒有,不像真的 LINE。挑最適合當截圖者的那位:通常是被鬧的、負責吐槽的、或故事主角。他不會出現在左側名單,名字也不顯示(因為那就是「你」)。
- 輸入框草稿:「(草稿) draft=打了沒送出的那句話」→ 顯示在輸入框;強力的懸念收尾,但屬於選配——不是每部都要用,連用會膩
- 主題氛圍:可指定深色/亮色主題、聊天背景色配合劇情(深夜戲用深色)

【敘事技法】用上面的元素組合出來的招式:
- 已讀不回=自己訊息標已讀+下一則時間拉大;連發短句=急切;語音+對方只按 ❤️=聽完說不出話
- 貼圖接在尷尬話題後=打圓場;引用很久以前的話=翻舊帳或深情;公告與對話反差=群組戲笑點

【格式紀律】(寫錯執行端會做出怪畫面)
- 台詞行只寫角色真的會打出來的字;轉折/高潮/心理註記只能放在劇本最後的標註區
- react/已讀/沉默是狀態註記不是台詞;「(略)」「[日期:…]」是獨立行不屬於任何角色

【創作憲章】以上規則只管格式,不管膽子——劇情要敢:誤會、反轉、翻車、告白、神來一筆的貼圖時機。平庸安全、只有寒暄問答的劇本會被評審退件;寧可戲劇化一點,也不要乾。五種訊息類型至少用三種,結構元素能用就用——但為用而用不行,每個元素都要服務劇情。
結尾手法要輪換,依這部作品的劇情選最對味的一種:草稿懸念/已讀不回的沉默/一句話神回/貼圖收場/公告或日期分隔的反差…上一部用過的招,這一部就換一招。
每部作品要設計一格「截圖點」——觀眾看完最想單獨截下來傳給朋友的那一則(神回/暴擊/反轉句),整部戲為它鋪陳;共鳴要具體到讓人想 tag 某個人(「這就是我媽」「tag 你室友」)。
使用者的主題是委託簡報,不是分鏡表:具體的起因、轉折、結局、人物與細節由你發明;就算主題已經寫了走向,也要在細節上加出乎意料的料。你是編劇,不是打字員。

【輸出格式】寫出完整劇本:
1. 角色設定:每人的個性、說話習慣(語助詞/標點/長短句)。名字要依題材新取、貼合身分(職場/家人/同學各有命名感),不要沿用示例或上一部作品的名字
2. 逐則對話:誰說/內容(照記法)/時間/已讀狀態
3. 標註高潮與轉折點在哪一則
只輸出劇本文字,劇情要有起因、升溫、高潮、收尾;對話像真人打字。`;
const CRITIC_SYSTEM = `你是嚴格的 LINE 對話劇本評審,標準是「能在社群瘋傳」。對劇本六項評分,各 0-10:
1 arc 劇情弧(起因→升溫→高潮→收尾完整) 2 voice 角色聲音(口氣一致且彼此區分)
3 form 形式運用(已讀不回/時間差/日期分隔/貼圖/引用/react/draft 至少巧用三種且服務劇情)
4 pacing 節奏(留白與密集交錯,高潮前有鋪陳) 5 real 真實感(像真人打字的口語與短句)
6 share 傳播力:看完會想 tag 誰?有沒有共鳴點(「這就是我媽」「tag 你室友」)?最關鍵:有沒有一格明確的「截圖點」——觀眾最想單獨截下來傳的那一則。
平淡無起伏、只有寒暄問答、沒有任何意外或情緒轉折的劇本,arc 與 pacing 不得超過 6;純文字沒穿插貼圖/圖片/語音等非文字訊息的,form 不得超過 6;形式元素「為用而用」沒服務劇情的(例:草稿結尾與劇情無關、貼圖亂入),form 扣分;劇情提到、討論或傳送某個視覺物件(畫作/截圖/照片/梗圖/表單…)卻沒有對應的[圖片]或[貼圖]訊息把它做出來、只用文字帶過的,form 不得超過 4 且整體 pass=false,feedback 要指出「那個東西該補成[圖片]或[貼圖]、補在哪一則」;沒有明確截圖點或共鳴對象模糊的,share 不得超過 6。
只回傳 JSON:{"scores":{"arc":n,"voice":n,"form":n,"pacing":n,"real":n,"share":n},"total":n,"pass":true|false,"feedback":"具體可執行的修改指示,share 低分時要指出截圖點該設在哪"}
pass 條件:total>=48 且每項>=6。`;
const IDEAS = [ // 委託簡報式:只給主題+情緒目標,具體轉折留給編劇發明(寫太細它會照抄)
  ['情侶吵架和好', '情侶吵架和好,要高潮迭起,結局暖但過程虐,吵架的原因和破冰的方式由你發明'],
  ['家人的日常', '家人之間嘴硬心軟的日常,表面平淡結尾有後勁,誰跟誰、為了什麼事由你決定'],
  ['群組修羅場', '一個多人群組的修羅場,誤會或災難逐步升級,要有人說錯話的瞬間,題材自選'],
  ['深夜曖昧', '深夜曖昧,話越聊越近但誰都不敢先說破,結尾懸念要讓人截圖傳給朋友,細節自由發揮'],
  ['荒謬日常', '一段荒謬又真實的日常鬧劇,笑點要生活化,場景人物全由你發明'],
];

const QUICK_GUIDE = `這是「微調」任務,最高原則:只動使用者指定的地方,其他內容一字不改、順序不動。
- 使用者說「第 N 句/則」= 畫面由上而下第 N 則訊息(含日期與(略)分隔一起數);若指令引用了訊息文字,以文字比對為準,比序號可靠。
- 先用 get_script 讀目前腳本、確認目標所在,再用 apply_script 做最小變更(回傳完整 messages 時,未修改的則必須原封保留,含 @imgN)。
- 不要順手潤飾、不要補劇情、不要調整沒被點名的時間或文字。`;
const QUICK_REVIEW_MESSAGE = `自審:用 get_script 重讀腳本,只檢查兩件事:
1) 使用者指定的修改是否正確完成?
2) 其他內容是否原封不動(文字、時間、順序、圖片佔位符都沒被動到)?
有動到不該動的立刻改回來;確認無誤才用一句話回報。`;

const REVIEW_MESSAGE = `自審清單,逐項檢查剛才的修改:
1) 使用者任務與你補齊的規格是否完整達成?劇情有起因、轉折、收尾?
2) 每個人物口氣前後一致、像真人?
3) 時間格式照「下午4:06」慣例且合理遞增?
4) 節奏有留白?(日期分隔、(略)、已讀不回的時間差)
5) 有善用視覺敘事?(貼圖、引用回覆、表情回應、draft)
6) settings 的 title/mode 與內容相符?
先用 get_script 重讀一次腳本核對;有任何不合格就立刻用工具修正,全部合格才用一句話回報完成。`;

let aborter = null;
let aiUndoStack = []; // 每次 AI 修改推一層 {draftId, snap},按一次退一步;只作用於目前草稿
function undoEntries() { return aiUndoStack.filter((e) => e.draftId === currentId); }
function updateUndoButton() { // 常駐但停用:隱藏式按鈕使用者找不到(實戰回饋)
  const n = undoEntries().length;
  const b = $('#ai-undo');
  b.disabled = !n;
  b.textContent = n > 1 ? `還原上一步(可退 ${n} 步)` : '還原上一步';
}

async function chat(msgs, force, noTools, useCfg) {
  const c = useCfg || cfg();
  const url = c.base.replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    signal: aborter.signal,
    headers: { 'content-type': 'application/json', ...(c.key ? { authorization: 'Bearer ' + c.key } : {}) },
    body: JSON.stringify({
      model: c.model,
      messages: msgs,
      ...(noTools ? {} : { tools: TOOL_DEFS.map((t) => ({ type: 'function', function: t })), tool_choice: force ? 'required' : 'auto' }),
    }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { // 錯誤沒帶 JSON 訊息時附上目標,好診斷「打錯地方」類問題(model 與 URL 都顯示)
    const e0 = Array.isArray(d) ? d[0] || {} : d; // Gemini 把錯誤包在陣列裡
    const detail = (e0.error && e0.error.message) || e0.message;
    throw new Error(detail || `HTTP ${res.status}(${c.model} @ ${url})`);
  }
  const m = d.choices && d.choices[0] && d.choices[0].message;
  if (!m) throw new Error('模型沒有回傳訊息。');
  return m;
}

function textOf(m) { return (typeof m.content === 'string' ? m.content : '').trim(); }

function writerBrief(prompt, existing) { // 編劇的 user 訊息;內建「劇本強化」與「複製 prompt 外部產生」共用同一份,避免漂移
  return '需求:' + prompt + (existing ? '\n\n既有劇本(在此基礎上強化:保留好的部分、針對需求與弱點改寫,輸出完整新版。**強化是讓每一則更有力,不是把劇本加長**;該砍的鋪陳就砍掉,總長仍要控制在 40 則以內):\n' + existing : '');
}
async function writeScreenplay(prompt, existing) { // 編劇→評審迴圈,及格(或 3 輪取最佳)才放行
  log('編劇撰寫劇本中…');
  const explicitW = writerCfg(); // 使用者另設的編劇/評審;沒設=null
  const wcfg = explicitW || cfg(); // 評審(打分)走這個
  // 編劇(創意):沒另設編劇時,若主 provider 有指定的編劇模型就用它(免費→GLM、Gemini→pro);評審維持執行模型省額度
  const writerModel = (!explicitW && PROVIDERS[wcfg.provider] && PROVIDERS[wcfg.provider].writerModel) || wcfg.model;
  const wuse = { ...wcfg, model: writerModel };
  log(`編劇使用:${PROVIDERS[wcfg.provider] ? PROVIDERS[wcfg.provider].label : wcfg.provider} · ${writerModel}`);
  const brief = writerBrief(prompt, existing);
  const wmsgs = [{ role: 'system', content: WRITER_SYSTEM }, { role: 'user', content: brief }];
  let best = { script: '', total: -1 };
  for (let round = 1; round <= 3; round++) {
    const script = textOf(await chat(wmsgs, false, true, wuse));
    if (!script) break;
    wmsgs.push({ role: 'assistant', content: script });
    let verdict = null;
    try {
      const raw = textOf(await chat([{ role: 'system', content: CRITIC_SYSTEM }, { role: 'user', content: script }], false, true, wcfg));
      verdict = JSON.parse((raw.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    } catch (e) {}
    if (!verdict || typeof verdict.total !== 'number') { log('評審回覆無法解析,採用目前劇本', 'warn'); return script; }
    if (verdict.total > best.total) best = { script, total: verdict.total };
    if (verdict.pass) { log(`劇本評分 ${verdict.total}/60${verdict.scores && typeof verdict.scores.share === 'number' ? `(傳播力 ${verdict.scores.share})` : ''},通過`, 'done'); return script; }
    log(`劇本評分 ${verdict.total}/60 未達標(第 ${round}/3 輪):${String(verdict.feedback || '').slice(0, 80)}`, 'warn');
    if (round < 3) wmsgs.push({ role: 'user', content: '評審未通過(' + verdict.total + '/60)。依以下意見改寫整份劇本:\n' + (verdict.feedback || '') });
  }
  log(`三輪未達標,採用最高分劇本(${best.total}/60)`, 'warn');
  return best.script;
}

async function runAgent(prompt, screenplay, quick) {
  imgRegistry = [];
  const before = structuredClone(scriptOf());
  aborter = new AbortController();
  let mutated = false, usedTool = false, force = true;
  const task = quick
    ? QUICK_GUIDE + '\n\n使用者的微調指令:' + prompt
    : screenplay
      ? '使用者原始需求:' + (prompt || '(見劇本)') + '\n\n以下是使用者定稿的劇本,你的工作是把它詳實填入腳本 JSON(settings/people/messages),忠於劇本的每一則對話、時間、已讀與形式安排,不要自行改劇情:\n' + screenplay +
        '\n\n(劇本結束。現在直接呼叫 apply_script 開始填入,先放 settings/people 與前幾則,再用 append_messages 分批補完;不要輸出文字。)'
      : '使用者任務:' + prompt;
  const msgs = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: '目前腳本 JSON:\n' + JSON.stringify(strip(scriptOf())) + '\n\n' + task },
  ];
  const loopLimit = Math.min(60, Math.max(3, +cfg().loops || 30)); // 每按一次「開始製作」重新起算;預設 30 約可做 80 則,只吃掉一半每日額度,留一半給微調與重試
  let allowForce = true; // 推理模型偶爾在 required 下硬回文字,Groq 直接 400;降級 auto+反偷懶訊息驅動
  try {
    for (let step = 1; step <= loopLimit; step++) {
      let m;
      for (let attempt = 1; ; attempt++) { // 模型偶爾把工具參數 JSON 寫壞(長輸出常見),重取樣重試
        try { m = await chat(msgs, force && allowForce); break; }
        catch (e) {
          if (e.name === 'AbortError') throw e;
          if (allowForce && /did not call a tool|tool_choice/i.test(e.message)) {
            allowForce = false;
            log('模型拒絕強制工具呼叫,改用引導模式重試', 'warn');
            continue;
          }
          if (attempt >= 3 || !/parse|json|failed_generation|tool call/i.test(e.message)) throw e;
          log(`模型工具參數格式錯誤,重試(${attempt}/2)`, 'warn');
        }
      }
      force = false;
      msgs.push(m);
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      if (!calls.length) {
        const text = (typeof m.content === 'string' ? m.content : '').trim();
        if (!usedTool && step < loopLimit) { // 反偷懶:只回文字沒動手,踹回去(參考 zerotype)
          log('模型只回了文字,要求改用工具執行', 'warn');
          msgs.push({ role: 'user', content: '不要只回覆文字或計畫,現在立刻呼叫工具完成任務。' });
          force = true;
          continue;
        }
        log(text || '已完成。', 'done');
        return;
      }
      let batchMutated = false;
      for (const call of calls) {
        const name = call.function && call.function.name;
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch (e) {}
        log('工具:' + name);
        let out;
        try {
          out = await execTool(name, args);
          usedTool = true;
          if (name === 'apply_script' || name === 'append_messages') { mutated = true; batchMutated = true; }
        } catch (e) { out = JSON.stringify({ ok: false, error: e.message }); }
        msgs.push({ role: 'tool', tool_call_id: call.id, name, content: out });
      }
      if (batchMutated && step < loopLimit - 1) { // 改完強制自審一輪(參考 zerotype 的 post-mutation review);微調查「有沒有多改」,大製作查劇情品質
        log('已要求模型自審剛才的修改', 'warn');
        msgs.push({ role: 'user', content: quick ? QUICK_REVIEW_MESSAGE : REVIEW_MESSAGE });
        force = true;
      }
    }
    log('已達迴圈上限(' + loopLimit + '),停在目前結果。', 'warn');
  } finally {
    if (mutated) {
      aiUndoStack.push({ draftId: currentId, snap: before });
      if (aiUndoStack.length > 20) aiUndoStack.shift();
      updateUndoButton();
    }
    aborter = null;
  }
}

// ── 面板 UI ──
function log(text, cls) {
  const box = $('#ai-log');
  const row = document.createElement('div');
  if (cls) row.className = cls;
  row.textContent = text;
  box.appendChild(row);
  while (box.children.length > 60) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}
function needsKey(c) { return !PROVIDERS[c.provider].keyless && !c.key; }
function updateGate() {
  const c = cfg();
  const offline = !navigator.onLine;
  const blocked = offline || needsKey(c) || !c.model;
  const w = writerCfg();
  const wBad = writerCfgBad(w);
  $('#ai-run').disabled = blocked;
  $('#ai-enhance').disabled = blocked || wBad; // 編劇另設但沒設完整,只擋「劇本強化」
  $('#ai-quick-run').disabled = offline; // 沒設定時保持可按:點了引導去連線設定(按鈕離設定太遠,死灰沒人懂)
  $('#ai-quick-run').title = offline ? '離線中,AI 需要網路' : (needsKey(c) || !c.model) ? '尚未設定 AI 連線,點我去設定' : '';
  $('#ai-status').textContent = offline ? '離線中:AI 需要網路(其餘功能照常離線可用)。'
    : needsKey(c) ? '先展開上方「連線設定」填 API Key(只存這台裝置,不會進草稿或分享連結)。'
    : !c.model ? '先展開上方「連線設定」填 Model 名稱。'
    : wBad ? '編劇模型設定不完整(缺 Model 或 Key),補完或 Provider 改回「同執行設定」。' : '';
  $('#ai-settings-summary').textContent = blocked && !offline
    ? '連線設定(尚未設定,點開填 API Key)'
    : `連線設定(${PROVIDERS[c.provider].label} · ${c.model}${w ? ` / 編劇:${PROVIDERS[w.provider].label} · ${w.model || '未填'}` : ''})`;
}
// 免費體驗額度徽章(右上角):免費 provider 才顯示,任務結束後刷新
async function refreshQuota() {
  const badge = $('#ai-quota');
  try {
    const r = await fetch(PROVIDERS.free.base + '/quota');
    if (!r.ok) throw new Error('quota ' + r.status);
    const q = await r.json();
    const parts = [];
    if (cfg().provider === 'free') parts.push(`AI ${Math.max(0, q.ipLimit - q.ipUsed)}/${q.ipLimit}`);
    if (cfg().provider === 'free' && typeof q.glmLimit === 'number') parts.push(`編劇 ${Math.max(0, q.glmLimit - q.glmUsed)}/${q.glmLimit}`);
    if (imgCfg().provider === 'free' && typeof q.imgLimit === 'number') parts.push(`圖 ${Math.max(0, q.imgLimit - q.imgUsed)}/${q.imgLimit}`);
    if (!parts.length) { badge.hidden = true; return; }
    badge.textContent = '今日剩:' + parts.join('・');
    badge.title = `免費額度每天重置(編劇=GLM,每天約 20 次、每次「劇本強化」用 1~3 次;AI=製作/微調/評審共用的文字額度;補圖 1 次=一整批圖)。全站今日:文字剩 ${Math.max(0, q.globalLimit - q.globalUsed)}/${q.globalLimit}、編劇剩 ${Math.max(0, (q.glmGlobalLimit || 0) - (q.glmGlobalUsed || 0))}/${q.glmGlobalLimit || 0}、補圖剩 ${Math.max(0, (q.imgGlobalLimit || 0) - (q.imgGlobalUsed || 0))}/${q.imgGlobalLimit || 0}。自帶 key 不受這些限制。`;
    badge.hidden = false;
  } catch (e) { badge.hidden = true; }
}
// ── AI 補圖:格盤一次生成 → 自動切回(幾何=程式碼,內容=美術指導 AI;走 worker 代理的 codex-image-service) ──
const PROXY_BASE = PROVIDERS.free.base;
let imgAbort = false;
function imgCfg() { const c = cfg(); return { provider: ['gemini', 'codex', 'openai'].includes(c.imgProvider) ? c.imgProvider : 'free', key: c.imgKey || '' }; }
function b64ToBitmap(b64, mime) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return createImageBitmap(new Blob([arr], { type: mime || 'image/png' }));
}
async function geminiImage(prompt, size) { // 自帶 Gemini key 生圖(不吃站長額度)
  const c = cfg();
  const key = imgCfg().key || (c.wProvider === 'gemini' ? c.wKey : '') || (c.provider === 'gemini' ? c.key : '');
  if (!key) { const e = new Error('請在連線設定的「圖像生成」填 Gemini API Key(或先把編劇設成 Gemini)。'); throw e; }
  const aspect = size === '1024x1536' ? '2:3' : size === '1536x1024' ? '3:2' : '1:1';
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: aspect } } }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e0 = Array.isArray(d) ? d[0] || {} : d; throw new Error((e0.error && e0.error.message) || 'HTTP ' + r.status); }
  const parts = (((d.candidates || [])[0] || {}).content || {}).parts || [];
  const part = parts.find((p) => p.inlineData);
  if (!part) throw new Error('Gemini 沒有回傳圖片。');
  return b64ToBitmap(part.inlineData.data, part.inlineData.mimeType);
}
async function codexImage(prompt, size, onJob) { // 自架 codex-image-service(跟站長同款後端,自己的 base+cimg key)
  const c = cfg();
  const base = String(c.imgBase || '').replace(/\/+$/, '');
  if (!base || !c.imgKey) throw new Error('請在「圖像生成」填自架服務的 Base URL 與 cimg API Key。');
  const auth = { authorization: 'Bearer ' + c.imgKey };
  const r = await fetch(base + '/v1/images/jobs', { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ prompt, size, quality: 'medium', count: 1 }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.detail || (d.error && d.error.message) || 'HTTP ' + r.status);
  if (onJob) onJob(d.id);
  for (let i = 0; i < 120; i++) {
    await new Promise((s) => setTimeout(s, 5000));
    if (imgAbort) { const e = new Error('已停止。'); e.name = 'AbortError'; throw e; }
    const pr = await fetch(base + '/v1/images/jobs/' + d.id, { headers: auth });
    const pd = await pr.json().catch(() => ({}));
    if (pd.status === 'succeeded') {
      const ir = await fetch(pd.images[0].url);
      if (!ir.ok) throw new Error('下載成品失敗(HTTP ' + ir.status + ')');
      return createImageBitmap(await ir.blob());
    }
    if (pd.status === 'failed' || pd.status === 'expired') throw new Error('生圖失敗:' + (pd.error || pd.status));
    if (i % 6 === 5) log(`生成中…(約 ${(i + 1) * 5} 秒)`);
  }
  throw new Error('生圖逾時。');
}
async function openaiImage(prompt, size) { // OpenAI 官方繪圖 API(自帶 key)
  const c = cfg();
  if (!c.imgKey) throw new Error('請在「圖像生成」填 OpenAI API Key。');
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + c.imgKey },
    body: JSON.stringify({ model: (c.imgModel || 'gpt-image-2').trim(), prompt, size, n: 1 }), // gpt-image-1 於 2026-10 退場
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.error && d.error.message) || 'HTTP ' + r.status);
  const b64 = d.data && d.data[0] && d.data[0].b64_json;
  if (!b64) throw new Error('OpenAI 沒有回傳圖片。');
  return b64ToBitmap(b64, 'image/png');
}
async function generateBitmap(prompt, size, onJob) { // 生圖路由:站長贊助(worker 代理)/自帶 Gemini/自架 codex/OpenAI
  const p = imgCfg().provider;
  if (p === 'gemini') { log('生圖:Gemini(自帶 key,不吃每日限量)…'); return geminiImage(prompt, size); }
  if (p === 'codex') { log('生圖:自架 codex-image-service…'); return codexImage(prompt, size, onJob); }
  if (p === 'openai') { log('生圖:OpenAI 繪圖 API…'); return openaiImage(prompt, size); }
  const jobId = await createImageJob(prompt, size, onJob);
  const url = await waitImageJob(jobId);
  return fetchGeneratedBitmap(url);
}
const ART_DIRECTOR_SYSTEM = `你是美術指導。輸入是一份 LINE 對話腳本與待補圖清單(格號/類型/線索)。為每一格寫繪圖 prompt(繁體中文,每格 ≤80 字):
- 每一格都必須在句首自己寫明畫風,不可省略:所有格會畫在同一張網格圖上、彼此畫風會互相感染,只有每格都把畫風標死,寫實的頭像才不會被卡通貼圖帶成動漫風。
- 同一人物在不同格外觀必須一致:先自行設定(髮型/衣著/年齡/體型),每個出現該人物的格都重複同一套描述
- 貼圖格:「Q版可愛貼圖插畫風」,主體置中佔滿,背景整片純綠色,無文字無邊框
- 照片格:「寫實手機隨手拍照片風」,真實質感,自然光,構圖填滿整格
- 頭像格:先依這個人的個性與劇情,選一種最搭他的畫風(寫實人像照/清新插畫頭像/卡通角色/他養的寵物/一個代表物…),在句首把選定的畫風標死;不同人本來就該不同風,重點是「每個頭像各自選定並寫明畫風」,別讓整盤被某一格帶成同一種風。主體置中、單色淺色背景
只回傳 JSON 陣列:[{"cell":1,"prompt":"..."}],依格號排序,不要多餘文字。`;

function collectImageSlots() {
  const slots = [];
  state.messages.forEach((m, i) => {
    if (m.type === 'msg' && (m.kind === 'image' || m.kind === 'sticker') && !m.img) {
      slots.push({ type: m.kind, msgIndex: i, hint: m.imgDesc || '' });
    }
  });
  state.people.forEach((p, i) => { if (!p.avatar) slots.push({ type: 'avatar', personIndex: i, hint: '「' + p.name + '」的大頭貼' }); });
  return slots.slice(0, 12); // 一次呼叫的上限(3×4);再多的下次再補
}
function planGrid(n) { return LCM_PURE.planGrid(n); } // 盤面選擇見 pure.js
function buildGridPrompt(grid, cells) {
  return [
    `一張 ${grid.cols}×${grid.rows} 等分網格圖。格與格之間用明顯的粗白色分隔線隔開,每格內容完全獨立、不可跨格。`,
    `共 ${cells.length} 格有內容(由左至右、由上至下編號),多出來的格子留純白。整張圖禁止任何文字、編號、浮水印。`,
    ...cells.map((c, i) => `格${i + 1}:${c.prompt}`),
  ].join('\n');
}
async function createImageJob(prompt, size, onJob) {
  const r = await fetch(PROXY_BASE + '/images/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, size }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.error && d.error.message) || 'HTTP ' + r.status);
  if (onJob) onJob(d.id);
  return d.id;
}
async function waitImageJob(id) {
  for (let i = 0; i < 120; i++) { // 5 秒一輪,最長 10 分鐘
    await new Promise((r) => setTimeout(r, 5000));
    if (imgAbort) { const e = new Error('已停止。'); e.name = 'AbortError'; throw e; }
    const r = await fetch(PROXY_BASE + '/images/jobs/' + id);
    const d = await r.json().catch(() => ({}));
    if (d.status === 'succeeded') return d.images[0].url;
    if (d.status === 'failed' || d.status === 'expired') throw new Error('生圖失敗:' + (d.error || d.status));
    if (i % 6 === 5) log(`生成中…(約 ${(i + 1) * 5} 秒)`);
  }
  throw new Error('生圖逾時,稍後再試。');
}
async function fetchGeneratedBitmap(url) {
  const p = url.slice(url.indexOf('/generated/'));
  const r = await fetch(PROXY_BASE + '/images/file?p=' + encodeURIComponent(p));
  if (!r.ok) throw new Error('下載成品失敗(HTTP ' + r.status + ')');
  return createImageBitmap(await r.blob());
}
function chromaKey(canvas) { // 貼圖綠底去背:純邏輯(四角取綠 + 色距去背 + 綠底閘門)在 pure.js,app 與測試共用同一份
  const g = canvas.getContext('2d');
  const im = g.getImageData(0, 0, canvas.width, canvas.height);
  LCM_PURE.chromaKeyData(im.data, canvas.width, canvas.height);
  g.putImageData(im, 0, 0);
}
function drawSlot(img, sx, sy, sw, sh, type) {
  const target = Math.min(512, Math.max(64, Math.round(sw))); // 切格盤原生尺寸(上限 512),不再壓到 96/320/480
  const out = document.createElement('canvas');
  out.width = target; out.height = target;
  const g = out.getContext('2d');
  if (type === 'image') { g.fillStyle = '#fff'; g.fillRect(0, 0, target, target); }
  g.drawImage(img, sx, sy, sw, sh, 0, 0, target, target);
  if (type === 'sticker') chromaKey(out);
  return out.toDataURL('image/webp', 0.82); // WebP:同尺寸比 PNG/JPEG 小很多、貼圖 alpha 保留;不支援的舊瀏覽器會自動退回 PNG
}
function applyGrid(img, grid, cells) { // 切圖回填共用:網格圖 → 各格 dataURL → 寫回 state(切圖幾何在 pure.js)
  cells.forEach((c, i) => {
    if (c.skip) return; // 取回時目標已對不上的格:仍佔格位維持切圖對位,但不回填避免貼錯
    const rect = LCM_PURE.cellRect(img.width, img.height, grid, i);
    const dataUrl = drawSlot(img, rect.sx, rect.sy, rect.sw, rect.sh, c.type);
    if (c.type === 'avatar') { const p = state.people[c.personIndex]; if (p) { p.avatar = dataUrl; p.avatarPrompt = c.prompt; } }
    else { const m = state.messages[c.msgIndex]; if (m) { m.img = dataUrl; m.imgPrompt = c.prompt; } }
  });
}
// ── 取回上次補圖:補圖送出 job 後把重建切圖所需的最小資訊存進 localStorage;逾時/報錯不清,事後可一鍵查後端把已生成的結果切回 ──
const FILL_PENDING_KEY = 'lcm-fill-pending';
function savePending(jobId, grid, cells) { // cells = 扁平版 [{type,msgIndex?,personIndex?,prompt}]
  // 蓋上目標指紋:頭像用穩定的 personId(可抗人物重排)、訊息用 time/kind/personId/side,
  // 取回時若草稿已變動、指紋對不上就略過該格,避免把圖靜默貼到錯的訊息/人物上。
  const stamped = cells.map((c) => {
    if (c.type === 'avatar') { const p = state.people[c.personIndex]; return Object.assign({}, c, { personId: p && p.id }); }
    const m = state.messages[c.msgIndex];
    return Object.assign({}, c, { fp: m ? { time: m.time, kind: m.kind, personId: m.personId, side: m.side } : null });
  });
  try {
    localStorage.setItem(FILL_PENDING_KEY, JSON.stringify({
      draftId: currentId,
      provider: imgCfg().provider, // 'free' 或 'codex'(同步 provider 不會走到這)
      jobId,
      grid: { cols: grid.cols, rows: grid.rows },
      cells: stamped,
      msgLen: state.messages.length,
      peopleLen: state.people.length,
      ts: Date.now(),
    }));
  } catch (e) {}
  updateRecoverButton();
}
function readPending() { try { return JSON.parse(localStorage.getItem(FILL_PENDING_KEY)); } catch (e) { return null; } }
function clearPending() { try { localStorage.removeItem(FILL_PENDING_KEY); } catch (e) {} updateRecoverButton(); }
function updateRecoverButton() { // 只在「當前草稿有 pending」時顯示
  const b = $('#ai-recover'); if (!b) return;
  const rec = readPending();
  b.hidden = !(rec && rec.draftId === currentId);
}
async function probeFillJob(record) { // 單次查後端 job;succeeded→回 bitmap,failed/expired/404→dead,其餘→仍在生成
  if (record.provider === 'codex') {
    const c = cfg();
    const base = String(c.imgBase || '').replace(/\/+$/, '');
    if (!base || !c.imgKey) throw new Error('自架服務設定已變更,無法取回。');
    const auth = { authorization: 'Bearer ' + c.imgKey };
    const r = await fetch(base + '/v1/images/jobs/' + record.jobId, { headers: auth });
    if (r.status === 404) return { dead: true };
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json().catch(() => ({}));
    if (d.status === 'succeeded') { const ir = await fetch(d.images[0].url); if (!ir.ok) throw new Error('下載成品失敗(HTTP ' + ir.status + ')'); return { done: true, img: await createImageBitmap(await ir.blob()) }; }
    if (d.status === 'failed' || d.status === 'expired') return { dead: true };
    return {};
  }
  // free / worker 代理
  const r = await fetch(PROXY_BASE + '/images/jobs/' + record.jobId);
  if (r.status === 404) return { dead: true };
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json().catch(() => ({}));
  if (d.status === 'succeeded') return { done: true, img: await fetchGeneratedBitmap(d.images[0].url) };
  if (d.status === 'failed' || d.status === 'expired') return { dead: true };
  return {};
}
async function recoverFill() {
  const record = readPending();
  if (!record) { toast('沒有可取回的補圖'); updateRecoverButton(); return; }
  if (record.draftId !== currentId) { toast('上次補圖屬於另一份草稿;請先切到該草稿再取回'); return; }
  setBusy(true); imgAbort = false;
  log('取回上次補圖:查詢後端結果…', 'prompt');
  const before = structuredClone(scriptOf());
  try {
    const res = await probeFillJob(record);
    if (res.dead) { log('上次的補圖結果已過期或失敗;已清除紀錄。', 'err'); toast('補圖結果已過期;已清除'); clearPending(); }
    else if (!res.done) { log('後端仍在生成;請稍後再按「取回上次補圖」。', 'warn'); toast('圖還在生成;稍後再取回'); }
    else {
      const v = LCM_PURE.validateFillCells(record.cells, state.messages, state.people);
      if (v.skipped) {
        toast('草稿已變動;跳過 ' + v.skipped + ' 格避免貼錯');
        log('有 ' + v.skipped + ' 格的目標訊息／人物已變動,為避免貼錯已略過(可重新補圖)。', 'warn');
      }
      applyGrid(res.img, record.grid, v.cells);
      aiUndoStack.push({ draftId: currentId, snap: before });
      if (aiUndoStack.length > 20) aiUndoStack.shift();
      updateUndoButton(); save(); render();
      clearPending();
      log(`已取回並回填 ${record.cells.length - v.skipped} 格。不滿意可「還原上一步」。`, 'done');
      toast('已取回上次補圖');
    }
  } catch (e) {
    log(e.name === 'AbortError' ? '已停止。' : '取回失敗:' + e.message, 'err');
    toast('取回失敗;詳見 AI 分頁紀錄');
  }
  imgAbort = false;
  setBusy(false);
  refreshQuota();
}
async function runFillImages() {
  const slots = collectImageSlots();
  if (!slots.length) { toast('沒有待補的圖:圖片/貼圖與頭像都有內容了'); return; }
  const before = structuredClone(scriptOf());
  setBusy(true); imgAbort = false;
  log(`AI 補圖:共 ${slots.length} 格(1 次生圖呼叫)`, 'prompt');
  try {
    aborter = new AbortController();
    log('美術指導設計各格 prompt…');
    imgRegistry = [];
    const ctxScript = JSON.stringify(strip(scriptOf())).slice(0, 6000);
    const slotDesc = slots.map((s, i) => `格${i + 1}(${s.type === 'sticker' ? '貼圖' : s.type === 'image' ? '照片' : '頭像'}):${(s.hint || '(依脈絡發揮)').slice(0, 60)}`).join('\n');
    const adRaw = textOf(await chat([
      { role: 'system', content: ART_DIRECTOR_SYSTEM },
      { role: 'user', content: '腳本(人物一致性參考):\n' + ctxScript + '\n\n待補圖清單:\n' + slotDesc },
    ], false, true, writerCfg() || cfg()));
    aborter = null;
    let plans = [];
    try { plans = JSON.parse((adRaw.match(/\[[\s\S]*\]/) || ['[]'])[0]); } catch (e) {}
    const cells = slots.map((s, i) => ({ slot: s, prompt: String((plans.find((p) => p.cell === i + 1) || {}).prompt || s.hint || '簡潔可愛的插圖') }));
    const grid = planGrid(cells.length);
    const fillCells = cells.map((c) => ({ type: c.slot.type, msgIndex: c.slot.msgIndex, personIndex: c.slot.personIndex, prompt: c.prompt }));
    log(`送出生圖(${grid.cols}×${grid.rows} 格盤)…`);
    const img = await generateBitmap(buildGridPrompt(grid, cells), grid.size, (jobId) => savePending(jobId, grid, fillCells));
    log('生成完成,切圖回填…');
    applyGrid(img, grid, fillCells);
    aiUndoStack.push({ draftId: currentId, snap: before });
    if (aiUndoStack.length > 20) aiUndoStack.shift();
    updateUndoButton(); save(); render();
    clearPending();
    log(`已回填 ${cells.length} 格。不滿意可「還原上一步」;滑到單張圖上可按「重生」。`, 'done');
    toast('AI 補圖完成');
  } catch (e) {
    log(e.name === 'AbortError' ? '已停止。' : '補圖失敗:' + e.message, 'err');
    if (readPending()) log('後端可能仍在生成;稍後可按「取回上次補圖」把已生成的結果切回。', 'warn');
    toast('AI 補圖失敗,詳見 AI 分頁紀錄');
  }
  aborter = null; imgAbort = false;
  setBusy(false);
  updateRecoverButton();
  refreshQuota();
}
$('#ai-images').addEventListener('click', () => { if (!navigator.onLine) { toast('離線中,AI 補圖需要網路'); return; } runFillImages(); });
$('#ai-recover').addEventListener('click', () => { if (!navigator.onLine) { toast('離線中;取回需要網路'); return; } recoverFill(); });
window.lcmRegenImage = async (msgIndex) => { // 單格重生(app.js 的 hover 按鈕呼叫)
  const m = state.messages[msgIndex];
  if (!m || !m.imgPrompt || !navigator.onLine) return;
  const before = structuredClone(scriptOf());
  setBusy(true); imgAbort = false;
  log('單格重生:' + m.imgPrompt.slice(0, 40), 'prompt');
  try {
    const style = m.kind === 'sticker' ? '。Q版可愛貼圖風格,主體置中,背景整片純綠色,無文字' : '。真實手機隨手拍質感';
    const img = await generateBitmap(m.imgPrompt + style, '1024x1024');
    m.img = drawSlot(img, 0, 0, img.width, img.height, m.kind);
    aiUndoStack.push({ draftId: currentId, snap: before });
    if (aiUndoStack.length > 20) aiUndoStack.shift();
    updateUndoButton(); save(); render();
    toast('重生完成,不滿意可「還原上一步」');
  } catch (e) { log('重生失敗:' + e.message, 'err'); toast('重生失敗'); }
  imgAbort = false;
  setBusy(false);
  refreshQuota();
};

// 劇本跟著草稿走(localStorage per draft id,不進 state:分享連結與匯出不帶劇本)
function screenplayLoad() { try { $('#ai-screenplay-text').value = localStorage.getItem('lcm-screenplay-' + currentId) || ''; } catch (e) {} screenplayCount(); }
function screenplaySave() { try { localStorage.setItem('lcm-screenplay-' + currentId, $('#ai-screenplay-text').value); } catch (e) {} }
function fillCfgForm() {
  const c = cfg();
  const sel = $('#ai-provider');
  if (!sel.options.length) for (const [id, p] of Object.entries(PROVIDERS)) { const o = document.createElement('option'); o.value = id; o.textContent = p.label; sel.appendChild(o); }
  sel.value = c.provider;
  $('#ai-base').value = c.base || '';
  $('#ai-model').value = c.model || '';
  $('#ai-key').value = c.key || '';
  $('#ai-loops').value = Math.min(60, Math.max(3, +c.loops || 30));
  const wsel = $('#ai-w-provider');
  if (!wsel.options.length) {
    const same = document.createElement('option'); same.value = ''; same.textContent = '同執行設定'; wsel.appendChild(same);
    for (const [id, p] of Object.entries(PROVIDERS)) { const o = document.createElement('option'); o.value = id; o.textContent = p.label; wsel.appendChild(o); }
  }
  wsel.value = PROVIDERS[c.wProvider] ? c.wProvider : '';
  $('#ai-w-fields').hidden = !wsel.value;
  $('#ai-w-base').value = c.wBase || '';
  $('#ai-w-model').value = c.wModel || '';
  $('#ai-w-key').value = c.wKey || '';
  { // 圖像生成:依來源切欄位與提示
    const ip = imgCfg().provider;
    $('#ai-img-provider').value = ip;
    $('#ai-img-fields').hidden = ip === 'free';
    $('#ai-img-base-row').hidden = ip !== 'codex';
    $('#ai-img-model-row').hidden = ip !== 'openai';
    $('#ai-img-base').value = c.imgBase || '';
    $('#ai-img-model').value = c.imgModel || (ip === 'openai' ? 'gpt-image-2' : '');
    $('#ai-img-key').value = c.imgKey || '';
    $('#ai-img-key-label').textContent = ip === 'codex' ? 'cimg API Key' : ip === 'openai' ? 'OpenAI API Key' : 'Gemini API Key(留空=沿用編劇或執行的 Gemini key)';
    $('#ai-img-hint').textContent = ip === 'codex'
      ? '跟本站同款的自架後端(repo:codex-image-service);你的服務要允許本站的 CORS(nginx 加 Access-Control-Allow-Origin 等,參考該 repo 部署說明)。'
      : ip === 'openai' ? '直接呼叫 api.openai.com(計費照你的 OpenAI 帳號);key 只存這台裝置。'
      : ip === 'gemini' ? 'key 只存這台裝置;免費額度依 Google 帳號。' : '';
  }
  updateGate();
}
function setBusy(on) {
  $('#ai-run').disabled = on;
  $('#ai-enhance').disabled = on;
  $('#ai-quick-run').disabled = on;
  $('#ai-images').disabled = on;
  $('#ai-recover').disabled = on;
  $('#ai-stop').hidden = !on;
  if (!on) updateGate();
}

$('#ai-provider').addEventListener('change', (e) => {
  const p = PROVIDERS[e.target.value];
  saveCfg({ ...cfg(), provider: e.target.value, base: p.base, model: p.model });
  fillCfgForm();
  refreshQuota();
});
$('#ai-img-provider').addEventListener('change', (e) => {
  saveCfg({ ...cfg(), imgProvider: e.target.value });
  fillCfgForm();
  refreshQuota();
});
for (const [id, key] of [['#ai-base', 'base'], ['#ai-model', 'model'], ['#ai-key', 'key'], ['#ai-loops', 'loops'], ['#ai-w-base', 'wBase'], ['#ai-w-model', 'wModel'], ['#ai-w-key', 'wKey'], ['#ai-img-key', 'imgKey'], ['#ai-img-base', 'imgBase'], ['#ai-img-model', 'imgModel']]) {
  $(id).addEventListener('input', (e) => { saveCfg({ ...cfg(), [key]: e.target.value.trim() }); updateGate(); });
}
$('#ai-w-provider').addEventListener('change', (e) => {
  const id = e.target.value;
  const p = PROVIDERS[id];
  saveCfg({ ...cfg(), wProvider: id, wBase: p ? p.base : '', wModel: p ? (p.writerModel || p.model) : '', wKey: id ? cfg().wKey || '' : '' });
  fillCfgForm();
});
$('#ai-enhance').addEventListener('click', async () => { // 第 1 段:發想與充實劇本(可反覆)
  const prompt = $('#ai-prompt').value.trim();
  const existing = $('#ai-screenplay-text').value.trim();
  if (!prompt && !existing) { $('#ai-prompt').focus(); return; }
  setBusy(true);
  log('劇本強化:' + (prompt || '(依既有劇本)'), 'prompt');
  aborter = new AbortController();
  try {
    const s = await writeScreenplay(prompt || '把既有劇本整體強化', existing);
    if (s) { $('#ai-screenplay-text').value = s; screenplaySave(); screenplayCount(); log('劇本已更新:可直接編輯、再按「劇本強化」迭代;滿意就按「開始製作」。', 'done'); }
  } catch (e) { log(e.name === 'AbortError' ? '已停止。' : '失敗:' + e.message, 'err'); }
  aborter = null;
  setBusy(false);
  refreshQuota();
});
$('#ai-copy-prompt').addEventListener('click', async () => { // 複製劇本 prompt,拿去外部 GPT/Gemini/Claude 產生,再貼回劇本欄
  const prompt = $('#ai-prompt').value.trim();
  const existing = $('#ai-screenplay-text').value.trim();
  if (!prompt && !existing) { $('#ai-prompt').focus(); toast('先在「劇情主題」寫幾個字,或劇本欄先起個頭'); return; }
  const full = WRITER_SYSTEM + '\n\n─────── 以下是你的委託 ───────\n' + writerBrief(prompt || '把既有劇本整體強化', existing) +
    '\n\n請直接輸出一份完整劇本(不要多餘說明);產生後把整段貼回製造機的「劇本」欄,再按「開始製作」。';
  try { await navigator.clipboard.writeText(full); toast('已複製劇本 prompt;貼到 ChatGPT／Gemini／Claude 產生後,把劇本貼回下方「劇本」欄'); }
  catch (e) { $('#ai-screenplay-text').value = full; screenplaySave(); toast('無法自動複製;已把 prompt 放進劇本欄,請自行剪下貼到外部 AI(記得產生後貼回)'); }
});
$('#ai-run').addEventListener('click', async () => { // 第 2 段:穩定實作(忠於劇本)
  const prompt = $('#ai-prompt').value.trim();
  const screenplay = $('#ai-screenplay-text').value.trim();
  if (!prompt && !screenplay) { $('#ai-prompt').focus(); return; }
  setBusy(true);
  log('開始製作:' + (screenplay ? '依定稿劇本' : prompt), 'prompt');
  try { await runAgent(prompt, screenplay); }
  catch (e) { log(e.name === 'AbortError' ? '已停止。' : '失敗:' + e.message, 'err'); }
  setBusy(false);
  refreshQuota();
});
$('#ai-quick-run').addEventListener('click', async () => { // 微調:直接下指令改畫面,不經劇本
  const c = cfg();
  if (needsKey(c) || !c.model) { // 沒設定 → 帶去 AI 分頁的連線設定
    document.querySelector('.tabs [data-pane="ai"]').click();
    $('#ai-settings').open = true;
    $(needsKey(c) ? '#ai-key' : '#ai-model').focus();
    toast('先設定 AI 連線(填 API Key),設好就能用 AI 修改');
    return;
  }
  const quick = $('#ai-quick').value.trim();
  if (!quick) { $('#ai-quick').focus(); return; }
  setBusy(true);
  log('微調:' + quick, 'prompt');
  try { await runAgent(quick, '', true); $('#ai-quick').value = ''; toast('AI 微調完成,不滿意可按「還原上一步」'); }
  catch (e) { log(e.name === 'AbortError' ? '已停止。' : '失敗:' + e.message, 'err'); toast('AI 微調失敗,詳見 AI 分頁紀錄'); }
  setBusy(false);
  refreshQuota();
});
$('#ai-quick').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#ai-quick-run').click(); });
function screenplayCount() { // 讓使用者看得見劇本長度:超過 40 則執行端會做不完,現在只會停在一半
  const el2 = $('#ai-screenplay-count');
  if (!el2) return;
  const t = ($('#ai-screenplay-text').value || '');
  if (!t.trim()) { el2.textContent = ''; el2.style.color = ''; return; }
  // 粗估:以「角色：內容」或方括號記法開頭的行當一則
  const n = t.split('\n').filter((L) => /^\s*(\[[^\]]+\]|[^\s:：]{1,12}\s*[:：])/.test(L)).length;
  const over = n > 40;
  el2.textContent = '劇本約 ' + n + ' 則' + (over ? '(超過 40 則,執行端可能做不完,建議砍掉鋪陳或分幕製作)' : '');
  el2.style.color = over ? '#b45309' : '';
}
$('#ai-screenplay-text').addEventListener('input', () => { screenplaySave(); screenplayCount(); });
$('#ai-stop').addEventListener('click', () => { imgAbort = true; if (aborter) aborter.abort(); });
$('#ai-undo').addEventListener('click', () => {
  const mine = undoEntries();
  const entry = mine[mine.length - 1];
  if (!entry) return;
  aiUndoStack.splice(aiUndoStack.lastIndexOf(entry), 1);
  state.settings = entry.snap.settings; state.people = entry.snap.people; state.messages = entry.snap.messages;
  save(); render(); updateUndoButton();
  toast('已還原上一步 AI 修改' + (undoEntries().length ? `(還可再退 ${undoEntries().length} 步)` : ''));
});
$('#ai-prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#ai-enhance').click(); }); // 主題欄的主動作=劇本強化
$('#ai-new-draft').addEventListener('click', async () => { // 借用草稿頁的既有邏輯
  $('#draft-new').click();
  await new Promise((r) => setTimeout(r, 50)); // 等 currentId 換新
  screenplayLoad(); updateUndoButton(); updateRecoverButton();
  toast('已開新草稿,AI 會在這份上創作');
});
document.querySelector('.tabs [data-pane="ai"]').addEventListener('click', () => { screenplayLoad(); updateUndoButton(); updateRecoverButton(); }); // 切回 AI 頁時同步目前草稿
for (const [label, idea] of IDEAS) {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = label; b.title = idea;
  b.addEventListener('click', () => { $('#ai-prompt').value = idea; $('#ai-prompt').focus(); });
  $('#ai-ideas').appendChild(b);
}
window.addEventListener('online', updateGate);
window.addEventListener('offline', updateGate);
fillCfgForm();
updateUndoButton();
updateRecoverButton();
refreshQuota();
{ const c = cfg(); $('#ai-settings').open = needsKey(c) || !c.model; } // 只在載入時決定一次:沒設好=展開;之後不自動開合,不打擾使用者輸入

// ── WebMCP:同一組工具註冊給頁面的 modelContext,外部 agent 不必戳 DOM 就能操作本頁 ──
// 規格已把 API 從 navigator 搬到 document:Chrome 150 兩個都有(共用同一份工具表),149 只有 navigator。
// 優先 document,navigator 版被拔掉時才不會整條啞掉。
try {
  const mc = document.modelContext || navigator.modelContext;
  if (mc) {
    const tools = TOOL_DEFS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters,
      annotations: t.name === 'get_script' ? { readOnlyHint: true } : {},
      execute: async (args) => ({ content: [{ type: 'text', text: await execTool(t.name, typeof args === 'string' ? JSON.parse(args || '{}') : (args || {})) }] }),
    }));
    if (typeof mc.registerTool === 'function') for (const t of tools) mc.registerTool(t); // Chrome 149/150 實測走這條
    else if (typeof mc.provideContext === 'function') mc.provideContext({ tools }); // 規格變體備援
  }
} catch (e) { console.warn('WebMCP 註冊失敗(不影響內建 AI)', e); }

})();
