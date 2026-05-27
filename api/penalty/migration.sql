-- =============================================
-- NavOne — Agent D 클린페널티 알림봇 마이그레이션
-- Supabase SQL Editor에서 실행.
-- 네이밍 컨벤션: navone_ prefix (AGENTS.md §1)
-- =============================================

create table if not exists navone_penalty_alerts (
  id                  uuid primary key default gen_random_uuid(),
  store_id            uuid references stores(id) on delete cascade,
  scanned_at          timestamptz default now(),

  total_products      int,            -- 스캔 시점 판매중 상품 수
  registration_limit  int,            -- 적용 등록 한도 (저거래 셀러 = 1000)
  limit_usage_percent numeric,        -- 한도 사용률 (%)

  no_sale_danger_count  int default 0, -- 13개월+ 무거래 (위험)
  no_sale_warning_count int default 0, -- 10개월+ 무거래 (주의)

  result              jsonb default '{}'::jsonb, -- 상세(위험/주의 상품 목록 등)
  notified            boolean default false,     -- Telegram 발송 성공 여부
  created_at          timestamptz default now()
);

create index if not exists idx_penalty_alerts_store_scanned
  on navone_penalty_alerts (store_id, scanned_at desc);
