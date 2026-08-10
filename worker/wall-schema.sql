-- 共享區:只存「哪些短碼要公開展示」的索引。作品本體在 shorturl 的 shorturls 表,不重複存一份。
CREATE TABLE IF NOT EXISTS chat_wall_submissions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  code TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL,
  msg_count INTEGER NOT NULL DEFAULT 0,
  consent INTEGER NOT NULL DEFAULT 1 CHECK (consent = 1),
  owner_token_hash TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_chat_wall_event_created
  ON chat_wall_submissions(event_id, created_at DESC);

-- 同一場同一份作品只上一次(短碼=內容雜湊,所以同內容重投會被擋)
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_wall_event_code
  ON chat_wall_submissions(event_id, code);
