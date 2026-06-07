# NavOne 리뷰 수집 — 확장→DB→대시보드 명세

네이버 커머스 API에 리뷰 조회가 없음. 확장(content_review.js)이 DOM에서 미답글 리뷰를 긁고 있으니,
그 리뷰를 Supabase에 저장하고 대시보드가 읽어서 표시한다.

현재 확장 흐름(navone-extension/background.js):
  scanReviews(tabId) → content_review.js 주입 → 리뷰 배열 반환
  → generateReviewReply(AI 답글) → submitReply(DOM 등록)
긁는 리뷰 필드(content_review.js): { reviewId, channelProductNo, productName, rating, content, date }

================================================================
## 1. 서버 (navone-server)

### Supabase 테이블: navone_review
```sql
create table navone_review (
  license_key        text not null,
  review_id          text not null,
  channel_product_no text,
  product_name       text,
  rating             integer,
  content            text,
  review_date        text,
  reply_status       text not null default 'pending',  -- pending | replied
  reply_text         text,
  replied_at         timestamptz,
  updated_at         timestamptz not null default now(),
  primary key (license_key, review_id)
);
create index on navone_review (license_key, reply_status);
```

### POST /api/review/sync  (확장이 호출)
- body: { licenseKey, reviews: [{ reviewId, channelProductNo, productName, rating, content, date }] }
- upsert(on_conflict=license_key,review_id):
  - 신규 → reply_status='pending'으로 insert
  - 기존 → 내용/별점만 갱신(reply_status는 건드리지 않음 — 이미 replied면 유지)
- 응답: { success:true, synced:<건수>, newCount:<신규>, }

### PATCH /api/review/replied  (확장이 답글 등록 성공 시 호출)
- body: { licenseKey, reviewId, replyText }
- 해당 행 reply_status='replied', reply_text, replied_at=now() 업데이트
- 응답: { success:true }

### GET /api/review/list  (대시보드가 호출)
- query: licenseKey, status(선택: pending|replied|all, 기본 pending), limit(기본 50)
- navone_review에서 license_key+status 필터, review_date DESC
- 응답: { success:true, count, reviews:[{ reviewId, productName, rating, content, reviewDate, replyStatus, replyText }] }

### server.mjs 라우트 등록(필수)
  /api/review/sync     → api/review/_sync.js
  /api/review/replied  → api/review/_replied.js
  /api/review/list     → api/review/_list.js
기존 setCors/handlePreflight/sbUpsert/sbSelect 패턴 재사용. PATCH는 Allow-Methods에 추가.

================================================================
## 2. 확장 (navone-extension/background.js)

### (a) 리뷰 긁은 직후 DB 저장
scanReviews()가 reviews 배열 반환하는 지점(현재 "💬 리뷰 N개 수집" 로그 부근)에서:
  - sendAutomationRequest 패턴으로 POST {API_BASE}/api/review/sync
    body: { licenseKey: <저장된 라이선스>, reviews: res.reviews }
  - try/catch로 감싸 실패해도 확장 동작 막지 않기(기존 패턴 동일)

### (b) 답글 등록 성공 시 상태 갱신
submitReply()가 success 반환하는 지점에서:
  - PATCH {API_BASE}/api/review/replied
    body: { licenseKey, reviewId: review.reviewId, replyText }
  - 이것도 try/catch

라이선스 키는 background.js가 이미 chrome.storage에서 읽어 쓰는 값 재사용.

================================================================
## 3. 대시보드 (navone-dashboard) — 이미 프론트 반영됨
- src/lib/api.js: fetchReviews를 review/list 호출로 (status=pending)
- Customer.jsx 리뷰 탭: history 대신 review/list 사용 (빈 상태 처리 기존 유지)
- ※ 이 부분은 대시보드 zip에 미리 반영해둠. 서버+확장만 구현하면 바로 연결됨.

================================================================
## 4. verify-review.mjs
- NAVONE-TEST-001로 sync(샘플 2건 upsert) → list(pending) 확인 → replied(1건) → list(replied) 확인
- IP 무관(Supabase만 사용)하므로 로컬에서도 green 가능 (cost-bulk와 동일)

## 5. 주의
- reviewId가 디듀프 키 — 같은 리뷰 재수집해도 중복 안 쌓임
- 답글 단 리뷰는 reply_status='replied'로 대시보드 "미답글" 목록에서 자동 제외
- 확장이 한 번도 안 돌면 DB가 비어 대시보드도 빈 상태(정상) — 확장 스캔이 선행돼야 함
