-- 012 安全強化（獨立審查後）：結算項目／調整項的鎖定同時檢查「原本所屬」與「更新後所屬」的結算
-- 原本的 settlement_children_guard 只看 NEW.settlement_id：已確認結算的項目可被改指向另一份草稿結算而繞過鎖定。

CREATE OR REPLACE FUNCTION settlement_children_guard() RETURNS trigger AS $$
DECLARE st text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.settlement_id IS DISTINCT FROM NEW.settlement_id THEN
    RAISE EXCEPTION '% % cannot be moved to another settlement', TG_TABLE_NAME, OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT status INTO st FROM settlements WHERE id = OLD.settlement_id;
    IF st IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'settlement % is % (not DRAFT): % is locked', OLD.settlement_id, st, TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  SELECT status INTO st FROM settlements WHERE id = NEW.settlement_id;
  IF st IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'settlement % is % (not DRAFT): % is locked', NEW.settlement_id, st, TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
