-- 023 分潤口徑差異的「待人工確認項目」（Owner 決策 K-6a）
-- 合約、商業可行性與財務結算規則出現差異時，建立待人工確認項目；財務應依既有規則版本與核准流程處理。
-- 這張表只記錄「差異與確認狀態」：不覆蓋任何一方、不修改財務規則、已確認結算、歷史佣金、實際付款、發票。
CREATE TABLE commission_recon_items (
  id               text PRIMARY KEY,              -- RCI-000001
  organization_id  text NOT NULL REFERENCES organizations(id),
  campaign_id      text NOT NULL REFERENCES campaigns(id),
  host_id          text NOT NULL REFERENCES hosts(id),
  product_id       text NOT NULL REFERENCES products(id),
  fingerprint      text NOT NULL,                 -- 差異內容（各來源的值與版本、待覆核原因）的指紋；內容改變＝新的項目
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED','SUPERSEDED')),
  review_reasons   jsonb NOT NULL,                -- 偵測當時的待覆核原因（文字）
  snapshot         jsonb NOT NULL,                -- 偵測當時的三方比較快照（各欄位各來源的值、版本、核准狀態）與影響範圍
  detected_by      text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  acknowledged_by  text,
  acknowledged_at  timestamptz,
  acknowledge_note text,
  closed_at        timestamptz,
  close_reason     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          int NOT NULL DEFAULT 1,
  CHECK (status <> 'ACKNOWLEDGED' OR (acknowledged_by IS NOT NULL AND acknowledged_at IS NOT NULL AND acknowledge_note IS NOT NULL AND length(btrim(acknowledge_note)) > 0)),
  CHECK (status NOT IN ('RESOLVED','SUPERSEDED') OR (closed_at IS NOT NULL AND close_reason IS NOT NULL))
);
-- 同一組（檔期×團主×商品）同時只有一個進行中的項目
CREATE UNIQUE INDEX commission_recon_active_uq ON commission_recon_items (organization_id, campaign_id, host_id, product_id) WHERE status IN ('OPEN','ACKNOWLEDGED');
CREATE INDEX commission_recon_status_idx ON commission_recon_items (organization_id, status, last_seen_at DESC);
CREATE TRIGGER commission_recon_items_touch BEFORE UPDATE ON commission_recon_items FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER commission_recon_items_nodelete BEFORE DELETE ON commission_recon_items FOR EACH ROW EXECUTE FUNCTION forbid_delete();
