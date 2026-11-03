-- 017 試用：團主再次合作意願（人工記錄，供小規模測試團 KPI 使用）
-- 只新增欄位；舊資料為 NULL（＝尚未記錄，KPI 顯示「資料不足」）。結論後仍可記錄（與寄送／回收等物流欄位相同，不受結論鎖定）。
ALTER TABLE product_trials
  ADD COLUMN host_intent text CHECK (host_intent IS NULL OR host_intent IN ('WILLING','UNDECIDED','UNWILLING')),
  ADD COLUMN host_intent_note text;
ALTER TABLE product_trials ADD CONSTRAINT product_trials_host_intent_host CHECK (host_intent IS NULL OR host_id IS NOT NULL);   -- 意願是針對某位團主
