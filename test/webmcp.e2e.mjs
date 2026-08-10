/* WebMCP 端到端驗收:頁面把工具註冊給 navigator.modelContext,外部 agent 從 DevTools 協定叫得動。
   零相依:直接 spawn Chrome + 講 CDP(node 22 內建 WebSocket)。
   跑法:node test/webmcp.e2e.mjs   需要本機有 google-chrome。
   註:navigator.modelContext 目前還要旗標才有(Chrome 149 實測),所以第一段是負控制——沒旗標必須拿不到。*/
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert';

const CHROME = process.env.CHROME || 'google-chrome';
// 等同 chrome://flags/#enable-webmcp-testing;Chrome 149 是 origin trial 階段,沒開旗標就沒有這個 API
const FLAGS = ['--enable-features=WebMCPTesting'];
const PAGE = 'file://' + resolve(import.meta.dirname, '..', 'index.html');

// ── 最小 CDP client ──
async function openChrome(extraArgs) {
  const dir = mkdtempSync(join(tmpdir(), 'lcm-webmcp-'));
  const port = 9200 + Math.floor(performance.now() % 300);
  const proc = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check', ...extraArgs, 'about:blank'],
    { stdio: 'ignore' });
  let ws;
  for (let i = 0; i < 100 && !ws; i++) { // 等 devtools 端點起來
    await new Promise((r) => setTimeout(r, 100));
    try { ws = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; } catch (e) {}
  }
  assert.ok(ws, '連不上 Chrome 的 DevTools 端點,確認裝了 ' + CHROME);
  const sock = new WebSocket(ws);
  await new Promise((r, j) => { sock.onopen = r; sock.onerror = j; });
  let id = 0; const waiting = new Map();
  sock.onmessage = (e) => { const m = JSON.parse(e.data); if (waiting.has(m.id)) waiting.get(m.id)(m); };
  const send = (method, params, sessionId) => new Promise((r, j) => {
    const n = ++id; waiting.set(n, (m) => (m.error ? j(new Error(method + ': ' + m.error.message)) : r(m.result)));
    sock.send(JSON.stringify({ id: n, method, params, sessionId }));
  });
  const close = async () => { // 等 Chrome 真的收攤再刪 profile,否則 rmdir 撞到它還在寫檔
    try { sock.close(); } catch (e) {}
    await new Promise((r) => { proc.once('exit', r); proc.kill(); setTimeout(r, 3000); });
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  };
  return { send, close };
}

// 開一個分頁載入頁面,回傳「在頁面裡跑 JS」的函式(等同任何 agent 用 DevTools 做的事)
async function openPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  await new Promise((r) => setTimeout(r, 3000)); // 等 app.js/ai.js 跑完註冊
  return async (expression) => {
    const { result, exceptionDetails } = await cdp.send('Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
}

const results = [];
// fn 回 'skip' = 這版瀏覽器沒這個功能,不算通過也不算失敗
const check = async (name, fn) => { try { results.push([(await fn()) === 'skip' ? 'SKIP' : 'PASS', name]); } catch (e) { results.push(['FAIL', name + ' → ' + e.message]); } };

// ── 1. 負控制:沒開旗標就不該有 modelContext(有的話代表 API 已預設開啟,這支測試的前提要重寫) ──
{
  const cdp = await openChrome([]);
  const evalIn = await openPage(cdp, PAGE);
  await check('沒旗標時 navigator.modelContext 不存在', async () => {
    assert.strictEqual(await evalIn('typeof navigator.modelContext'), 'undefined');
  });
  await cdp.close();
}

// ── 2. 開旗標:註冊落地 + 外部呼叫真的改到畫面 ──
{
  const cdp = await openChrome(FLAGS);
  const evalIn = await openPage(cdp, PAGE);

  await check('四個工具都註冊得到,且帶 inputSchema', async () => {
    const tools = await evalIn(`navigator.modelContext.getTools().then(ts => ts.map(t => ({name: t.name, schema: !!t.inputSchema})))`);
    assert.deepStrictEqual(tools.map((t) => t.name).sort(),
      ['append_messages', 'apply_script', 'export_png', 'get_script'].sort());
    assert.ok(tools.every((t) => t.schema), '有工具沒帶 schema');
  });

  await check('外部呼叫 append_messages 後,訊息真的出現在畫面上', async () => {
    // 坑:第一參數要 getTools() 拿到的工具物件(不是名字),第二參數要 JSON 字串(不是物件)
    const out = await evalIn(`(async () => {
      const t = (await navigator.modelContext.getTools()).find(x => x.name === 'append_messages');
      const args = JSON.stringify({ messages: [{ type: 'msg', side: 'right', text: 'WEBMCP_E2E_MARK' }] });
      const r = JSON.parse(await navigator.modelContext.executeTool(t, args));
      return r.content?.[0]?.text || '';
    })()`);
    assert.match(out, /"ok":true/, '工具回傳不是成功:' + out);
    await new Promise((r) => setTimeout(r, 800));
    // 工具回 ok 不等於使用者看得到:一定要驗畫面(漏 type:"msg" 時就是 ok 但沒東西)
    assert.ok(await evalIn(`document.querySelector('#phone').innerText.includes('WEBMCP_E2E_MARK')`),
      '工具回成功,但畫面上找不到那則訊息');
  });

  await check('Chrome 150 起的 document.modelContext 也看得到同一組工具', async () => {
    const shape = await evalIn(`(async () => {
      if (typeof document.modelContext === 'undefined') return 'n/a'; // 149 只有 navigator 版
      return (await document.modelContext.getTools()).map(t => t.name).sort().join(',');
    })()`);
    if (shape === 'n/a') return 'skip'; // Chrome 149 只有 navigator 版
    assert.strictEqual(shape, 'append_messages,apply_script,export_png,get_script');
  });

  await check('傳工具名字而不是工具物件會被擋下來', async () => {
    const err = await evalIn(`navigator.modelContext.executeTool('append_messages', '{}').then(() => '沒有丟錯', e => String(e))`);
    assert.match(err, /RegisteredTool/, '預期噴 RegisteredTool 型別錯,實得:' + err);
  });

  await cdp.close();
}

for (const [state, name] of results) console.log(`  ${{ PASS: 'ok  ', SKIP: 'skip', FAIL: 'FAIL' }[state]}  ${name}`);
const failed = results.filter((r) => r[0] === 'FAIL').length;
const skipped = results.filter((r) => r[0] === 'SKIP').length;
console.log(`\n${results.length - failed - skipped}/${results.length - skipped} 通過${skipped ? `(跳過 ${skipped})` : ''}`);
process.exit(failed ? 1 : 0);
