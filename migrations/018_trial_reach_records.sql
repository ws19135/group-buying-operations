-- 018 小規模測試團：觸及與導購資料（人工填寫，Owner 決策 K-2）
-- 三種「不同」的資料，不可互相替代：
--   POTENTIAL_REACH   潛在觸及人數（例如 LINE 群組成員數；是團主自己的社群規模，不是實際看到訊息的人）
--   ACTUAL_REACH      實際觸及人數（平台提供的貼文觸及人數）
--   QUALIFIED_VISITORS 有效導購訪客（有可信來源的不重複導購訪客數；真正的導購轉換率 CVR 只用這一種當分母）
-- 每筆都記錄來源、統計期間、填寫人、填寫日期、資料可信度。內容建立後不可改，只能「刪除」（軟刪除，保留紀錄與原因）後重新填。
CREATE TABLE trial_reach_records (
  id               text PRIMARY KEY,             -- RCH-000001
  organization_id  text NOT NULL REFERENCES organizations(id),
  trial_id         text NOT NULL REFERENCES product_trials(id),
  metric           text NOT NULL CHECK (metric IN ('POTENTIAL_REACH','ACTUAL_REACH','QUALIFIED_VISITORS')),
  value            int  NOT NULL CHECK (value >= 0 AND value <= 100000000),
  source_kind      text NOT NULL CHECK (source_kind IN ('LINE_GROUP_MEMBERS','PLATFORM_POST_REACH','SHORT_LINK_UNIQUE_VISITORS','PLATFORM_ANALYTICS','HOST_SELF_REPORT','OTHER')),
  source_text      text NOT NULL CHECK (length(btrim(source_text)) > 0),   -- 來源說明：哪個後台、哪份報表、誰提供
  period_start     date NOT NULL,
  period_end       date NOT NULL,
  credibility      text NOT NULL CHECK (credibility IN ('HIGH','MEDIUM','LOW')),
  note             text,
  filled_on        date NOT NULL,                  -- 填寫日期（組織時區）
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text NOT NULL,                  -- 填寫人
  updated_by       text,
  version          int NOT NULL DEFAULT 1,
  deleted_at       timestamptz,
  deleted_by       text,
  delete_reason    text,
  CHECK (period_end >= period_start),
  CHECK ((deleted_at IS NULL AND delete_reason IS NULL) OR (deleted_at IS NOT NULL AND delete_reason IS NOT NULL AND length(btrim(delete_reason)) > 0))
);
CREATE INDEX trial_reach_trial_idx ON trial_reach_records (organization_id, trial_id, metric) WHERE deleted_at IS NULL;
CREATE TRIGGER trial_reach_records_touch BEFORE UPDATE ON trial_reach_records FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER trial_reach_records_nodelete BEFORE DELETE ON trial_reach_records FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- 內容不可改：只允許軟刪除相關欄位變動（要更正就刪除後重填，才有完整紀錄）
CREATE OR REPLACE FUNCTION trial_reach_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.metric IS DISTINCT FROM OLD.metric OR NEW.value IS DISTINCT FROM OLD.value OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
     OR NEW.source_text IS DISTINCT FROM OLD.source_text OR NEW.period_start IS DISTINCT FROM OLD.period_start OR NEW.period_end IS DISTINCT FROM OLD.period_end
     OR NEW.credibility IS DISTINCT FROM OLD.credibility OR NEW.note IS DISTINCT FROM OLD.note OR NEW.filled_on IS DISTINCT FROM OLD.filled_on
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.trial_id IS DISTINCT FROM OLD.trial_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION '觸及與導購資料建立後不可修改；請刪除後重新填寫' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION '已刪除的資料不可再變更' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trial_reach_records_guard BEFORE UPDATE ON trial_reach_records FOR EACH ROW EXECUTE FUNCTION trial_reach_guard();
