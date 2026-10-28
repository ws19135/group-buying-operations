-- 011 財務（Phase 2）：結算試算／確認、調整項、入帳確認紀錄、發票紀錄、費用紀錄
-- 全部只是「紀錄」：不串金流／銀行／電子發票；金額公式一律沿用 Phase 1 預估佣金口徑（歸因淨銷售 × 版本化費率）。

-- ===== 結算：以「檔期」為單位的試算批次 =====
ALTER TABLE settlements
  ADD COLUMN updated_at    timestamptz NOT NULL DEFAULT now(),   -- touch_row 觸發器需要此欄位
  ADD COLUMN campaign_id   text REFERENCES campaigns(id),
  ADD COLUMN data_as_of    timestamptz,                 -- 試算所依據的訂單資料截至時間
  ADD COLUMN data_status   text,                        -- NO_DATA／DEMO／IMPORT／MIXED（試算當下）
  ADD COLUMN voided_at     timestamptz,
  ADD COLUMN voided_by     text,
  ADD COLUMN void_reason   text;
-- 同一檔期同時只能有一份「草稿或已確認」的結算；作廢後才能重開
CREATE UNIQUE INDEX settlements_campaign_live_uq ON settlements (campaign_id) WHERE status IN ('DRAFT','CONFIRMED') AND campaign_id IS NOT NULL;
CREATE INDEX settlements_org_idx ON settlements (organization_id, created_at DESC);

-- 狀態只能 DRAFT→CONFIRMED／VOID、CONFIRMED→VOID；VOID 為終態；已確認後確認欄位與備註不可改
CREATE FUNCTION settlements_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'VOID' THEN
    RAISE EXCEPTION 'settlement % is void and cannot change', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'CONFIRMED' THEN
    IF NEW.status NOT IN ('CONFIRMED','VOID') THEN
      RAISE EXCEPTION 'confirmed settlement % can only be voided', OLD.id USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.status = 'CONFIRMED' AND (NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
       OR NEW.rule_version_note IS DISTINCT FROM OLD.rule_version_note OR NEW.data_as_of IS DISTINCT FROM OLD.data_as_of
       OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id) THEN
      RAISE EXCEPTION 'confirmed settlement % is locked', OLD.id USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER settlements_guard BEFORE UPDATE ON settlements FOR EACH ROW EXECUTE FUNCTION settlements_guard();

ALTER TABLE settlement_items
  ADD COLUMN rate_percent  numeric(6,3),                -- 試算當下採用的費率（快照）
  ADD COLUMN rule_id       text,                        -- 試算當下採用的佣金規則（快照）
  ADD COLUMN rule_version  int,
  ADD COLUMN updated_at    timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN updated_by    text;
ALTER TABLE settlement_items ADD CONSTRAINT settlement_items_override_chk CHECK (commission_override IS NULL OR (commission_override >= 0 AND override_reason IS NOT NULL AND length(btrim(override_reason)) > 0));
CREATE UNIQUE INDEX settlement_items_uq ON settlement_items (settlement_id, host_id);
CREATE INDEX settlement_items_host_idx ON settlement_items (organization_id, host_id);

