#!/usr/bin/env node
/* 查免費體驗代理的使用量(讀 D1 的 lcm_quota)。
   跑法:
     node worker/usage.mjs              最近 14 天的每日概況
     node worker/usage.mjs 2026-08-12   那一天的明細,每個 IP 用了多少

   能查到:每天有幾個不同 IP 用過、文字/編劇/生圖各幾次。
   查不到:逐筆時間、誰做了什麼、任何對話內容(代理只記日期+IP+次數,刻意不存內容)。
   注意 IP 不等於人:同一個家或公司出來算一個,手機換基地台可能算成好幾個。
   日界是 UTC(台北早上 8 點換日),所以晚上的活動整場都會落在同一天。 */
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DB = 'k-rider-signups';
const HERE = dirname(fileURLToPath(import.meta.url));

function q(sql) {
  let raw;
  try {
    raw = execFileSync('npx', ['wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql],
      { cwd: HERE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    // wrangler 偶發失敗(Cloudflare API 抽風),重跑一次通常就好;講清楚而不是丟一大坨堆疊
    console.error('查詢失敗。多半是 Cloudflare API 偶發錯誤,重跑一次通常就好。');
    console.error('若持續失敗,先確認 npx wrangler whoami 是登入狀態。');
    process.exit(1);
  }
  return JSON.parse(raw.slice(raw.indexOf('['))) [0].results;
}

const day = process.argv[2];

if (!day) {
  // 每日概況:不同 IP 數 = 只算純 IP 那種鍵(glm:/img:/__..._global__ 都是同一個人的另一個計數桶)
  const rows = q(`
    SELECT day,
      -- 三個桶(文字/編劇/生圖)是同一個人的不同計數列,要先把前綴剝掉再去重。
      -- 只數文字桶會漏掉「只生過圖、沒用過文字」的人,那種人明細看得到、概況卻少一個。
      COUNT(DISTINCT CASE
        WHEN ip LIKE '%global%' THEN NULL
        WHEN ip LIKE 'glm:%' OR ip LIKE 'img:%' THEN substr(ip, 5)
        ELSE ip END) AS ips,
      SUM(CASE WHEN ip = '__global__'      THEN n ELSE 0 END) AS txt,
      SUM(CASE WHEN ip = '__glm_global__'  THEN n ELSE 0 END) AS glm,
      SUM(CASE WHEN ip = '__img_global__'  THEN n ELSE 0 END) AS img
    FROM lcm_quota GROUP BY day ORDER BY day DESC LIMIT 14`);
  if (!rows.length) {
    console.log('還沒有任何使用紀錄。');
  } else {
    console.log('日期(UTC,台北早上 8 點換日)   不同 IP   文字   編劇   生圖');
    for (const r of rows) {
      console.log(`  ${r.day}              ${String(r.ips).padStart(5)}   ${String(r.txt).padStart(4)}   ${String(r.glm).padStart(4)}   ${String(r.img).padStart(4)}`);
    }
    console.log('\n看某一天的明細:node worker/usage.mjs 2026-08-12');
    console.log('IP 不等於人:同一個家或公司出來算一個,手機換基地台可能算成好幾個。');
  }
} else {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { console.error('日期格式要像 2026-08-12'); process.exit(1); }
  const rows = q(`SELECT ip, n FROM lcm_quota WHERE day = '${day}'`);
  if (!rows.length) { console.log(`${day} 沒有任何使用紀錄。`); process.exit(0); }
  const g = { __global__: 0, __glm_global__: 0, __img_global__: 0 };
  const per = new Map(); // IP → {txt, glm, img}
  const slot = (ip) => per.get(ip) || per.set(ip, { txt: 0, glm: 0, img: 0 }).get(ip);
  for (const { ip, n } of rows) {
    if (ip in g) { g[ip] = n; continue; }
    if (ip.startsWith('glm:')) slot(ip.slice(4)).glm = n;
    else if (ip.startsWith('img:')) slot(ip.slice(4)).img = n;
    else slot(ip).txt = n;
  }
  console.log(`${day}　全站:文字 ${g.__global__}　編劇 ${g.__glm_global__}　生圖 ${g.__img_global__}`);
  console.log(`不同 IP ${per.size} 個\n`);
  const list = [...per.entries()].sort((a, b) => (b[1].txt + b[1].glm) - (a[1].txt + a[1].glm));
  console.log('  IP                  文字   編劇   生圖');
  for (const [ip, v] of list) {
    console.log(`  ${ip.padEnd(18)} ${String(v.txt).padStart(4)}   ${String(v.glm).padStart(4)}   ${String(v.img).padStart(4)}`);
  }
  // 一個作品約 20 次文字呼叫;拿來粗估「真的做完東西的人」比單看 IP 數有意義
  const active = list.filter(([, v]) => v.txt >= 20).length;
  console.log(`\n其中文字呼叫 20 次以上(約等於做完一個完整作品)的有 ${active} 個 IP。`);
  console.log('這是粗估:IP 不等於人,也看不出誰在幾點做了什麼(代理只記日期+IP+次數)。');
}
