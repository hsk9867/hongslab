-- 무료 SEO 체커 점검 기록 (관리자 대시보드 "SEO 점검 기록")
CREATE TABLE IF NOT EXISTS seo_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,            -- unix 초
  day TEXT NOT NULL,              -- 한국시간 YYYY-MM-DD
  url TEXT NOT NULL,              -- 점검한 주소 (정규화된 전체 URL)
  host TEXT NOT NULL,             -- 호스트명 (www. 제거)
  total INTEGER,                  -- 종합 점수 (실패 시 NULL)
  naver INTEGER,
  google INTEGER,
  aeo INTEGER,
  geo INTEGER,
  status TEXT NOT NULL,           -- ok | cached | error
  err TEXT,                       -- 실패 사유
  device TEXT,
  browser TEXT,
  country TEXT,
  city TEXT,
  vid TEXT NOT NULL               -- 방문자 익명 ID (hits 와 같은 기준)
);
CREATE INDEX IF NOT EXISTS idx_seo_day ON seo_checks(day);
CREATE INDEX IF NOT EXISTS idx_seo_host ON seo_checks(host, ts);
