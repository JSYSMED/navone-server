-- =============================================
-- NavOne — Agent A: 정산 데이터 테이블
-- Supabase SQL Editor 에서 실행. 네이밍 컨벤션: navone_ prefix.
-- =============================================

-- 일별/상품별 정산 내역 (네이버 커머스 정산 API → /api/settlement/sync 가 upsert)
create table if not exists navone_settlements (
  id                 uuid primary key default gen_random_uuid(),
  store_id           uuid references stores(id) on delete cascade,
  settlement_date    date not null,        -- 정산일
  product_order_id   text not null,        -- 상품주문번호 (멱등 키)
  channel_product_no text,                 -- 채널상품번호 (마진 집계 키)
  product_name       text,
  quantity           numeric default 1,
  sales_amount       numeric default 0,    -- 판매가/결제금액
  commission_fee     numeric default 0,    -- 수수료
  ad_fee             numeric default 0,    -- 광고비
  delivery_fee       numeric default 0,    -- 배송비
  return_deduct      numeric default 0,    -- 반품 차감
  settlement_amount  numeric default 0,    -- 정산금 (지급예정금액)
  raw                jsonb,                -- 커머스 API 원본 응답 보존
  created_at         timestamptz default now(),
  updated_at         timestamptz default now(),
  -- 같은 정산일·상품주문 재동기화 시 덮어쓰기 (멱등성)
  unique (store_id, settlement_date, product_order_id)
);

create index if not exists idx_navone_settlements_store   on navone_settlements(store_id);
create index if not exists idx_navone_settlements_date     on navone_settlements(settlement_date desc);
create index if not exists idx_navone_settlements_product  on navone_settlements(channel_product_no);
