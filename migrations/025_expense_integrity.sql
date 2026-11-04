-- 025 費用資料完整性（合併前最終審查 F-02、F-03）。只新增約束與保護，不改任何既有資料。
-- F-02：已確認的應收／應付，只要金額、檔期、承擔方、實際付款方、對應團主／商品、應收應付方向或對象被改動，就必須退回「未確認」重新確認
--       （服務層已處理；這裡在資料庫層也擋，避免繞過服務層直接改資料時確認狀態失真）。付款狀態、備註、憑證連結、條款來源的變更不影響確認。
CREATE OR REPLACE FUNCTION expenses_claim_reconfirm_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.claim_status = 'CONFIRMED' AND NEW.claim_status = 'CONFIRMED' AND (
       NEW.amount IS DISTINCT FROM OLD.amount OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
    OR NEW.bearer_party IS DISTINCT FROM OLD.bearer_party OR NEW.payer_party IS DISTINCT FROM OLD.payer_party
    OR NEW.host_id IS DISTINCT FROM OLD.host_id OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.claim_direction IS DISTINCT FROM OLD.claim_direction OR NEW.claim_party IS DISTINCT FROM OLD.claim_party) THEN
    NEW.claim_status := 'UNCONFIRMED'; NEW.claim_confirmed_by := NULL; NEW.claim_confirmed_at := NULL;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER expenses_claim_reconfirm BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION expenses_claim_reconfirm_guard();

-- F-03：已付款（已登錄的費用）時，已付金額必須等於費用金額或留空；只付一部分請用「部分付款」（部分付款的既有約束：大於 0 且小於費用金額）。
-- 作廢的紀錄不受限（確保舊資料即使不符也能作廢）。先以 NOT VALID 加入（只約束新增與更新的資料，不因既有資料而升級失敗），再嘗試驗證既有資料；
-- 既有資料若有不符會保留 NOT VALID 並發出通知，由財務更正，不批次改寫歷史紀錄。
ALTER TABLE expenses ADD CONSTRAINT expenses_paid_amount_full CHECK (status <> 'RECORDED' OR payment_status <> 'PAID' OR paid_amount IS NULL OR paid_amount = amount) NOT VALID;
DO $$
BEGIN
  ALTER TABLE expenses VALIDATE CONSTRAINT expenses_paid_amount_full;
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE '既有費用資料有「已付款但已付金額不等於費用金額」的紀錄；約束維持 NOT VALID（只約束新增與更新），請財務更正，不批次改寫歷史紀錄';
END $$;
