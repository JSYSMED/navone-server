-- =============================================
-- NavOne — Agent B: 클레임 자동처리 테이블
-- Supabase SQL Editor 에서 실행. 네이밍 컨벤션: navone_ prefix.
-- =============================================

-- 1) 클레임 처리 로그 (감사 추적용 — 자동/수동 모든 결정 기록)
create table if not exists navone_claims (
  id               uuid primary key default gen_random_uuid(),
  store_id         uuid references stores(id) on delete cascade,
  product_order_id text not null,
  claim_type       text,          -- RETURN | CANCEL | EXCHANGE
  claim_status     text,          -- 네이버 클레임 상태
  product_name     text,
  claim_reason     text,          -- 구매자 작성 사유 원문
  amount           numeric default 0,
  category         text,          -- simple_return | defect | delivery | other
  ai_confidence    numeric,       -- 0.0 ~ 1.0
  ai_reason        text,          -- AI 분류 근거(셀러 참고용)
  decision         text,          -- approve | hold | approved | rejected | approve_failed | reject_failed
  decided_by       text,          -- ai | seller
  action_result    jsonb,         -- 커머스 API 응답 또는 오류 상세
  notified         boolean default false,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  unique (store_id, product_order_id)
);

create index if not exists idx_navone_claims_store      on navone_claims(store_id);
create index if not exists idx_navone_claims_decision   on navone_claims(decision);
create index if not exists idx_navone_claims_created     on navone_claims(created_at desc);

-- 2) 셀러별 자동승인 룰 (스토어당 1행)
create table if not exists navone_claim_rules (
  id                          uuid primary key default gen_random_uuid(),
  store_id                    uuid references stores(id) on delete cascade unique,
  enabled                     boolean default true,    -- 자동처리 마스터 ON/OFF
  auto_approve_simple_return  boolean default true,    -- 단순변심 자동승인
  simple_return_max_amount    numeric default 50000,   -- 단순변심 자동승인 금액 상한(원)
  auto_approve_defect         boolean default true,    -- 상품하자 자동승인
  notify_on_defect            boolean default true,    -- 상품하자 승인 시 Telegram 알림
  notify_on_hold              boolean default true,    -- 보류 시 Telegram 알림
  confidence_threshold        numeric default 0.8,     -- 이 미만이면 무조건 보류
  created_at                  timestamptz default now(),
  updated_at                  timestamptz default now()
);

create index if not exists idx_navone_claim_rules_store on navone_claim_rules(store_id);
