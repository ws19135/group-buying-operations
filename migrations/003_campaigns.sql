-- 003 團購檔期：Campaign 及其商品、團主、曝光安排、核准、例外

CREATE TABLE campaigns (
  id                         text PRIMARY KEY,   -- CMP-202610-0001
  organization_id            text NOT NULL REFERENCES organizations(id),
  title                      text NOT NULL,
  normalized_title           text NOT NULL,
  status                     text NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
                               'DRAFT','EVALUATING','PENDING_G1','PREPARING','PENDING_G2','SCHEDULED',
                               'RUNNING','PENDING_CLOSE_CHECK','FULFILLING','PENDING_SETTLEMENT',
                               'SETTLED','CLOSED','CANCELLED','ON_HOLD')),
  status_reason              text,
  previous_status            text,               -- 取消／暫緩前的狀態（供恢復）
  vendor_id                  text NOT NULL REFERENCES vendors(id),
  owner_user_id              text REFERENCES users(id),   -- 檔期負責人
  campaign_type              text NOT NULL DEFAULT 'STANDARD',
  description                text,
  open_date                  date,
  close_date                 date,
  sample_ready_date          date,               -- 試用品可寄出日（SOP 的排程起點）
  needs_sample_recovery      boolean NOT NULL DEFAULT false,
  live_talk_date             date,
  target_revenue             bigint CHECK (target_revenue IS NULL OR target_revenue >= 0),  -- 內部目標（TWD）
  internal_note              text,
  workflow_template_id       text,
  workflow_template_version  int,
  workflow_params            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- 建立當下的天數參數快照
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 text,
  updated_by                 text,
  version                    int NOT NULL DEFAULT 1,
  deleted_at                 timestamptz,
  CHECK (open_date IS NULL OR close_date IS NULL OR open_date <= close_date)
);
-- 防重複建檔（重複表單送出）：同廠商、同標題、同開團日、未取消
CREATE UNIQUE INDEX campaigns_natural_uq ON campaigns
  (organization_id, vendor_id, normalized_title, (COALESCE(open_date, DATE '1900-01-01')))
  WHERE deleted_at IS NULL AND status <> 'CANCELLED';
CREATE INDEX campaigns_org_status_idx ON campaigns (organization_id, status);
CREATE INDEX campaigns_dates_idx ON campaigns (organization_id, open_date, close_date);
CREATE INDEX campaigns_vendor_idx ON campaigns (organization_id, vendor_id);
CREATE TRIGGER campaigns_touch BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER campaigns_nodelete BEFORE DELETE ON campaigns FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- 一檔多 SKU：每個 (商品, SKU) 一列；sku_id 為空代表整個商品
CREATE TABLE campaign_products (
  id               text PRIMARY KEY,             -- CPR-000001
  organization_id  text NOT NULL REFERENCES organizations(id),
  campaign_id      text NOT NULL REFERENCES campaigns(id),
  product_id       text NOT NULL REFERENCES products(id),
  sku_id           text REFERENCES skus(id),
  campaign_price   bigint CHECK (campaign_price IS NULL OR campaign_price >= 0),
  limit_qty        int CHECK (limit_qty IS NULL OR limit_qty >= 0),
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  updated_by       text,
  version          int NOT NULL DEFAULT 1,
  deleted_at       timestamptz
);
CREATE UNIQUE INDEX campaign_products_uq ON campaign_products
  (campaign_id, product_id, (COALESCE(sku_id, ''))) WHERE deleted_at IS NULL;
