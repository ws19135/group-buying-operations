-- 024 費用歸屬範圍標記（Owner 決策 D-6）：可直接歸屬商品的費用優先記錄明確歸屬；共同費用另行標記。
-- 只新增一個選填欄位（舊資料不變、不回填）：NULL＝尚未標記。標記必須與「對應商品／對應團主」一致（資料庫也檢查）。
-- 本欄位只用於分類與唯讀分析；不啟用任何正式的共同費用分攤方法，也不影響結算、KPI 或財務總覽。
ALTER TABLE expenses ADD COLUMN cost_scope text CHECK (cost_scope IS NULL OR cost_scope IN ('DIRECT_PRODUCT','HOST_SPECIFIC','SHARED'));   -- 直接歸屬商品／特定團主／檔期共同費用
ALTER TABLE expenses ADD CONSTRAINT expenses_cost_scope_shape CHECK (
  cost_scope IS NULL
  OR (cost_scope = 'DIRECT_PRODUCT' AND product_id IS NOT NULL)
  OR (cost_scope = 'HOST_SPECIFIC' AND host_id IS NOT NULL AND product_id IS NULL)
  OR (cost_scope = 'SHARED' AND host_id IS NULL AND product_id IS NULL));
