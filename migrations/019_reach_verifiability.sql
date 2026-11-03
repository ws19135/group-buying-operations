-- 019 有效導購訪客的可驗證性（Owner 決策 K-4）
-- 不得僅因填寫者自選「高」或「中」就視為已驗證：高／中可信度需有來源佐證，需說明訪客如何去重，且需第二位有權限的人查核。
-- 規則版本化（rules_version）：每筆記錄保留填寫當時的規則版本；查核時另記查核當下的規則版本。只新增欄位，舊資料相容（視為去重方式未知、未查核）。
ALTER TABLE trial_reach_records
  ADD COLUMN evidence_ref text,                                   -- 來源佐證或可查核的來源識別（報表編號、後台連結、檔名…）
  ADD COLUMN dedupe_method text CHECK (dedupe_method IS NULL OR dedupe_method IN ('PLATFORM_UNIQUE_USERS','SHORT_LINK_UNIQUE_CLIENTS','MANUAL_DEDUP','NOT_DEDUPED','UNKNOWN')),
  ADD COLUMN dedupe_note text,                                    -- 人工去重時說明怎麼去重
  ADD COLUMN rules_version text NOT NULL DEFAULT 'reach-rules/legacy',
  ADD COLUMN verification_status text NOT NULL DEFAULT 'UNVERIFIED' CHECK (verification_status IN ('UNVERIFIED','VERIFIED','REJECTED')),
  ADD COLUMN verified_by text,
  ADD COLUMN verified_at timestamptz,
  ADD COLUMN verify_note text,
  ADD COLUMN verify_rules_version text;

-- 舊的有效導購訪客紀錄：去重方式未知（不是推測）；其餘維持未查核
UPDATE trial_reach_records SET dedupe_method='UNKNOWN' WHERE metric='QUALIFIED_VISITORS' AND dedupe_method IS NULL;

ALTER TABLE trial_reach_records ADD CONSTRAINT trial_reach_dedupe_required CHECK (metric <> 'QUALIFIED_VISITORS' OR dedupe_method IS NOT NULL);
ALTER TABLE trial_reach_records ADD CONSTRAINT trial_reach_verify_shape CHECK (
  (verification_status = 'UNVERIFIED' AND verified_by IS NULL AND verified_at IS NULL)
  OR (verification_status IN ('VERIFIED','REJECTED') AND metric = 'QUALIFIED_VISITORS' AND verified_by IS NOT NULL AND verified_at IS NOT NULL AND verify_note IS NOT NULL AND length(btrim(verify_note)) > 0 AND verify_rules_version IS NOT NULL));

-- 內容不可改；查核欄位只能從「未查核」改成「已查核／退回」一次，且查核者不能是填寫者
CREATE OR REPLACE FUNCTION trial_reach_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.metric IS DISTINCT FROM OLD.metric OR NEW.value IS DISTINCT FROM OLD.value OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
     OR NEW.source_text IS DISTINCT FROM OLD.source_text OR NEW.period_start IS DISTINCT FROM OLD.period_start OR NEW.period_end IS DISTINCT FROM OLD.period_end
     OR NEW.credibility IS DISTINCT FROM OLD.credibility OR NEW.note IS DISTINCT FROM OLD.note OR NEW.filled_on IS DISTINCT FROM OLD.filled_on
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.trial_id IS DISTINCT FROM OLD.trial_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.evidence_ref IS DISTINCT FROM OLD.evidence_ref OR NEW.dedupe_method IS DISTINCT FROM OLD.dedupe_method OR NEW.dedupe_note IS DISTINCT FROM OLD.dedupe_note
     OR NEW.rules_version IS DISTINCT FROM OLD.rules_version THEN
    RAISE EXCEPTION '觸及與導購資料建立後不可修改；請刪除後重新填寫' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION '已刪除的資料不可再變更' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.verification_status IS DISTINCT FROM OLD.verification_status OR NEW.verified_by IS DISTINCT FROM OLD.verified_by OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
     OR NEW.verify_note IS DISTINCT FROM OLD.verify_note OR NEW.verify_rules_version IS DISTINCT FROM OLD.verify_rules_version THEN
    IF OLD.verification_status <> 'UNVERIFIED' THEN
      RAISE EXCEPTION '已查核的資料不可再變更查核結果；請刪除後重新填寫' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.verified_by IS NOT DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION '填寫者不能查核自己填的資料' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