-- 人工調整項：金額可正可負、原因必填、只能新增（append-only）
CREATE TABLE settlement_adjustments (
  id              text PRIMARY KEY,                     -- ADJ-000001
  organization_id text NOT NULL REFERENCES organizations(id),
  settlement_id   text NOT NULL REFERENCES settlements(id),
  item_id         text NOT NULL REFERENCES settlement_items(id),
  amount          bigint NOT NULL CHECK (amount <> 0),
  reason          text NOT NULL CHECK (length(btrim(reason)) > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text
);
CREATE INDEX settlement_adjustments_idx ON settlement_adjustments (settlement_id, item_id);
CREATE TRIGGER settlement_adjustments_immutable BEFORE UPDATE OR DELETE ON settlement_adjustments FOR EACH ROW EXECUTE FUNCTION forbid_modify();

-- 結算一旦不是草稿，項目與調整項在資料庫層就不能新增或修改
CREATE FUNCTION settlement_children_guard() RETURNS trigger AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM settlements WHERE id = NEW.settlement_id;
  IF st IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'settlement % is % (not DRAFT): % is locked', NEW.settlement_id, st, TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER settlement_items_guard BEFORE INSERT OR UPDATE ON settlement_items FOR EACH ROW EXECUTE FUNCTION settlement_children_guard();
CREATE TRIGGER settlement_adjustments_guard BEFORE INSERT ON settlement_adjustments FOR EACH ROW EXECUTE FUNCTION settlement_children_guard();

-- ===== 入帳／付款確認紀錄（不接銀行；參考號請勿填銀行帳號） =====
CREATE TABLE payments (
  id                 text PRIMARY KEY,                  -- PAY-000001
  organization_id    text NOT NULL REFERENCES organizations(id),
  direction          text NOT NULL CHECK (direction IN ('IN','OUT')),
  counterparty_type  text NOT NULL CHECK (counterparty_type IN ('VENDOR','HOST','PLATFORM')),
  counterparty_id    text,                              -- 廠商／團主 ID；PLATFORM 為空
  amount             bigint NOT NULL CHECK (amount > 0),
  paid_on            date NOT NULL,
  reference_no       text,
  note               text,
  campaign_id        text REFERENCES campaigns(id),
  settlement_item_id text REFERENCES settlement_items(id),
  match_status       text NOT NULL DEFAULT 'UNMATCHED' CHECK (match_status IN ('UNMATCHED','MATCHED')),
  matched_at         timestamptz,
  matched_by         text,
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','VOID')),
  void_reason        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         text,
  updated_by         text,
  version            int NOT NULL DEFAULT 1,
  CHECK (match_status = 'UNMATCHED' OR campaign_id IS NOT NULL OR settlement_item_id IS NOT NULL),
  CHECK (status = 'ACTIVE' OR (void_reason IS NOT NULL AND length(btrim(void_reason)) > 0)),
  CHECK ((counterparty_type = 'PLATFORM') = (counterparty_id IS NULL))
);
CREATE INDEX payments_org_idx ON payments (organization_id, paid_on DESC);
CREATE INDEX payments_campaign_idx ON payments (organization_id, campaign_id);
CREATE TRIGGER payments_touch BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER payments_nodelete BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ===== 發票紀錄（只做紀錄，不串電子發票；抬頭／統編請用佔位字） =====
CREATE TABLE invoices (
  id                 text PRIMARY KEY,                  -- INV-000001
  organization_id    text NOT NULL REFERENCES organizations(id),
  invoice_no         text NOT NULL CHECK (length(btrim(invoice_no)) > 0),
  invoice_date       date NOT NULL,
  amount             bigint NOT NULL CHECK (amount >= 0),
  title_text         text,                              -- 抬頭（佔位）
  tax_id_text        text,                              -- 統編（佔位）
  campaign_id        text REFERENCES campaigns(id),
  note               text,
  status             text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ISSUED','VOID')),
  issued_at          timestamptz,
  voided_at          timestamptz,
  void_reason        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         text,
  updated_by         text,
  version            int NOT NULL DEFAULT 1,
  CHECK (status <> 'VOID' OR (void_reason IS NOT NULL AND length(btrim(void_reason)) > 0))
);
-- 同一組織同一發票號碼只能有一張「未作廢」的紀錄
CREATE UNIQUE INDEX invoices_no_live_uq ON invoices (organization_id, invoice_no) WHERE status <> 'VOID';
CREATE INDEX invoices_org_idx ON invoices (organization_id, invoice_date DESC);
CREATE TRIGGER invoices_touch BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER invoices_nodelete BEFORE DELETE ON invoices FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ===== 費用紀錄（只做紀錄與彙總，不進佣金公式） =====
CREATE TABLE expenses (
  id                 text PRIMARY KEY,                  -- EXP-000001
  organization_id    text NOT NULL REFERENCES organizations(id),
  campaign_id        text REFERENCES campaigns(id),
  category           text NOT NULL CHECK (category IN ('SHIPPING','MARKETING','SAMPLE','PLATFORM_FEE','OTHER')),
  amount             bigint NOT NULL CHECK (amount > 0),
  incurred_on        date NOT NULL,
  note               text,
  status             text NOT NULL DEFAULT 'RECORDED' CHECK (status IN ('RECORDED','VOID')),
  void_reason        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         text,
  updated_by         text,
  version            int NOT NULL DEFAULT 1,
  CHECK (status = 'RECORDED' OR (void_reason IS NOT NULL AND length(btrim(void_reason)) > 0))
);
CREATE INDEX expenses_org_idx ON expenses (organization_id, incurred_on DESC);
CREATE INDEX expenses_campaign_idx ON expenses (organization_id, campaign_id);
CREATE TRIGGER expenses_touch BEFORE UPDATE ON expenses FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER expenses_nodelete BEFORE DELETE ON expenses FOR EACH ROW EXECUTE FUNCTION forbid_delete();
