-- 홍스랩 관리자: 콘텐츠 덮어쓰기 + 방문 기록
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,            -- unix 초
  day TEXT NOT NULL,              -- 한국시간 YYYY-MM-DD
  hour INTEGER NOT NULL,          -- 한국시간 0~23
  type TEXT NOT NULL,             -- view | event
  name TEXT,                      -- event 이름 (tel, kakao, mail, inquiry_open, inquiry_send, seo_check ...)
  path TEXT NOT NULL,
  ref_host TEXT,
  ref_url TEXT,
  source TEXT NOT NULL,           -- 분류된 유입경로 (네이버 검색, 구글, 직접 유입 ...)
  medium TEXT,
  campaign TEXT,
  device TEXT,
  browser TEXT,
  os TEXT,
  country TEXT,
  city TEXT,
  vid TEXT NOT NULL,              -- 일별 방문자 해시 (IP+UA, 개인정보 저장 안 함)
  screen TEXT,
  lang TEXT
);
CREATE INDEX IF NOT EXISTS idx_hits_day ON hits(day, type);
CREATE INDEX IF NOT EXISTS idx_hits_ts ON hits(ts);
