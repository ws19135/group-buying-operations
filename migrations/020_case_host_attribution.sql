-- 020 客訴（客服案件）的團主歸屬（Owner 決策 K-5）
-- 原則：優先由既有訂單歸因（attributions）推導團主，推導在讀取時計算，不改寫舊資料；只有「無法由訂單歸因取得團主」的案件，才允許人工指定團主，並記錄來源、說明、操作者與時間。
-- 不強制每件客訴都指定團主；無法辨識就保持「未歸屬」，不任意分配。舊案件不變（欄位皆為 NULL＝未人工歸屬）。
ALTER TABLE service_cases
  ADD COLUMN attributed_host_id text REFERENCES hosts(id),
  ADD COLUMN host_attribution_source text CHECK (host_attribution_source IS NULL OR host_attribution_source = 'MANUAL'),
  ADD COLUMN host_attribution_note text,
  ADD COLUMN host_attributed_by text,
  ADD COLUMN host_attributed_at timestamptz;
ALTER TABLE service_cases ADD CONSTRAINT service_cases_host_attr_shape CHECK (
  (attributed_host_id IS NULL AND host_attribution_source IS NULL)
  OR (attributed_host_id IS NOT NULL AND host_attribution_source = 'MANUAL' AND host_attribution_note IS NOT NULL AND length(btrim(host_attribution_note)) > 0 AND host_attributed_by IS NOT NULL AND host_attributed_at IS NOT NULL));
CREATE INDEX service_cases_attr_host_idx ON service_cases (organization_id, attributed_host_id) WHERE attributed_host_id IS NOT NULL;
