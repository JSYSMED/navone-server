-- =============================================
-- NavOne — 상품 원가 입력 테이블
-- 마진율(settlement/margin-rank)을 진짜 입력 원가 기반으로 계산하기 위한 인프라.
-- 키: (license_key, channel_product_no) — channelProductNo 기준 통일.
-- =============================================

create table if not exists navone_product_cost (
  license_key         text        not null,
  channel_product_no  text        not null,
  product_name        text,
  cost                integer     not null default 0,   -- 원 단위
  updated_at          timestamptz not null default now(),
  primary key (license_key, channel_product_no)
);

create index if not exists navone_product_cost_license_idx
  on navone_product_cost (license_key);
