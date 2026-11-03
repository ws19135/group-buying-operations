-- 016 SOP 02 選品評分 V2 ＋廠商調查版本／撤回支援
-- 原則：只新增、不改既有欄位語意；V1 舊評估（rubric_version 為 NULL）完全不變。規格見 docs/phase2/SELECTION_V2.md，回滾見 docs/phase2/SELECTION_V2_ROLLBACK.md。

-- 1. 選品評估：V2 欄位
ALTER TABLE product_evaluations
  ADD COLUMN rubric_version int CHECK (rubric_version IS NULL OR rubric_version = 2),            -- NULL＝V1 舊制；2＝V2
  ADD COLUMN commerce_model text CHECK (commerce_model IS NULL OR commerce_model IN ('AGENCY','KOL_CPS','MOM_GROUP')),
  ADD COLUMN v2_input jsonb,                                                                     -- {conditionId: {value, na, naReason, evidenceIds}}
  ADD COLUMN v2_result jsonb,                                                                    -- 送出後保存：維度、子條件結果與自動值快照、硬性檢查
  ADD COLUMN evidence_completeness numeric(4,3);
ALTER TABLE product_evaluations ADD CONSTRAINT product_evaluations_v2_shape CHECK (
  (rubric_version IS NULL AND v2_input IS NULL AND v2_result IS NULL AND commerce_model IS NULL)
  OR (rubric_version = 2 AND v2_input IS NOT NULL));

-- 已送出的評估：V2 欄位也不可修改（與 V1 欄位同等保護）
CREATE OR REPLACE FUNCTION product_evaluations_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'SUBMITTED' AND (
       NEW.scores IS DISTINCT FROM OLD.scores OR NEW.compliance IS DISTINCT FROM OLD.compliance OR NEW.config_version IS DISTINCT FROM OLD.config_version
       OR NEW.config_snapshot IS DISTINCT FROM OLD.config_snapshot OR NEW.total_score IS DISTINCT FROM OLD.total_score
       OR NEW.completeness IS DISTINCT FROM OLD.completeness OR NEW.confidence IS DISTINCT FROM OLD.confidence
       OR NEW.recommendation IS DISTINCT FROM OLD.recommendation OR NEW.evidence_gaps IS DISTINCT FROM OLD.evidence_gaps
       OR NEW.evaluator_id IS DISTINCT FROM OLD.evaluator_id OR NEW.evaluated_on IS DISTINCT FROM OLD.evaluated_on
       OR NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.version_no IS DISTINCT FROM OLD.version_no OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.rubric_version IS DISTINCT FROM OLD.rubric_version OR NEW.commerce_model IS DISTINCT FROM OLD.commerce_model
       OR NEW.v2_input IS DISTINCT FROM OLD.v2_input OR NEW.v2_result IS DISTINCT FROM OLD.v2_result
       OR NEW.evidence_completeness IS DISTINCT FROM OLD.evidence_completeness) THEN
    RAISE EXCEPTION '已送出的選品評估內容不可修改；請建立新版本' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION '已被取代的評估不可再變更取代資訊' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- 2. 主管提出的補件要求（針對評估的個別子條件）；不實體刪除，只改狀態
CREATE TABLE evaluation_supplement_requests (
  id               text PRIMARY KEY,             -- SRQ-000001
  organization_id  text NOT NULL REFERENCES organizations(id),
  evaluation_id    text NOT NULL REFERENCES product_evaluations(id),
  condition_id     text,                          -- 子條件代碼；NULL＝整體補件
  note             text NOT NULL CHECK (length(btrim(note)) > 0),
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DONE','CANCELLED')),
  requested_by     text NOT NULL,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  resolved_by      text,
  resolved_at      timestamptz,
  resolve_note     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          int NOT NULL DEFAULT 1,
  CHECK (status = 'OPEN' OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE INDEX evaluation_supplement_requests_eval_idx ON evaluation_supplement_requests (organization_id, evaluation_id, status);
CREATE TRIGGER evaluation_supplement_requests_touch BEFORE UPDATE ON evaluation_supplement_requests FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER evaluation_supplement_requests_nodelete BEFORE DELETE ON evaluation_supplement_requests FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- 3. 廠商合作資格調查：版本鏈與沿用來源（新增欄位，舊資料為 NULL）
ALTER TABLE vendor_dd_records
  ADD COLUMN supersedes_id text REFERENCES vendor_dd_records(id),   -- 這份調查取代哪一份（核准時設定在被取代的那份）
  ADD COLUMN superseded_at timestamptz,                              -- 被新版核准後取代的時間（狀態仍保留 APPROVED，讀取時判為已取代）
  ADD COLUMN copied_from_id text REFERENCES vendor_dd_records(id);   -- 沿用自哪一份（只複製條款與負責人，不複製證據與確認）
CREATE INDEX vendor_dd_records_copied_idx ON vendor_dd_records (copied_from_id) WHERE copied_from_id IS NOT NULL;
