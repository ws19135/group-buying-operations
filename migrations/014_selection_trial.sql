-- 014 SOP 02 商品選品與廠商開發、SOP 03 商品試用與商業可行性
-- 原則：只新增、不改既有表；不實體刪除；送出／結論後的評估內容不可改；證據只存連結與中繼資料。設計見 docs/phase2/PRODUCT_SELECTION_TRIAL.md。

-- 證據連結（可掛在盡職調查項目、評估、試用、試用檢核、可行性）；不存檔案本體
CREATE TABLE evidence_items (
  id               text PRIMARY KEY,             -- EVI-000001
  organization_id  text NOT NULL REFERENCES organizations(id),
  subject_type     text NOT NULL CHECK (subject_type IN ('DD_ITEM','EVALUATION','TRIAL','TRIAL_CHECK','FEASIBILITY')),
  subject_id       text NOT NULL,
  vendor_id        text REFERENCES vendors(id),
  product_id       text REFERENCES products(id),
  kind             text NOT NULL CHECK (kind IN ('CERTIFICATE','TEST_REPORT','CONTRACT','QUOTE','PHOTO','VIDEO','LICENSE','LEGAL_OPINION','OTHER')),
  title            text NOT NULL,
  url              text NOT NULL,
  source_label     text,
  valid_from       date,
  valid_until      date,                          -- 文件有效期限；空＝無期限或未知
  note             text,
  asset_id         text REFERENCES product_assets(id),   -- 選填：引用既有商品素材連結，不複製
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  updated_by       text,
  version          int NOT NULL DEFAULT 1,
  deleted_at       timestamptz,
  CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_until >= valid_from)
);
CREATE INDEX evidence_items_subject_idx ON evidence_items (organization_id, subject_type, subject_id) WHERE deleted_at IS NULL;
CREATE INDEX evidence_items_expiry_idx ON evidence_items (organization_id, valid_until) WHERE deleted_at IS NULL AND valid_until IS NOT NULL;
CREATE TRIGGER evidence_items_touch BEFORE UPDATE ON evidence_items FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER evidence_items_nodelete BEFORE DELETE ON evidence_items FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- 廠商首次合作盡職調查（表頭）：某廠商（可限定某商品）在某合約版本下的 12 類問題
CREATE TABLE vendor_dd_records (
  id                 text PRIMARY KEY,           -- VDD-000001
  organization_id    text NOT NULL REFERENCES organizations(id),
  vendor_id          text NOT NULL REFERENCES vendors(id),
  product_id         text REFERENCES products(id),
  contract_version   text NOT NULL CHECK (length(btrim(contract_version)) > 0),
  contract_ref       text,                        -- 合約編號／文件位置（文字）
  regulated_category text CHECK (regulated_category IS NULL OR regulated_category IN ('FOOD','SUPPLEMENT','MEDICAL_DEVICE','COSMETIC','CHILD_PRODUCT','OTHER_REGULATED')),
  status             text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','IN_REVIEW','APPROVED','REJECTED')),
  prepared_by        text,
  submitted_at       timestamptz,
  reviewed_by        text,
  reviewed_at        timestamptz,
  review_note        text,
  valid_until        date,                        -- 核准後的有效期限
  note               text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         text,
  updated_by         text,
  version            int NOT NULL DEFAULT 1,
  deleted_at         timestamptz,
  CHECK (status <> 'APPROVED' OR (valid_until IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK (status <> 'REJECTED' OR (review_note IS NOT NULL AND reviewed_by IS NOT NULL))
);
CREATE UNIQUE INDEX vendor_dd_records_uq ON vendor_dd_records (vendor_id, (COALESCE(product_id, '')), contract_version) WHERE deleted_at IS NULL;
CREATE INDEX vendor_dd_records_vendor_idx ON vendor_dd_records (organization_id, vendor_id) WHERE deleted_at IS NULL;
CREATE TRIGGER vendor_dd_records_touch BEFORE UPDATE ON vendor_dd_records FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER vendor_dd_records_nodelete BEFORE DELETE ON vendor_dd_records FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE vendor_dd_items (
  id                text PRIMARY KEY,            -- VDI-000001
  organization_id   text NOT NULL REFERENCES organizations(id),
  record_id         text NOT NULL REFERENCES vendor_dd_records(id),
  category_key      text NOT NULL CHECK (category_key IN ('SOURCE_LICENSE_QA','PRICING','MOQ','STOCK_LEADTIME','INVENTORY_OVERSELL','DELIVERY_METHOD',
                      'PAYMENT_LIABILITY','RETURNS_LIABILITY','SAMPLE_MEDIA_LICENSE','COMMISSION_TERMS','EXCLUSIVITY_RESALE','CONTINGENCY')),
  status            text NOT NULL DEFAULT 'PENDING_DOCS' CHECK (status IN ('CONFIRMED','PENDING_DOCS','NOT_APPLICABLE','AT_RISK')),
  responsible_party text NOT NULL DEFAULT 'TBD' CHECK (responsible_party IN ('BRAND','COMPANY','HOST','SHARED','TBD')),
  owner_user_id     text REFERENCES users(id),
  terms             jsonb NOT NULL DEFAULT '{}'::jsonb,   -- 結構化條款（依類別驗證）
  note              text,
  na_reason         text,
  risk_note         text,
  legal_status      text NOT NULL DEFAULT 'NOT_REQUIRED' CHECK (legal_status IN ('NOT_REQUIRED','REQUIRED','CLEARED','BLOCKED')),
  legal_reason      text,
  legal_note        text,
  legal_cleared_by  text,
  legal_cleared_at  timestamptz,
  confirmed_by      text,
  confirmed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text,
  updated_by        text,
  version           int NOT NULL DEFAULT 1,
  UNIQUE (record_id, category_key),
  CHECK (status <> 'NOT_APPLICABLE' OR (na_reason IS NOT NULL AND length(btrim(na_reason)) > 0)),
  CHECK (status <> 'AT_RISK' OR (risk_note IS NOT NULL AND length(btrim(risk_note)) > 0)),
  CHECK (legal_status <> 'CLEARED' OR (legal_cleared_by IS NOT NULL AND legal_cleared_at IS NOT NULL AND legal_note IS NOT NULL))
);
CREATE INDEX vendor_dd_items_record_idx ON vendor_dd_items (record_id);
CREATE TRIGGER vendor_dd_items_touch BEFORE UPDATE ON vendor_dd_items FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER vendor_dd_items_nodelete BEFORE DELETE ON vendor_dd_items FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- 商品通用選品評估（人工評分 1–5；不含客群適配，客群適配在 product_fit_assessments）
CREATE TABLE product_evaluations (
  id               text PRIMARY KEY,             -- SEL-000001
  organization_id  text NOT NULL REFERENCES organizations(id),
  product_id       text NOT NULL REFERENCES products(id),
  version_no       int NOT NULL,
  status           text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED')),
  scores           jsonb NOT NULL DEFAULT '{}'::jsonb,       -- {need:{score,reason,evidenceCount}, quality:…}
  compliance       jsonb NOT NULL DEFAULT '{}'::jsonb,       -- {status:PASS|FAIL|UNKNOWN|NEEDS_LEGAL, note}
  config_version   int,
  config_snapshot  jsonb,
  total_score      numeric(5,1),
  completeness     numeric(4,3),
  confidence       text CHECK (confidence IS NULL OR confidence IN ('HIGH','MEDIUM','LOW','INSUFFICIENT')),
  recommendation   text CHECK (recommendation IS NULL OR recommendation IN ('PROCEED','SUPPLEMENT','HOLD','BLOCKED','INSUFFICIENT_DATA')),
  evidence_gaps    jsonb,
  evaluator_id     text,
  evaluated_on     date,
  submitted_at     timestamptz,
  review_decision  text CHECK (review_decision IS NULL OR review_decision IN ('ACCEPTED','REJECTED','NEEDS_MORE')),
  review_note      text,
  reviewed_by      text,
  reviewed_at      timestamptz,
  superseded_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  updated_by       text,
  version          int NOT NULL DEFAULT 1,
  UNIQUE (product_id, version_no),
  CHECK (status = 'DRAFT' OR (submitted_at IS NOT NULL AND recommendation IS NOT NULL AND evaluator_id IS NOT NULL AND evaluated_on IS NOT NULL)),
  CHECK (review_decision IS NULL OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND status = 'SUBMITTED')),
  CHECK (review_decision IS NULL OR review_decision = 'ACCEPTED' OR review_note IS NOT NULL)
);
CREATE UNIQUE INDEX product_evaluations_draft_uq ON product_evaluations (product_id) WHERE status = 'DRAFT';
CREATE INDEX product_evaluations_product_idx ON product_evaluations (organization_id, product_id, version_no DESC);

CREATE FUNCTION product_evaluations_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'SUBMITTED' AND (
       NEW.scores IS DISTINCT FROM OLD.scores OR NEW.compliance IS DISTINCT FROM OLD.compliance OR NEW.config_version IS DISTINCT FROM OLD.config_version
       OR NEW.config_snapshot IS DISTINCT FROM OLD.config_snapshot OR NEW.total_score IS DISTINCT FROM OLD.total_score
       OR NEW.completeness IS DISTINCT FROM OLD.completeness OR NEW.confidence IS DISTINCT FROM OLD.confidence
       OR NEW.recommendation IS DISTINCT FROM OLD.recommendation OR NEW.evidence_gaps IS DISTINCT FROM OLD.evidence_gaps
       OR NEW.evaluator_id IS DISTINCT FROM OLD.evaluator_id OR NEW.evaluated_on IS DISTINCT FROM OLD.evaluated_on
       OR NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.version_no IS DISTINCT FROM OLD.version_no OR NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION '已送出的選品評估內容不可修改；請建立新版本' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at THEN
    RAISE EXCEPTION '已被取代的評估不可再變更取代資訊' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER product_evaluations_guard BEFORE UPDATE ON product_evaluations FOR EACH ROW EXECUTE FUNCTION product_evaluations_guard();
CREATE TRIGGER product_evaluations_touch BEFORE UPDATE ON product_evaluations FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER product_evaluations_nodelete BEFORE DELETE ON product_evaluations FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- 商品試用（商品資格驗證／團主與檔期適配）。只有資料狀態 OPEN／CONCLUDED／CANCELLED，不是任務狀態機
CREATE TABLE product_trials (
  id                    text PRIMARY KEY,        -- TRL-000001
  organization_id       text NOT NULL REFERENCES organizations(id),
  product_id            text NOT NULL REFERENCES products(id),
  sku_id                text REFERENCES skus(id),
  vendor_id             text NOT NULL REFERENCES vendors(id),
  level                 text NOT NULL CHECK (level IN ('QUALIFICATION','HOST_FIT')),
  trial_type            text NOT NULL CHECK (trial_type IN ('INTERNAL','DESIGNATED_HOST','MINI_GROUP')),
  host_id               text REFERENCES hosts(id),
  campaign_id           text REFERENCES campaigns(id),
  tester_user_id        text REFERENCES users(id),
  tester_note           text,
  qualification_trial_id text REFERENCES product_trials(id),   -- 沿用的商品資格試用（僅團主適配層級）
  sample_batch_id       text REFERENCES fulfillment_batches(id),
  ship_date             date,
  arrival_date          date,
  start_date            date,
  feedback_date         date,
  closed_date           date,
  carrier               text,
  tracking_no           text,
  recovery_required     boolean NOT NULL DEFAULT false,
  recovery_status       text NOT NULL DEFAULT 'NOT_REQUIRED' CHECK (recovery_status IN ('NOT_REQUIRED','PENDING','RECOVERED','WAIVED','LOST')),
  recovery_date         date,
  recovery_note         text,
  status                text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CONCLUDED','CANCELLED')),
  cancel_reason         text,
  conclusion            text CHECK (conclusion IS NULL OR conclusion IN ('PASS','CONDITIONAL','FAIL','RETEST')),
  suggested_conclusion  text CHECK (suggested_conclusion IS NULL OR suggested_conclusion IN ('PASS','CONDITIONAL','FAIL','RETEST')),
  conclusion_note       text,
  override_reason       text,
  concluded_by          text,
  concluded_at          timestamptz,
  valid_until           date,                     -- 商品資格的有效期限
  basis_fingerprint     text,                     -- 結論當下的商品指紋（名稱、類別、規格編號、合規備註）
  review_decision       text CHECK (review_decision IS NULL OR review_decision IN ('ACCEPTED','REJECTED')),
  review_note           text,
  reviewed_by           text,
  reviewed_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            text,
  updated_by            text,
  version               int NOT NULL DEFAULT 1,
  CHECK (trial_type <> 'DESIGNATED_HOST' OR host_id IS NOT NULL),
  CHECK (trial_type <> 'MINI_GROUP' OR campaign_id IS NOT NULL),
  CHECK (level <> 'QUALIFICATION' OR qualification_trial_id IS NULL),
  CHECK (ship_date IS NULL OR arrival_date IS NULL OR arrival_date >= ship_date),
  CHECK (arrival_date IS NULL OR start_date IS NULL OR start_date >= arrival_date),
  CHECK (start_date IS NULL OR feedback_date IS NULL OR feedback_date >= start_date),
  CHECK (feedback_date IS NULL OR closed_date IS NULL OR closed_date >= feedback_date),
  CHECK (status <> 'CANCELLED' OR (cancel_reason IS NOT NULL AND length(btrim(cancel_reason)) > 0)),
  CHECK (status <> 'CONCLUDED' OR (conclusion IS NOT NULL AND concluded_by IS NOT NULL AND concluded_at IS NOT NULL AND conclusion_note IS NOT NULL)),
  CHECK (review_decision IS NULL OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND status = 'CONCLUDED')),
  CHECK (review_decision IS NULL OR review_decision = 'ACCEPTED' OR review_note IS NOT NULL),
  CHECK (recovery_required OR recovery_status = 'NOT_REQUIRED'),
  CHECK (NOT recovery_required OR recovery_status <> 'NOT_REQUIRED')
);
-- 同一商品＋規格＋團主＋檔期＋類型＋層級，進行中只能有一筆（已結論或取消的可再開新一次）
CREATE UNIQUE INDEX product_trials_open_uq ON product_trials
  (product_id, (COALESCE(sku_id, '')), (COALESCE(host_id, '')), (COALESCE(campaign_id, '')), trial_type, level) WHERE status = 'OPEN';
CREATE INDEX product_trials_product_idx ON product_trials (organization_id, product_id, created_at DESC);
CREATE INDEX product_trials_campaign_idx ON product_trials (organization_id, campaign_id) WHERE campaign_id IS NOT NULL;

CREATE FUNCTION product_trials_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'CONCLUDED' AND (
       NEW.conclusion IS DISTINCT FROM OLD.conclusion OR NEW.suggested_conclusion IS DISTINCT FROM OLD.suggested_conclusion
       OR NEW.conclusion_note IS DISTINCT FROM OLD.conclusion_note OR NEW.override_reason IS DISTINCT FROM OLD.override_reason
       OR NEW.concluded_by IS DISTINCT FROM OLD.concluded_by OR NEW.concluded_at IS DISTINCT FROM OLD.concluded_at
       OR NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.sku_id IS DISTINCT FROM OLD.sku_id OR NEW.host_id IS DISTINCT FROM OLD.host_id
       OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id OR NEW.level IS DISTINCT FROM OLD.level OR NEW.trial_type IS DISTINCT FROM OLD.trial_type
       OR NEW.valid_until IS DISTINCT FROM OLD.valid_until OR NEW.basis_fingerprint IS DISTINCT FROM OLD.basis_fingerprint
       OR NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION '已結論的試用內容不可修改；請建立新的試用' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER product_trials_guard BEFORE UPDATE ON product_trials FOR EACH ROW EXECUTE FUNCTION product_trials_guard();
CREATE TRIGGER product_trials_touch BEFORE UPDATE ON product_trials FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER product_trials_nodelete BEFORE DELETE ON product_trials FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE trial_checks (
  id               text PRIMARY KEY,             -- TCK-000001
  organization_id  text NOT NULL REFERENCES organizations(id),
  trial_id         text NOT NULL REFERENCES product_trials(id),
  dimension        text NOT NULL CHECK (dimension IN ('PRODUCT','CUSTOMER','CONTENT','BUSINESS')),
  item_key         text NOT NULL,
  item_label       text NOT NULL,
  result           text NOT NULL DEFAULT 'NOT_TESTED' CHECK (result IN ('NOT_TESTED','PASS','CONCERN','FAIL')),
  evidence_text    text,                          -- 客觀證據（PASS 必填）
  defect_severity  text NOT NULL DEFAULT 'NONE' CHECK (defect_severity IN ('NONE','MINOR','MAJOR','CRITICAL')),
  defect_note      text,
  risk_note        text,
  verified_by      text,
  verified_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  updated_by       text,
  version          int NOT NULL DEFAULT 1,
  UNIQUE (trial_id, item_key),
  CHECK (result <> 'PASS' OR (evidence_text IS NOT NULL AND length(btrim(evidence_text)) > 0)),
  CHECK (defect_severity = 'NONE' OR (defect_note IS NOT NULL AND length(btrim(defect_note)) > 0)),
  CHECK (result <> 'FAIL' OR (risk_note IS NOT NULL OR defect_note IS NOT NULL))
);
CREATE INDEX trial_checks_trial_idx ON trial_checks (trial_id);
CREATE FUNCTION trial_checks_guard() RETURNS trigger AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM product_trials WHERE id = NEW.trial_id;
  IF st IS DISTINCT FROM 'OPEN' THEN
    RAISE EXCEPTION '試用 % 已 %，檢核項不可新增或修改', NEW.trial_id, st USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trial_checks_guard BEFORE INSERT OR UPDATE ON trial_checks FOR EACH ROW EXECUTE FUNCTION trial_checks_guard();
CREATE TRIGGER trial_checks_touch BEFORE UPDATE ON trial_checks FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER trial_checks_nodelete BEFORE DELETE ON trial_checks FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- 商業可行性情境：每次儲存一個新版本；輸入為空＝未知（不捏造）。敏感欄位的讀寫在服務層以 product.cost.read 控管
CREATE TABLE feasibility_scenarios (
  id               text PRIMARY KEY,             -- FSB-000001
  organization_id  text NOT NULL REFERENCES organizations(id),
  product_id       text NOT NULL REFERENCES products(id),
  campaign_id      text REFERENCES campaigns(id),
  host_id          text REFERENCES hosts(id),
  trial_id         text REFERENCES product_trials(id),
  version_no       int NOT NULL,
  label            text,
  inputs           jsonb NOT NULL DEFAULT '{}'::jsonb,
  sources          jsonb NOT NULL DEFAULT '{}'::jsonb,       -- 每個輸入的假設來源
  results          jsonb NOT NULL DEFAULT '{}'::jsonb,       -- 試算結果與缺漏
  actuals          jsonb,                                    -- 小規模測試團回寫（可補寫）
  actuals_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  updated_by       text,
  version          int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX feasibility_scenarios_uq ON feasibility_scenarios (product_id, (COALESCE(campaign_id, '')), (COALESCE(host_id, '')), version_no);
CREATE INDEX feasibility_scenarios_product_idx ON feasibility_scenarios (organization_id, product_id, created_at DESC);
CREATE FUNCTION feasibility_scenarios_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.inputs IS DISTINCT FROM OLD.inputs OR NEW.sources IS DISTINCT FROM OLD.sources OR NEW.results IS DISTINCT FROM OLD.results
     OR NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id OR NEW.host_id IS DISTINCT FROM OLD.host_id
     OR NEW.version_no IS DISTINCT FROM OLD.version_no THEN
    RAISE EXCEPTION '可行性情境的假設與試算結果不可修改；請儲存新版本' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER feasibility_scenarios_guard BEFORE UPDATE ON feasibility_scenarios FOR EACH ROW EXECUTE FUNCTION feasibility_scenarios_guard();
CREATE TRIGGER feasibility_scenarios_touch BEFORE UPDATE ON feasibility_scenarios FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER feasibility_scenarios_nodelete BEFORE DELETE ON feasibility_scenarios FOR EACH ROW EXECUTE FUNCTION forbid_delete();