CREATE INDEX campaign_products_product_idx ON campaign_products (organization_id, product_id);
CREATE TRIGGER campaign_products_touch BEFORE UPDATE ON campaign_products FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER campaign_products_nodelete BEFORE DELETE ON campaign_products FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- 一檔多團主
CREATE TABLE campaign_hosts (
  id                 text PRIMARY KEY,           -- CHS-000001
  organization_id    text NOT NULL REFERENCES organizations(id),
  campaign_id        text NOT NULL REFERENCES campaigns(id),
  host_id            text NOT NULL REFERENCES hosts(id),
  role               text NOT NULL DEFAULT 'PRIMARY' CHECK (role IN ('PRIMARY','CO')),
  status             text NOT NULL DEFAULT 'INVITED'
                     CHECK (status IN ('INVITED','CONFIRMED','DECLINED','NO_RESPONSE')),
  invited_at         timestamptz NOT NULL DEFAULT now(),
  responded_at       timestamptz,
  target_revenue     bigint CHECK (target_revenue IS NULL OR target_revenue >= 0),  -- 該團主在此檔的目標
  commission_rule_id text,
  note               text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         text,
  updated_by         text,
  version            int NOT NULL DEFAULT 1,
  deleted_at         timestamptz
);
CREATE UNIQUE INDEX campaign_hosts_uq ON campaign_hosts (campaign_id, host_id) WHERE deleted_at IS NULL;
CREATE INDEX campaign_hosts_host_idx ON campaign_hosts (organization_id, host_id);
CREATE TRIGGER campaign_hosts_touch BEFORE UPDATE ON campaign_hosts FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER campaign_hosts_nodelete BEFORE DELETE ON campaign_hosts FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- 曝光安排：哪位團主、哪個社群、什麼時間、什麼形式
CREATE TABLE campaign_placements (
  id               text PRIMARY KEY,             -- PLC-000001
  organization_id  text NOT NULL REFERENCES organizations(id),
  campaign_id      text NOT NULL REFERENCES campaigns(id),
  host_id          text NOT NULL REFERENCES hosts(id),
  community_id     text NOT NULL REFERENCES communities(id),
  placement_type   text NOT NULL CHECK (placement_type IN ('LAUNCH','POST','STORY','LIVE_TALK','TOPIC','REMINDER')),
  scheduled_on     date NOT NULL,
  scheduled_time   time,
  status           text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','DONE','MISSED','CANCELLED')),
  actual_at        timestamptz,
  content_ref      text,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  updated_by       text,
  version          int NOT NULL DEFAULT 1,
  deleted_at       timestamptz
);
CREATE UNIQUE INDEX campaign_placements_uq ON campaign_placements
  (campaign_id, host_id, community_id, placement_type, scheduled_on)
  WHERE deleted_at IS NULL AND status <> 'CANCELLED';
CREATE INDEX campaign_placements_comm_idx ON campaign_placements (organization_id, community_id, scheduled_on);
CREATE TRIGGER campaign_placements_touch BEFORE UPDATE ON campaign_placements FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER campaign_placements_nodelete BEFORE DELETE ON campaign_placements FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- 核准（Gate G1–G5）
CREATE TABLE approvals (
  id               text PRIMARY KEY,             -- APR-000001
  organization_id  text NOT NULL REFERENCES organizations(id),
  campaign_id      text NOT NULL REFERENCES campaigns(id),
  gate_key         text NOT NULL CHECK (gate_key IN ('G1','G2','G3','G4','G5')),
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  requested_by     text,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  request_note     text,
  decided_by       text,
  decided_at       timestamptz,
  decision_note    text,
  check_snapshot   jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX approvals_pending_uq ON approvals (campaign_id, gate_key) WHERE status = 'PENDING';
CREATE INDEX approvals_campaign_idx ON approvals (organization_id, campaign_id, gate_key);
CREATE TRIGGER approvals_touch BEFORE UPDATE ON approvals FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER approvals_nodelete BEFORE DELETE ON approvals FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- 例外是一級資料：延誤、逾期、衝突、團主未回覆…
CREATE TABLE exceptions (
  id               text PRIMARY KEY,             -- EXC-000001
  organization_id  text NOT NULL REFERENCES organizations(id),
  type             text NOT NULL,
  severity         text NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN ('LOW','MEDIUM','HIGH')),
  entity_type      text NOT NULL,
  entity_id        text NOT NULL,
  campaign_id      text REFERENCES campaigns(id),
  title            text NOT NULL,
  detail           text,
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  owner_user_id    text REFERENCES users(id),
  dedupe_key       text,
  detected_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,
  resolved_by      text,
  resolution_note  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX exceptions_open_uq ON exceptions (organization_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status <> 'RESOLVED';
CREATE INDEX exceptions_org_status_idx ON exceptions (organization_id, status, severity);
CREATE INDEX exceptions_campaign_idx ON exceptions (organization_id, campaign_id);
CREATE TRIGGER exceptions_touch BEFORE UPDATE ON exceptions FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER exceptions_nodelete BEFORE DELETE ON exceptions FOR EACH ROW EXECUTE FUNCTION forbid_delete();
