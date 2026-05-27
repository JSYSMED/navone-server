-- =============================================
-- NavOne — Agent C: 발주확인/송장등록 주문 테이블
-- Supabase SQL Editor 에서 실행. 네이밍 컨벤션: navone_ prefix.
-- =============================================

-- 주문 추적 (발주확인 + 송장등록 상태)
create table if not exists navone_orders (
  id                     uuid primary key default gen_random_uuid(),
  store_id               uuid references stores(id) on delete cascade,
  product_order_id       text not null,           -- 커머스 productOrderId (송장/확인 단위)
  order_id               text,                    -- 주문번호 (묶음)
  product_name           text,
  order_status           text,                    -- PAY_WAITING | PAYED | DELIVERING | DELIVERED ...
  claim_status           text,
  confirmed              boolean default false,    -- 발주확인 완료 여부
  dispatched             boolean default false,    -- 송장등록 완료 여부
  delivery_company_code  text,                     -- CJGLS, HANJIN, EPOST ...
  tracking_number        text,
  buyer_name             text,
  quantity               int,
  total_amount           numeric,
  ordered_at             timestamptz,
  raw                    jsonb default '{}'::jsonb, -- 커머스 원응답 (감사/디버깅)
  created_at             timestamptz default now(),
  updated_at             timestamptz default now(),
  unique (store_id, product_order_id)
);

create index if not exists idx_navone_orders_store      on navone_orders(store_id);
create index if not exists idx_navone_orders_status      on navone_orders(store_id, order_status);
-- 미발주(발주확인 대기) 부분 인덱스 — pending 조회 가속
create index if not exists idx_navone_orders_unconfirmed on navone_orders(store_id) where confirmed = false;
-- 발주확인 완료 + 송장 미등록(송장 입력 대기) 부분 인덱스
create index if not exists idx_navone_orders_undispatched on navone_orders(store_id) where confirmed = true and dispatched = false;
create index if not exists idx_navone_orders_created       on navone_orders(created_at desc);

-- 자동 발주확인 토글은 stores.config(jsonb)에 보관:
--   config -> 'autoConfirmOrders' (boolean). 별도 테이블 불필요.
