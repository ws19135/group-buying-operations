-- 028 合作申請與樣品管理（COLLABORATION_APPLICATIONS）
--
-- 業務背景：廠商原本用兩種 Excel／Google 表單追蹤「網紅樣品申請」與「開團追蹤」，
-- 現在整合為 ERP 原生模組，讓營運／廠商／團主共用同一筆案件的不同授權視圖。
--
-- 設計原則（對應 docs/phase2/INFLUENCER_SAMPLE_APPLICATION.md）：
--  1. 重用既有主檔：vendors / hosts / products / skus / campaigns，不建立平行主檔。
--  2. 不與 SOP 03 的 product_trials 混為同一個狀態機；只以 trial_id 選填關聯。
--  3. 四個維度各自記錄，不塞成一條超長狀態鏈：
--     申請狀態 status、合作狀態 collaboration_status、物流（collaboration_shipments 每列自己的 status）、
--     開團意願（collaboration_launch_details.intent）。
--  4. 「是否已補寄」不存布林欄位，由 collaboration_shipments 是否存在 RESEND 列推導（要有證據）。
--  5. 收件資訊是本系統唯一合法存放個資（姓名／電話／地址）的位置，獨立成表以便欄位層級權限、
--     存取稽核（audit_logs action='collaboration.recipient.read'）與保留政策（retention_until / purged_at）。
--  6. 只有「確認正式開團合作」後才允許關聯 Campaign —— 以資料庫 CHECK 強制，不只靠服務層。

