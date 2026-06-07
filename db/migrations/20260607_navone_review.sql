-- =============================================
-- NavOne — 리뷰 수집 테이블
-- 네이버 커머스 API에 리뷰 조회가 없어, 확장(content_review.js)이 DOM에서 긁은
-- 미답글 리뷰를 저장하고 대시보드가 읽어 표시한다.
-- 키: (license_key, review_id) — review_id 기준 디듀프(재수집해도 중복 안 쌓임).
-- =============================================

create table if not exists navone_review (
  license_key        text        not null,
  review_id          text        not null,
  channel_product_no text,
  product_name       text,
  rating             integer,
  content            text,
  review_date        text,
  reply_status       text        not null default 'pending',  -- pending | replied
  reply_text         text,
  replied_at         timestamptz,
  updated_at         timestamptz not null default now(),
  primary key (license_key, review_id)
);

create index if not exists navone_review_status_idx
  on navone_review (license_key, reply_status);
