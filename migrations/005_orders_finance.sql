-- 005 訂單與財務：匯入批次、訂單、歸因、佣金規則、結算（結算僅建 Schema）

CREATE TABLE import_batches (
  id                text PRIMARY KEY,            -- IMP-20261028-0001
  organization_id   text NOT NULL REFERENCES organizations(id),
  source_system     text NOT NULL,               -- 例如 CSV_UPLOAD / SHOP_PLATFORM_X
  data_origin       text NOT NULL CHECK (data_origin IN ('IMPORT','DEMO')),
  file_name         text,
  checksum          text NOT NULL,               -- 檔案內容 sha256：同一檔重複匯入會被擋下
  status            text NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING','COMPLETED','PARTIAL','FAILED')),
  total_rows        int NOT NULL DEFAULT 0,
  inserted_rows     int NOT NULL DEFAULT 0,
  updated_rows      int NOT NULL DEFAULT 0,
  duplicate_rows    int NOT NULL DEFAULT 0,
  error_rows        int NOT NULL DEFAULT 0,
  data_as_of        timestamptz,                 -- 來源資料截至時間（由匯入者提供或取檔內最大訂單時間）
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  created_by        text,
  UNIQUE (organization_id, checksum)
);
CREATE TRIGGER import_batches_nodelete BEFORE DELETE ON import_batches FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE import_errors (
  id                bigserial PRIMARY KEY,
  organization_id   text NOT NULL,
  batch_id          text NOT NULL REFERENCES import_batches(id),
  line_no           int NOT NULL,
  code              text NOT NULL,
  message           text NOT NULL,
  raw_row           jsonb,
  status            text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','IGNORED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  resolved_by       text
);
CREATE INDEX import_errors_batch_idx ON import_errors (organization_id, batch_id);
CREATE TRIGGER import_errors_nodelete BEFORE DELETE ON import_errors FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE orders (
  id                text PRIMARY KEY,            -- ORD-000001（內部 ID）
  organization_id   text NOT NULL REFERENCES organizations(id),
  campaign_id       text NOT NULL REFERENCES campaigns(id),
  source_system     text NOT NULL,
  source_order_id   text NOT NULL,               -- 來源平台訂單編號（去重鍵）
  ordered_at        timestamptz NOT NULL,
  status            text NOT NULL CHECK (status IN ('PAID','PENDING','CANCELLED','REFUNDED','PARTIAL_REFUND')),
  gross_amount      bigint NOT NULL CHECK (gross_amount >= 0),
  refund_amount     bigint NOT NULL DEFAULT 0 CHECK (refund_amount >= 0),
  buyer_ref         text,                        -- 去識別化購買人代號（不存姓名／電話／地址）
  data_origin       text NOT NULL CHECK (data_origin IN ('IMPORT','DEMO','MANUAL')),
  import_batch_id   text REFERENCES import_batches(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           int NOT NULL DEFAULT 1,
  UNIQUE (organization_id, source_system, source_order_id),
  CHECK (refund_amount <= gross_amount)
);
CREATE INDEX orders_campaign_idx ON orders (organization_id, campaign_id, ordered_at);
CREATE INDEX orders_time_idx ON orders (organization_id, ordered_at);
CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER orders_nodelete BEFORE DELETE ON orders FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE order_items (
  id                text PRIMARY KEY,            -- OIT-000001
  organization_id   text NOT NULL REFERENCES organizations(id),
  order_id          text NOT NULL REFERENCES orders(id),
  sku_id            text REFERENCES skus(id),
  sku_code_raw      text,
  quantity          int NOT NULL CHECK (quantity > 0),
  unit_price        bigint NOT NULL CHECK (unit_price >= 0),
  line_amount       bigint NOT NULL CHECK (line_amount >= 0)
);
CREATE INDEX order_items_order_idx ON order_items (order_id);
CREATE TRIGGER order_items_nodelete BEFORE DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- 訂單歸因到團主（可多團主分攤，share_percent 合計 100）
CREATE TABLE attributions (
  order_id          text NOT NULL REFERENCES orders(id),
  host_id           text NOT NULL REFERENCES hosts(id),
  community_id      text REFERENCES communities(id),
  organization_id   text NOT NULL REFERENCES organizations(id),
  share_percent     numeric(6,3) NOT NULL DEFAULT 100 CHECK (share_percent > 0 AND share_percent <= 100),
  method            text NOT NULL DEFAULT 'MANUAL' CHECK (method IN ('CODE','LINK','MANUAL','IMPORT')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, host_id)
);
CREATE INDEX attributions_host_idx ON attributions (organization_id, host_id);
CREATE TRIGGER attributions_nodelete BEFORE DELETE ON attributions FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- 佣金規則（版本化）。敏感：僅財務／管理者可寫；團主只能看到自己的費率。
CREATE TABLE commission_rules (
  id                text PRIMARY KEY,            -- CMR-0001
  organization_id   text NOT NULL REFERENCES organizations(id),
  scope_type        text NOT NULL CHECK (scope_type IN ('HOST_DEFAULT','CAMPAIGN_HOST')),
  host_id           text NOT NULL REFERENCES hosts(id),
  campaign_id       text REFERENCES campaigns(id),
  rate_percent      numeric(6,3) NOT NULL CHECK (rate_percent >= 0 AND rate_percent <= 100),
  basis             text NOT NULL DEFAULT 'NET_SALES' CHECK (basis IN ('NET_SALES')),
  rule_version      int NOT NULL DEFAULT 1,
  effective_from    date NOT NULL,
  effective_to      date,
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text,
  CHECK ((scope_type = 'CAMPAIGN_HOST') = (campaign_id IS NOT NULL))
);
CREATE INDEX commission_rules_host_idx ON commission_rules (organization_id, host_id, scope_type);
CREATE TRIGGER commission_rules_nodelete BEFORE DELETE ON commission_rules FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- 結算（Phase 1 只建立 Schema；試算／覆寫／確認屬 Phase 2，尚未實作）
CREATE TABLE settlements (
  id                text PRIMARY KEY,            -- SET-20261028-0001
  organization_id   text NOT NULL REFERENCES organizations(id),
  status            text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','CONFIRMED','VOID')),
  period_start      date,
  period_end        date,
  rule_version_note text,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text,
  confirmed_at      timestamptz,
  confirmed_by      text,
  version           int NOT NULL DEFAULT 1
);
CREATE TRIGGER settlements_touch BEFORE UPDATE ON settlements FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER settlements_nodelete BEFORE DELETE ON settlements FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE settlement_items (
  id                text PRIMARY KEY,            -- SIT-000001
  organization_id   text NOT NULL REFERENCES organizations(id),
  settlement_id     text NOT NULL REFERENCES settlements(id),
  campaign_id       text NOT NULL REFERENCES campaigns(id),
  host_id           text REFERENCES hosts(id),
  net_sales         bigint,
  commission_auto   bigint,
  commission_override bigint,
  override_reason   text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER settlement_items_nodelete BEFORE DELETE ON settlement_items FOR EACH ROW EXECUTE FUNCTION forbid_delete();
