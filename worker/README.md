# lcm-ai-proxy — 免費體驗代理（「刷亞澤的信用卡」）

讓 line-chat-maker 的訪客不用申請 API Key 就能體驗 AI 功能：前端打這個 Cloudflare Worker，Worker 拿站長的 Groq Key 轉發。**Key 只存在 Cloudflare secret，絕不出現在前端。**

## 防濫用五道閘

1. **Origin 白名單**（`ALLOWED_ORIGINS`）：只服務指定網域，其他一律 403
2. **model 鎖定＋欄位白名單**（`MODEL`／`WRITER_MODELS`）：只轉發 `messages/tools/tool_choice`，不當萬用 LLM 代理。前端送來的 model 若在 `WRITER_MODELS` 白名單上，轉給 `LLMSHARE_BASE`（朋友的閘道）；**不在名單上的一律改寫成 `MODEL` 走 Groq**，不會照你填的跑
3. **每 IP 每日額度**（`IP_DAILY`，目前 150 次呼叫；一個作品約 20 次）：超過回 429，訊息引導使用者填自己的免費 Key
4. **全站每日熔斷**（`GLOBAL_DAILY`，目前 5000 次）：這道才是成本天花板，約每日 US$5 封頂；每 IP 那道只決定「單一個人能用多少」，調高它不會提高總花費
5. **max_tokens 上限**：單次輸出封頂 4096

額度計數存 D1（`lcm_quota` 表，首次請求自動建表），UTC 日界（台北時間早上 8 點重置）。只記「日期＋IP＋次數」，**不儲存任何對話內容**。計數在通過檢查、確定要送去上游時才加；被 429 擋下來的請求不計。

## 兩條上游

| 送出的 model | 去哪 | 吃哪一格額度 |
|---|---|---|
| 在 `WRITER_MODELS` 名單上（目前是對方閘道的全部模型，以 `llmshare models` 為準） | `LLMSHARE_BASE`，用 `LLMSHARE_API_KEY` | 那格（`GLM_IP_DAILY`／`GLM_GLOBAL_DAILY`）**和**文字，兩格都扣 |
| 其他任何值 | Groq，model 被改寫成 `MODEL` | 只扣文字 |

走 llm-share 用的是 **Chat Completions**（`/v1/chat/completions`），不是 Responses API。思考型模型的思考文字會落在 `message.reasoning_content`，前端只讀 `message.content`，所以那段讀完就丟。

因此對思考型模型要送 `reasoning_effort: "none"`，否則白花 token（GLM 更嚴重，會把預算全花在思考、`content` 回空白）。

**這個參數必須逐一列出，不能用前綴猜**（`REASONING_OFF_MODELS`）。2026-08-11 逐一實測，接受的只有 `glm-5.2`、`deepseek-v4-flash:0731`、`deepseek-v4-pro`、`deepseek-v4-flash:preview`；其餘一律回 `litellm.UnsupportedParamsError` 400。**同系列不代表行為一致**：`glm-5.2` 吃、`glm-5.1` 不吃，一度寫成 `/^glm-/` 就把 `glm-5.1` 打死了。對方上下架或改版時要重測。

名單走 llm-share 的那條是**別人的 key**，量的閘是 `GLM_IP_DAILY`（目前 200／IP）與 `GLM_GLOBAL_DAILY`（2000／日）。

**延遲要知道**：2026-08-11 走本代理實測（暖機後取三次中位數），Groq 的 `openai/gpt-oss-120b` 約 1.4 秒，而對方閘道上每一個模型都落在 2.5 到 4.7 秒之間，最快的 `glm-5.1` 也要 2.5 秒。執行 AI 一個作品約 20 次呼叫，換算下來是 28 秒對 50 到 90 秒。所以**執行維持走 Groq**，對方那條給編劇這種呼叫次數少的用。

## 查使用量

```bash
node worker/usage.mjs              # 最近 14 天概況：每天幾個不同 IP、文字／編劇／生圖各幾次
node worker/usage.mjs 2026-08-12   # 那一天的明細，每個 IP 用了多少
```

**能查到**：每天有幾個不同 IP、各項呼叫次數。**查不到**：逐筆時間、誰做了什麼、任何對話內容（只記日期＋IP＋次數，刻意不存內容）。**IP 不等於人**：同一個家或公司出來算一個，手機換基地台可能算成好幾個，只能當粗估。

## 部署（站長）

```bash
cd worker
npx wrangler secret put GROQ_API_KEY   # 貼上你的 Groq API Key
npx wrangler deploy
```

部署後網址即 `https://lcm-ai-proxy.<你的子網域>.workers.dev`，前端連線設定的「刷亞澤的信用卡」preset 指向它。

之後改 `worker/` 內容 push 到 master 會由 GitHub Actions 自動部署（需在 repo secrets 設 `CLOUDFLARE_API_TOKEN`，權限含 Workers 編輯；沒設 secret 就手動 `npx wrangler deploy`）。

## 自架（clone / fork 的人）

整個 repo 是 MIT，歡迎自架自己的免費代理：

```bash
cd worker
npx wrangler login
npx wrangler d1 create my-lcm-quota          # 建自己的 D1 庫
# 把輸出的 database_id 與名稱填進 wrangler.toml 的 [[d1_databases]]
# 把 ALLOWED_ORIGINS 改成你的網站網域
npx wrangler secret put GROQ_API_KEY          # 你自己的 Groq Key（groq.com 免費申請）
npx wrangler deploy
```

然後把前端 `ai.js` 裡 `PROVIDERS.free.base` 改成你的 worker 網址即可。額度、model、成本天花板都在 `wrangler.toml` 的 `[vars]` 自己調。

## 成本粗估

gpt-oss-120b 在 Groq 約 US$0.15/M input、US$0.75/M output（以主控台為準）。一個完整作品（劇本強化＋開始製作＋兩次微調）約 70k input＋14k output ≈ **US$0.02／作品**。預設熔斷下最壞情況每月約 US$36，一般流量多在 US$5-30 之間。

## 後續強化（還沒做）

- Turnstile 人機驗證換短效 token（擋偽造 Origin 的純腳本刷量）；Invisible mode 有螢幕外 render 的坑，見站長筆記
- 依 usage tokens 計費而非次數
