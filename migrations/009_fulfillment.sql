-- 009 履約與出貨（Phase 2）：出貨批次、出貨單、庫存異動（append-only）
-- 不接任何真實物流 API；物流商／追蹤碼為人工輸入的文字。

CREATE TABLE fulfillment_batches (
  id                text PRIMARY KEY,              -- FBT-000001
  organization_id   text NOT NULL REFERENCES organizations(id),
  campaign_id       text NOT NULL REFERENCES campaigns(id),
  kind              text NOT NULL DEFAULT 'ORDER' CHECK (kind IN ('SAMPLE','ORDER')),   -- SAMPLE=寄樣／ORDER=訂單出貨
  label             text NOT NULL,
  -- 批次狀態由出貨單彙總而來（recomputeBatch），只有「取消」是人工動作
  status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PACKED','SHIPPED','DELIVERED','EXCEPTION','CANCELLED')),
  planned_ship_date date,
  note              text,                          -- 內部備註（團主／廠商看不到）
  cancel_reason     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text,
  updated_by        text,
  version           int NOT NULL DEFAULT 1,
  CHECK (status <> 'CANCELLED' OR cancel_reason IS NOT NULL)
);
CREATE INDEX fulfillment_batches_campaign_idx ON fulfillment_batches (organization_id, campaign_id, status);
CREATE TRIGGER fulfillment_batches_touch BEFORE UPDATE ON fulfillment_batches FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER fulfillment_batches_nodelete BEFORE DELETE ON fulfillment_batches FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE shipments (
  id                  text PRIMARY KEY,            -- SHP-000001
  organization_id     text NOT NULL REFERENCES organizations(id),
  campaign_id         text NOT NULL REFERENCES campaigns(id),
  batch_id            text NOT NULL REFERENCES fulfillment_batches(id),
  sku_id              text REFERENCES skus(id),
  quantity            int NOT NULL CHECK (quantity > 0),
  carrier             text,                        -- 物流商（文字，例如 黑貓／新竹／自送）
  tracking_no         text,
  status              text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PACKED','SHIPPED','DELIVERED','EXCEPTION','CANCELLED')),
  planned_date        date,
  shipped_date        date,
  delivered_date      date,
  exception_reason    text,
  cancel_reason       text,
  receipt_confirmed_at timestamptz,
  receipt_confirmed_by text,
  receipt_signer      text,                        -- 簽收人（文字）
  receipt_note        text,
  note                text,                        -- 內部備註
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          text,
  updated_by          text,
  version             int NOT NULL DEFAULT 1,
  CHECK (status <> 'EXCEPTION' OR exception_reason IS NOT NULL),
  CHECK (status <> 'CANCELLED' OR cancel_reason IS NOT NULL),
  CHECK (receipt_confirmed_at IS NULL OR status = 'DELIVERED'),
  CHECK (shipped_date IS NULL OR delivered_date IS NULL OR delivered_date >= shipped_date)
);
CREATE INDEX shipments_batch_idx ON shipments (organization_id, batch_id);
CREATE INDEX shipments_campaign_idx ON shipments (organization_id, campaign_id, status);
-- 同一物流商＋追蹤碼不能重複出現在有效的出貨單上
CREATE UNIQUE INDEX shipments_tracking_uq ON shipments (organization_id, lower(carrier), lower(tracking_no))
  WHERE tracking_no IS NOT NULL AND carrier IS NOT NULL AND status <> 'CANCELLED';
CREATE TRIGGER shipments_touch BEFORE UPDATE ON shipments FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER shipments_nodelete BEFORE DELETE ON shipments FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- 庫存異動：只能新增、不可改、不可刪；要更正就新增一筆反向異動（reverses_id）。目前庫存 = SUM(delta)
CREATE TABLE inventory_movements (
  id                text PRIMARY KEY,              -- INV-000001
  organization_id   text NOT NULL REFERENCES organizations(id),
  sku_id            text NOT NULL REFERENCES skus(id),
  campaign_id       text REFERENCES campaigns(id),
  shipment_id       text REFERENCES shipments(id),
  delta             int NOT NULL CHECK (delta <> 0),
  reason_code       text NOT NULL CHECK (reason_code IN ('INITIAL','RESTOCK','ADJUST','DAMAGE','RETURN','SHIPPED_OUT','CORRECTION')),
  reason            text NOT NULL,
  reverses_id       text REFERENCES inventory_movements(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text
);
CREATE UNIQUE INDEX inventory_reverses_uq ON inventory_movements (reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX inventory_sku_idx ON inventory_movements (organization_id, sku_id, created_at DESC);
CREATE TRIGGER inventory_movements_immutable BEFORE UPDATE OR DELETE ON inventory_movements FOR EACH ROW EXECUTE FUNCTION forbid_modify();