-- ---------------------------------------------------------------- 合作申請單
CREATE TABLE collaboration_applications (
  id                    text PRIMARY KEY,                 -- CLB-000001
  organization_id       text NOT NULL REFERENCES organizations(id),
  vendor_id             text NOT NULL REFERENCES vendors(id),
  host_id               text NOT NULL REFERENCES hosts(id),
  -- 主要商品（明細另見 collaboration_application_items；此欄只是案件的代表商品，便於列表與篩選）
  product_id            text REFERENCES products(id),
  source                text NOT NULL DEFAULT 'OPS'
                          CHECK (source IN ('OPS','HOST_FORM','VENDOR_FORM','IMPORT')),
  applied_on            date NOT NULL,
  owner_user_id         text REFERENCES users(id),        -- 內部負責人
  status                text NOT NULL DEFAULT 'DRAFT'
                          CHECK (status IN ('DRAFT','SUBMITTED','INTERNAL_REVIEW','VENDOR_REVIEW','APPROVED','REJECTED','CANCELLED','ON_HOLD','CLOSED')),
  collaboration_status  text NOT NULL DEFAULT 'NOT_STARTED'
                          CHECK (collaboration_status IN ('NOT_STARTED','SAMPLE_IN_PROGRESS','TRIAL_IN_PROGRESS','AWAITING_INTENT','COLLABORATION_CONFIRMED','CAMPAIGN_LINKED','DECLINED')),
  -- 關聯既有檔期（選填）。同一檔期可關聯多筆申請，所以不設唯一。
  campaign_id           text REFERENCES campaigns(id),
  -- 選填：串接 SOP 03 正式試用紀錄。一般樣品申請「不等於」已完成 SOP 03 試用資格評估。
  trial_id              text REFERENCES product_trials(id),
  status_reason         text,
  hold_reason           text,
  note                  text,                             -- 外部可見備註（團主／廠商也看得到）
  internal_note         text,                             -- 僅內部角色可見
  -- 匯入冪等鍵：同一來源同一列重複匯入只會建立一次
  dedupe_key            text,
  submitted_at          timestamptz,
  internal_reviewed_at  timestamptz,
  internal_reviewed_by  text,
  vendor_reviewed_at    timestamptz,
  vendor_reviewed_by    text,
  decided_at            timestamptz,
  decided_by            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            text,
  updated_by            text,
  version               int NOT NULL DEFAULT 1,
  deleted_at            timestamptz,
  -- 只有確認正式開團合作後才能掛 Campaign（避免繞過合作確認直接建檔期關聯）
  CONSTRAINT collab_app_campaign_requires_confirm
    CHECK (campaign_id IS NULL OR collaboration_status IN ('COLLABORATION_CONFIRMED','CAMPAIGN_LINKED')),
  CONSTRAINT collab_app_hold_reason CHECK (status <> 'ON_HOLD' OR hold_reason IS NOT NULL)
);
CREATE UNIQUE INDEX collab_app_dedupe_uq ON collaboration_applications (organization_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX collab_app_org_status_idx   ON collaboration_applications (organization_id, status, applied_on DESC);
CREATE INDEX collab_app_vendor_idx       ON collaboration_applications (organization_id, vendor_id, status);
CREATE INDEX collab_app_host_idx         ON collaboration_applications (organization_id, host_id, status);
CREATE INDEX collab_app_product_idx      ON collaboration_applications (product_id) WHERE product_id IS NOT NULL;
CREATE INDEX collab_app_campaign_idx     ON collaboration_applications (campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX collab_app_trial_idx        ON collaboration_applications (trial_id) WHERE trial_id IS NOT NULL;
CREATE INDEX collab_app_owner_idx        ON collaboration_applications (organization_id, owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE TRIGGER collab_app_touch    BEFORE UPDATE ON collaboration_applications FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER collab_app_nodelete BEFORE DELETE ON collaboration_applications FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------- 申請樣品明細（一筆申請多商品／多 SKU）
CREATE TABLE collaboration_application_items (
  id               text PRIMARY KEY,                      -- CLI-000001
  organization_id  text NOT NULL REFERENCES organizations(id),
  application_id   text NOT NULL REFERENCES collaboration_applications(id),
  product_id       text NOT NULL REFERENCES products(id),
  sku_id           text REFERENCES skus(id),              -- 可為空＝整個商品，不視為另一個商品
  requested_qty    int  NOT NULL DEFAULT 1 CHECK (requested_qty > 0 AND requested_qty <= 9999),
  approved_qty     int  CHECK (approved_qty IS NULL OR approved_qty >= 0),
  supply_status    text NOT NULL DEFAULT 'PENDING'
                     CHECK (supply_status IN ('PENDING','AVAILABLE','PARTIAL','UNAVAILABLE')),
  request_reason   text,
  vendor_note      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  updated_by       text,
  version          int NOT NULL DEFAULT 1,
  deleted_at       timestamptz,
  CONSTRAINT collab_item_approved_le_requested CHECK (approved_qty IS NULL OR approved_qty <= requested_qty),
  CONSTRAINT collab_item_partial_needs_qty
    CHECK (supply_status <> 'PARTIAL' OR (approved_qty IS NOT NULL AND approved_qty > 0 AND approved_qty < requested_qty)),
  CONSTRAINT collab_item_unavailable_zero
    CHECK (supply_status <> 'UNAVAILABLE' OR coalesce(approved_qty, 0) = 0)
);
-- 相同明細（同申請、同商品、同規格）不可重複建立；重送請求不會多出一列
CREATE UNIQUE INDEX collab_item_uq ON collaboration_application_items (application_id, product_id, coalesce(sku_id, ''))
  WHERE deleted_at IS NULL;
CREATE INDEX collab_item_app_idx     ON collaboration_application_items (application_id);
CREATE INDEX collab_item_product_idx ON collaboration_application_items (organization_id, product_id);
CREATE TRIGGER collab_item_touch    BEFORE UPDATE ON collaboration_application_items FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER collab_item_nodelete BEFORE DELETE ON collaboration_application_items FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------- 收件資訊（個資；授權角色才可讀）
-- 同一團主在不同案件可用不同收件人與地址；這裡不覆寫 hosts 主檔的聯絡資料。
CREATE TABLE collaboration_recipients (
  id               text PRIMARY KEY,                      -- CRP-000001
  organization_id  text NOT NULL REFERENCES organizations(id),
  application_id   text NOT NULL REFERENCES collaboration_applications(id),
  recipient_name   text NOT NULL,
  recipient_phone  text NOT NULL,
  postal_code      text,
  address_line     text NOT NULL,
  delivery_note    text,
  confirmed_at     timestamptz,                           -- 團主（或代填者）確認「這份地址現在可用」的時間
  confirmed_by     text,
  -- 保留政策：超過這個日期之後不再提供給廠商，並可由資料最小化作業清空內容
  retention_until  date,
  purged_at        timestamptz,
  purge_reason     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  updated_by       text,
  version          int NOT NULL DEFAULT 1,
  deleted_at       timestamptz
);
-- 一筆申請同時只有一份有效收件資訊（改地址＝軟刪舊的、建新的，留下歷史）
CREATE UNIQUE INDEX collab_recipient_uq ON collaboration_recipients (application_id) WHERE deleted_at IS NULL;
CREATE INDEX collab_recipient_retention_idx ON collaboration_recipients (organization_id, retention_until)
  WHERE purged_at IS NULL AND deleted_at IS NULL;
CREATE TRIGGER collab_recipient_touch    BEFORE UPDATE ON collaboration_recipients FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER collab_recipient_nodelete BEFORE DELETE ON collaboration_recipients FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------- 樣品寄送紀錄（同一申請可多次）
CREATE TABLE collaboration_shipments (
  id                    text PRIMARY KEY,                 -- CSP-000001
  organization_id       text NOT NULL REFERENCES organizations(id),
  application_id        text NOT NULL REFERENCES collaboration_applications(id),
  shipment_type         text NOT NULL CHECK (shipment_type IN ('INITIAL','RESEND')),
  shipped_by_party      text NOT NULL DEFAULT 'VENDOR' CHECK (shipped_by_party IN ('VENDOR','OPS')),
  ship_date             date,
  carrier               text,
  tracking_no           text,
  quantity              int CHECK (quantity IS NULL OR (quantity > 0 AND quantity <= 9999)),
  status                text NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING','SHIPPED','DELIVERED','RETURNED','CANCELLED')),
  receipt_confirmed_at  timestamptz,
  receipt_confirmed_by  text,
  receipt_note          text,
  -- 若此次寄樣是走既有履約出貨能力（檔期內的 SAMPLE 批次），在此關聯，不另建平行物流系統
  fulfillment_shipment_id text REFERENCES shipments(id),
  cancel_reason         text,
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            text,
  updated_by            text,
  version               int NOT NULL DEFAULT 1,
  CONSTRAINT collab_ship_shipped_needs_date CHECK (status NOT IN ('SHIPPED','DELIVERED') OR ship_date IS NOT NULL),
  CONSTRAINT collab_ship_cancel_reason      CHECK (status <> 'CANCELLED' OR cancel_reason IS NOT NULL),
  CONSTRAINT collab_ship_delivered_confirm  CHECK (status <> 'DELIVERED' OR receipt_confirmed_at IS NOT NULL)
);
-- 同一家物流的同一個單號不重複（已取消者不計）
CREATE UNIQUE INDEX collab_ship_tracking_uq ON collaboration_shipments (organization_id, lower(carrier), tracking_no)
  WHERE tracking_no IS NOT NULL AND carrier IS NOT NULL AND status <> 'CANCELLED';
CREATE INDEX collab_ship_app_idx    ON collaboration_shipments (application_id, id);
CREATE INDEX collab_ship_status_idx ON collaboration_shipments (organization_id, status, ship_date);
CREATE TRIGGER collab_ship_touch    BEFORE UPDATE ON collaboration_shipments FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER collab_ship_nodelete BEFORE DELETE ON collaboration_shipments FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------- 開團合作資訊（1 申請 : 1 列）
CREATE TABLE collaboration_launch_details (
  id                    text PRIMARY KEY,                 -- CLD-000001
  organization_id       text NOT NULL REFERENCES organizations(id),
  application_id        text NOT NULL REFERENCES collaboration_applications(id),
  intent                text NOT NULL DEFAULT 'PENDING'
                          CHECK (intent IN ('PENDING','WILLING','UNDECIDED','UNWILLING')),
  intent_responded_on   date,
  intent_note           text,
  planned_open_date     date,                             -- 預計開團日（樣品還沒寄出也能先填）
  confirmed_open_date   date,                             -- 已確認開團日
  launch_url            text,                             -- 開團連結
  vendor_portal_url     text,                             -- 廠商後台連結（敏感商務資料，不給未授權者）
  backend_setup_email   text,                             -- 「後台設定 Mail」＝設定聯絡信箱
  backend_setup_status  text NOT NULL DEFAULT 'NOT_REQUIRED'
                          CHECK (backend_setup_status IN ('NOT_REQUIRED','PENDING','REQUESTED','DONE')),
  backend_setup_note    text,
  ads_intent            text NOT NULL DEFAULT 'PENDING' CHECK (ads_intent IN ('PENDING','YES','NO')),
  ads_confirm_status    text NOT NULL DEFAULT 'PENDING'
                          CHECK (ads_confirm_status IN ('PENDING','CONFIRMED','DECLINED')),
  ads_note              text,
  collaboration_note    text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            text,
  updated_by            text,
  version               int NOT NULL DEFAULT 1,
  CONSTRAINT collab_launch_intent_date CHECK (intent = 'PENDING' OR intent_responded_on IS NOT NULL),
  CONSTRAINT collab_launch_date_order
    CHECK (planned_open_date IS NULL OR confirmed_open_date IS NULL OR confirmed_open_date >= planned_open_date - 365),
  CONSTRAINT collab_launch_ads_confirm CHECK (ads_confirm_status = 'PENDING' OR ads_intent <> 'PENDING')
);
CREATE UNIQUE INDEX collab_launch_uq ON collaboration_launch_details (application_id);
CREATE INDEX collab_launch_intent_idx ON collaboration_launch_details (organization_id, intent, planned_open_date);
CREATE TRIGGER collab_launch_touch    BEFORE UPDATE ON collaboration_launch_details FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER collab_launch_nodelete BEFORE DELETE ON collaboration_launch_details FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------- 事件紀錄（append-only，支援平行維度）
CREATE TABLE collaboration_events (
  id                bigserial PRIMARY KEY,
  organization_id   text NOT NULL REFERENCES organizations(id),
  application_id    text NOT NULL REFERENCES collaboration_applications(id),
  dimension         text NOT NULL CHECK (dimension IN ('APPLICATION','COLLABORATION','SAMPLE','INTENT','CAMPAIGN','DATA')),
  event_type        text NOT NULL,
  from_status       text,
  to_status         text,
  note              text,
  is_internal       boolean NOT NULL DEFAULT false,
  actor_user_id     text,
  actor_role        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX collab_event_app_idx ON collaboration_events (application_id, id);
CREATE TRIGGER collab_event_immutable BEFORE UPDATE OR DELETE ON collaboration_events FOR EACH ROW EXECUTE FUNCTION forbid_modify();

-- ---------------------------------------------------------------- 匯入暫存列（先預覽驗證，確認後才建案件）
-- 主檔對應不明確（只有團主名稱、找不到 Host ID、找不到 Campaign…）一律留在這裡等人確認，
-- 不自動猜測也不自動合併不同人物。
CREATE TABLE collaboration_import_rows (
  id                 text PRIMARY KEY,                    -- CIR-000001
  organization_id    text NOT NULL REFERENCES organizations(id),
  batch_id           text NOT NULL REFERENCES import_batches(id),
  row_no             int NOT NULL,
  form_kind          text NOT NULL CHECK (form_kind IN ('FORM1_LAUNCH','FORM2_SAMPLE')),
  raw                jsonb NOT NULL,                      -- 原始列（欄位名→值）
  host_name_raw      text,
  vendor_name_raw    text,
  product_name_raw   text,
  resolved_host_id   text REFERENCES hosts(id),
  resolved_vendor_id text REFERENCES vendors(id),
  resolved_product_id text REFERENCES products(id),
  resolved_sku_id    text REFERENCES skus(id),
  resolved_campaign_id text REFERENCES campaigns(id),
  resolution         text NOT NULL DEFAULT 'NEEDS_REVIEW'
                       CHECK (resolution IN ('NEEDS_REVIEW','RESOLVED','SKIPPED','IMPORTED','FAILED')),
  issues             jsonb NOT NULL DEFAULT '[]'::jsonb,  -- 驗證訊息陣列
  application_id     text REFERENCES collaboration_applications(id),
  dedupe_key         text NOT NULL,                       -- 來源列的冪等鍵
  resolve_note       text,                                -- 人工修正對應或跳過的說明
  resolved_at        timestamptz,
  resolved_by        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         text,
  updated_by         text,
  version            int NOT NULL DEFAULT 1,
  deleted_at         timestamptz,
  CONSTRAINT collab_import_imported_needs_app CHECK (resolution <> 'IMPORTED' OR application_id IS NOT NULL)
);
CREATE UNIQUE INDEX collab_import_row_uq    ON collaboration_import_rows (batch_id, row_no) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX collab_import_dedupe_uq ON collaboration_import_rows (organization_id, dedupe_key) WHERE deleted_at IS NULL;
CREATE INDEX collab_import_batch_idx ON collaboration_import_rows (batch_id, resolution);
CREATE TRIGGER collab_import_touch    BEFORE UPDATE ON collaboration_import_rows FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER collab_import_nodelete BEFORE DELETE ON collaboration_import_rows FOR EACH ROW EXECUTE FUNCTION forbid_delete();
