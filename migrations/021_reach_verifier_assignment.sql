-- 021 有效導購訪客：指派查核者與補件鏈（Owner 決策 K-4a）
-- 原則不變：填寫者與查核者不得為同一人；不建立任何「自行核准」的例外捷徑；人力不足時保持「待查核」，CVR 維持資料不足。
-- 新增：有 product.review 權限的主管可以「指派」另一位具適當權限的人員查核；一旦指派，只有被指派者可以查核（資料庫與服務層都擋）；
--       被退回的資料可以「補件」（重新填寫一筆新紀錄並指回被退回的那筆），形成完整的 填寫→指派→查核／退回→補件 紀錄鏈。
ALTER TABLE trial_reach_records
  ADD COLUMN assigned_verifier_id text REFERENCES users(id),
  ADD COLUMN assigned_by text,
  ADD COLUMN assigned_at timestamptz,
  ADD COLUMN assignment_note text,
  ADD COLUMN resubmits_id text REFERENCES trial_reach_records(id);
ALTER TABLE trial_reach_records ADD CONSTRAINT trial_reach_assign_shape CHECK (
  (assigned_verifier_id IS NULL AND assigned_by IS NULL AND assigned_at IS NULL)
  OR (assigned_verifier_id IS NOT NULL AND assigned_by IS NOT NULL AND assigned_at IS NOT NULL AND assigned_verifier_id <> created_by));
-- 一筆被退回的紀錄只能被補件一次（有效紀錄中）
CREATE UNIQUE INDEX trial_reach_resubmit_uq ON trial_reach_records (resubmits_id) WHERE resubmits_id IS NOT NULL AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION trial_reach_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.metric IS DISTINCT FROM OLD.metric OR NEW.value IS DISTINCT FROM OLD.value OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
     OR NEW.source_text IS DISTINCT FROM OLD.source_text OR NEW.period_start IS DISTINCT FROM OLD.period_start OR NEW.period_end IS DISTINCT FROM OLD.period_end
     OR NEW.credibility IS DISTINCT FROM OLD.credibility OR NEW.note IS DISTINCT FROM OLD.note OR NEW.filled_on IS DISTINCT FROM OLD.filled_on
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.trial_id IS DISTINCT FROM OLD.trial_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.evidence_ref IS DISTINCT FROM OLD.evidence_ref OR NEW.dedupe_method IS DISTINCT FROM OLD.dedupe_method OR NEW.dedupe_note IS DISTINCT FROM OLD.dedupe_note
     OR NEW.rules_version IS DISTINCT FROM OLD.rules_version OR NEW.resubmits_id IS DISTINCT FROM OLD.resubmits_id THEN
    RAISE EXCEPTION '觸及與導購資料建立後不可修改；請刪除後重新填寫' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION '已刪除的資料不可再變更' USING ERRCODE = 'restrict_violation';
  END IF;
  -- 指派只能在「未查核」時變更
  IF (NEW.assigned_verifier_id IS DISTINCT FROM OLD.assigned_verifier_id OR NEW.assigned_by IS DISTINCT FROM OLD.assigned_by OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at OR NEW.assignment_note IS DISTINCT FROM OLD.assignment_note)
     AND OLD.verification_status <> 'UNVERIFIED' THEN
    RAISE EXCEPTION '已查核的資料不可再變更指派' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.verification_status IS DISTINCT FROM OLD.verification_status OR NEW.verified_by IS DISTINCT FROM OLD.verified_by OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
     OR NEW.verify_note IS DISTINCT FROM OLD.verify_note OR NEW.verify_rules_version IS DISTINCT FROM OLD.verify_rules_version THEN
    IF OLD.verification_status <> 'UNVERIFIED' THEN
      RAISE EXCEPTION '已查核的資料不可再變更查核結果；請刪除後重新填寫' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.verified_by IS NOT DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION '填寫者不能查核自己填的資料' USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.assigned_verifier_id IS NOT NULL AND NEW.verified_by IS DISTINCT FROM OLD.assigned_verifier_id THEN
      RAISE EXCEPTION '這筆資料已指派給另一位查核者，只有被指派者可以查核' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
