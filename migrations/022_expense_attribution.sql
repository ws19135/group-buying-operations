-- 022 費用歸屬欄位（Owner 決策 K-8a「補齊欄位」階段）：最小必要擴充既有 expenses，只新增選填欄位，舊資料不變。
-- 必須區分「費用承擔方」（誰最終負擔這筆費用）與「實際付款方」（誰實際付了錢），兩者不一定相同。
-- 應收／應付只是「財務的確認紀錄」：未確認的應收應付不是付款指示；即使已確認，系統也不產生付款、撥款、扣款或發票——這些仍需另案核准。
-- 本階段不授權：自動產生正式應付款、自動撥款、自動扣款、修改發票、修改佣金結算公式、回填正式歷史交易。
ALTER TABLE expenses
  ADD COLUMN bearer_party text CHECK (bearer_party IS NULL OR bearer_party IN ('BRAND','COMPANY','HOST')),                  -- 費用承擔方
  ADD COLUMN payer_party text CHECK (payer_party IS NULL OR payer_party IN ('BRAND','COMPANY','HOST','OTHER')),              -- 實際付款方
  ADD COLUMN claim_direction text NOT NULL DEFAULT 'UNDETERMINED' CHECK (claim_direction IN ('RECEIVABLE','PAYABLE','NONE','UNDETERMINED')),
  ADD COLUMN claim_party text CHECK (claim_party IS NULL OR claim_party IN ('BRAND','COMPANY','HOST','OTHER')),            -- 應收方（向誰收）／應付方（付給誰）
  ADD COLUMN claim_status text NOT NULL DEFAULT 'UNCONFIRMED' CHECK (claim_status IN ('UNCONFIRMED','CONFIRMED')),
  ADD COLUMN claim_confirmed_by text,
  ADD COLUMN claim_confirmed_at timestamptz,
  ADD COLUMN claim_note text,
  ADD COLUMN host_id text REFERENCES hosts(id),                                                                            -- 對應團主（選填）
  ADD COLUMN product_id text REFERENCES products(id),                                                                      -- 對應商品（選填）；檔期沿用 campaign_id（合作案）
  ADD COLUMN terms_source_kind text CHECK (terms_source_kind IS NULL OR terms_source_kind IN ('CONTRACT','FORMAL_TERMS','FEASIBILITY','MANUAL_ESTIMATE')),
  ADD COLUMN terms_ref text,                                                                                               -- 合約版本、可行性版本或商務條件編號
  ADD COLUMN payment_status text NOT NULL DEFAULT 'UNRECORDED' CHECK (payment_status IN ('UNRECORDED','UNPAID','PARTIALLY_PAID','PAID','NOT_APPLICABLE')),
  ADD COLUMN paid_on date,
  ADD COLUMN paid_amount bigint CHECK (paid_amount IS NULL OR paid_amount >= 0),
  ADD COLUMN evidence_url text;                                                                                            -- 付款憑證或證據連結（http／https，不含帳密）
ALTER TABLE expenses ADD CONSTRAINT expenses_claim_shape CHECK (
  (claim_status = 'UNCONFIRMED' AND claim_confirmed_by IS NULL AND claim_confirmed_at IS NULL)
  OR (claim_status = 'CONFIRMED' AND claim_direction IN ('RECEIVABLE','PAYABLE') AND claim_party IS NOT NULL AND claim_confirmed_by IS NOT NULL AND claim_confirmed_at IS NOT NULL));
ALTER TABLE expenses ADD CONSTRAINT expenses_claim_party_chk CHECK (claim_direction IN ('UNDETERMINED','NONE') OR claim_party IS NOT NULL);
ALTER TABLE expenses ADD CONSTRAINT expenses_payment_shape CHECK (
  (payment_status IN ('UNRECORDED','UNPAID','NOT_APPLICABLE') AND paid_on IS NULL AND paid_amount IS NULL)
  OR (payment_status = 'PAID' AND paid_on IS NOT NULL)
  OR (payment_status = 'PARTIALLY_PAID' AND paid_on IS NOT NULL AND paid_amount IS NOT NULL AND paid_amount > 0 AND paid_amount < amount));
CREATE INDEX expenses_attr_idx ON expenses (organization_id, campaign_id, category) WHERE status = 'RECORDED';
