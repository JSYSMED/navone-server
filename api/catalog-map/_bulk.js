// =============================================
// CommerOne — POST /api/catalog-map/bulk
// 확장이 가격 자동화 사이클에서 캡처한 catalog URL 매핑을 일괄 저장.
//   Body: { licenseKey(필수), items: [{ channelProductNo(필수), catalogId(필수), productName? }, ...] }
//   응답: { success: true, saved: <건수> }
//
// 평소 카탈로그 사이클이 상품 클릭 시 얻는 catalogId를 모아 여기로 보냄 → 다음부터
// 카탈로그 페이지 순회 없이 catalog_id로 바로 상세페이지 파싱 가능(= DB 기반 실행).
//
// 전제 테이블 (Supabase SQL):
//   create table navone_catalog_map (
//     license_key        text        not null,
//     channel_product_no text        not null,
//     catalog_id         text        not null,
//     product_name       text,
//     updated_at         timestamptz not null default now(),
//     primary key (license_key, channel_product_no)
//   );
//   create index on navone_catalog_map (license_key);
// =============================================

import { setCors, handlePreflight, assertEnv, sbUpsert } from "../../lib/supabase.js";

function fail(res, status, code, message, detail) {
  return res.status(status).json({ success: false, error: { code, message, detail } });
}

export default async function handler(req, res) {
  setCors(res);
  if (handlePreflight(req, res, "POST")) return;

  try {
    assertEnv();
    const { licenseKey, items } = req.body || {};
    if (!licenseKey) return fail(res, 400, "MISSING_LICENSE", "licenseKey는 필수입니다.");
    if (!Array.isArray(items) || !items.length) {
      return fail(res, 400, "INVALID_INPUT", "items는 1개 이상의 배열이어야 합니다.");
    }

    const now = new Date().toISOString();
    const rows = [];
    for (const it of items) {
      const channelProductNo = it?.channelProductNo ?? it?.channel_product_no;
      const catalogId = it?.catalogId ?? it?.catalog_id;
      if (channelProductNo == null || channelProductNo === "") continue;
      if (catalogId == null || catalogId === "") continue;
      const row = {
        license_key: licenseKey,
        channel_product_no: String(channelProductNo),
        catalog_id: String(catalogId),
        updated_at: now,
      };
      const name = it?.productName ?? it?.product_name;
      if (name != null) row.product_name = String(name);
      rows.push(row);
    }

    if (!rows.length) {
      return fail(res, 400, "INVALID_INPUT", "유효한 항목이 없습니다 (channelProductNo/catalogId 확인).");
    }

    await sbUpsert("navone_catalog_map", rows, "license_key,channel_product_no");

    return res.status(200).json({ success: true, saved: rows.length });
  } catch (err) {
    console.error("[catalog-map/bulk]", err.status, err.message, err.detail);
    return fail(res, err.status || 500, err.code || "CATALOG_MAP_BULK_FAILED", err.message || "서버 오류", err.detail);
  }
}
