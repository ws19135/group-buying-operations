-- 013 SOP 01 客群分析與商品適配：客群輪廓、偏好、團主↔客群、研究證據、適配評估
-- 原則：只新增、不改既有表語意（僅在 hosts 加一個可空欄位）；不實體刪除；評估內容寫入後不可改。
-- 空值＝未知（不是「無」），所以主要欄位都可空；事實／估計用 basis 區分。設計見 docs/phase2/SEGMENT_FIT.md。

ALTER TABLE hosts ADD COLUMN partner_type text
  CHECK (partner_type IS NULL OR partner_type IN ('GROUP_MOM','COMMUNITY_OWNER','KOL','OTHER'));   -- 合作對象類型；空＝未知

-- 客群輪廓（受眾，不是合作對象）
CREATE TABLE customer_segments (
  id               text PRIMARY KEY,             -- SEG-0001
  organization_id  text NOT NULL REFERENCES organizations(id),
  name             text NOT NULL,
  normalized_name  text NOT NULL,
  description      text,
  age_band         text CHECK (age_band IS NULL OR age_band IN ('U25','25_29','30_44','45_59','60P')),
  family_type      text CHECK (family_type IS NULL OR family_type IN ('SINGLE','COUPLE','PARENTING','TEEN','MULTI_GEN','EMPTY_NEST','OTHER')),
  cycle            text CHECK (cycle IS NULL OR cycle IN ('WEEKLY','BIWEEKLY','MONTHLY','QUARTERLY','OCCASIONAL')),   -- 消費週期
  price_min        bigint CHECK (price_min IS NULL OR price_min >= 0),   -- 單品團購價可接受區間（TWD）
  price_max        bigint CHECK (price_max IS NULL OR price_max >= 0),
  basis            text NOT NULL DEFAULT 'ESTIMATE' CHECK (basis IN ('FACT','ESTIMATE')),   -- 輪廓整體依據
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  updated_by       text,
  version          int NOT NULL DEFAULT 1,
  deleted_at       timestamptz,
  CHECK (price_min IS NULL OR price_max IS NULL OR price_min <= price_max)
);
CREATE UNIQUE INDEX customer_segments_name_uq ON customer_segments (organization_id, normalized_name) WHERE deleted_at IS NULL;
CREATE TRIGGER customer_segments_touch BEFORE UPDATE ON customer_segments FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER customer_segments_nodelete BEFORE DELETE ON customer_segments FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- 研究證據（觀察、訪談、問卷、訂單資料…）。FACT 必須有來源。
CREATE TABLE segment_evidence (
  id               text PRIMARY KEY,             -- EVD-000001
  organization_id  text NOT NULL REFERENCES organizations(id),
  segment_id       text NOT NULL REFERENCES customer_segments(id),
  host_id          text REFERENCES hosts(id),    -- 選填：此證據特別針對哪位團主的客群
  kind             text NOT NULL CHECK (kind IN ('OBSERVATION','INTERVIEW','SURVEY','ORDER_DATA','PLATFORM_STAT','OTHER')),
  basis            text NOT NULL DEFAULT 'ESTIMATE' CHECK (basis IN ('FACT','ESTIMATE')),
  summary          text NOT NULL,
  source_label     text,
  source_url       text,
  observed_on      date,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  updated_by       text,
  version          int NOT NULL DEFAULT 1,
  deleted_at       timestamptz,
  CHECK (basis <> 'FACT' OR source_label IS NOT NULL OR source_url IS NOT NULL)
);
CREATE INDEX segment_evidence_idx ON segment_evidence (organization_id, segment_id) WHERE deleted_at IS NULL;
CREATE TRIGGER segment_evidence_touch BEFORE UPDATE ON segment_evidence FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER segment_evidence_nodelete BEFORE DELETE ON segment_evidence FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- 需求與偏好：一列一個值（購買動機／購買阻力／偏好品類／活躍通路）。沒有任何一列＝未知。
CREATE TABLE segment_preferences (
  id               text PRIMARY KEY,             -- SPF-000001
  organization_id  text NOT NULL REFERENCES organizations(id),
  segment_id       text NOT NULL REFERENCES customer_segments(id),
  kind             text NOT NULL CHECK (kind IN ('MOTIVE','BARRIER','CATEGORY','CHANNEL')),
  value            text NOT NULL,
  normalized_value text NOT NULL,
  basis            text NOT NULL DEFAULT 'ESTIMATE' CHECK (basis IN ('FACT','ESTIMATE')),
  evidence_id      text REFERENCES segment_evidence(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  updated_by       text,
  version          int NOT NULL DEFAULT 1,
  deleted_at       timestamptz,
  CHECK (kind <> 'CHANNEL' OR value IN ('LINE','FACEBOOK','INSTAGRAM','THREADS','YOUTUBE','OTHER','OFFLINE'))
);
CREATE UNIQUE INDEX segment_preferences_uq ON segment_preferences (segment_id, kind, normalized_value) WHERE deleted_at IS NULL;
CREATE INDEX segment_preferences_idx ON segment_preferences (organization_id, segment_id) WHERE deleted_at IS NULL;
CREATE TRIGGER segment_preferences_touch BEFORE UPDATE ON segment_preferences FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER segment_preferences_nodelete BEFORE DELETE ON segment_preferences FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- 團主 ↔ 客群（多對多）；解除＝ended_at，不刪列
CREATE TABLE partner_segment_links (
  id               text PRIMARY KEY,             -- LNK-000001
  organization_id  text NOT NULL REFERENCES organizations(id),
  host_id          text NOT NULL REFERENCES hosts(id),
  segment_id       text NOT NULL REFERENCES customer_segments(id),
  community_id     text REFERENCES communities(id),   -- 選填：此客群主要在哪個社群
  share_percent    numeric(5,2) CHECK (share_percent IS NULL OR (share_percent > 0 AND share_percent <= 100)),   -- 占團主受眾比例（估計）；空＝未知
  basis            text NOT NULL DEFAULT 'ESTIMATE' CHECK (basis IN ('FACT','ESTIMATE')),
  note             text,
  ended_at         timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  updated_by       text,
  version          int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX partner_segment_links_uq ON partner_segment_links (host_id, segment_id) WHERE ended_at IS NULL;
CREATE INDEX partner_segment_links_segment_idx ON partner_segment_links (organization_id, segment_id) WHERE ended_at IS NULL;
CREATE TRIGGER partner_segment_links_touch BEFORE UPDATE ON partner_segment_links FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER partner_segment_links_nodelete BEFORE DELETE ON partner_segment_links FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- 商品適配評估：一次評估一個版本。評分內容寫入後不可改；之後只能補「覆核」「被取代」「成效回寫」。
CREATE TABLE product_fit_assessments (
  id                text PRIMARY KEY,            -- FIT-000001
  organization_id   text NOT NULL REFERENCES organizations(id),
  product_id        text NOT NULL REFERENCES products(id),
  host_id           text NOT NULL REFERENCES hosts(id),
  campaign_id       text REFERENCES campaigns(id),   -- 選填：在哪個檔期脈絡下評估
  config_version    int NOT NULL,
  config_snapshot   jsonb NOT NULL,              -- 當時的權重／門檻／別名版本
  input_hash        text NOT NULL,               -- 輸入相同就不重複建立
  total_score       numeric(5,1),                -- 只用已知維度正規化；全部未知時為空
  completeness      numeric(4,3) NOT NULL,       -- 已知權重 ÷ 全部權重
  confidence        text NOT NULL CHECK (confidence IN ('HIGH','MEDIUM','LOW','INSUFFICIENT')),
  recommendation    text NOT NULL CHECK (recommendation IN ('RECOMMEND','REVIEW','NOT_RECOMMENDED','BLOCKED','INSUFFICIENT_DATA')),
  dimensions        jsonb NOT NULL,              -- 各維度：分數或未知、依據、理由、命中項目、樣本數
  hard_checks       jsonb NOT NULL,              -- 合規／品質：PASS／FAIL／UNKNOWN
  reasons           jsonb NOT NULL,              -- 人話理由（含缺資料提醒）
  sources           jsonb NOT NULL,              -- 用了哪些客群、連結、證據、樣本筆數
  assessed_by       text,
  assessed_at       timestamptz NOT NULL DEFAULT now(),
  -- 人工覆核（可補寫）
  review_decision   text CHECK (review_decision IS NULL OR review_decision IN ('ACCEPTED','REJECTED','NEEDS_DATA')),
  review_note       text,
  reviewed_by       text,
  reviewed_at       timestamptz,
  -- 被新版取代（可補寫，只能由空變有值）
  superseded_at     timestamptz,
  superseded_by     text,
  -- 結案成效回寫（可補寫）
  outcome           jsonb,
  outcome_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           int NOT NULL DEFAULT 1,
  CHECK (review_decision IS NULL OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK (review_decision IS NULL OR review_decision = 'ACCEPTED' OR review_note IS NOT NULL)
);
CREATE UNIQUE INDEX product_fit_current_uq ON product_fit_assessments (product_id, host_id, (COALESCE(campaign_id, ''))) WHERE superseded_at IS NULL;
CREATE INDEX product_fit_product_idx ON product_fit_assessments (organization_id, product_id) WHERE superseded_at IS NULL;
CREATE INDEX product_fit_host_idx ON product_fit_assessments (organization_id, host_id) WHERE superseded_at IS NULL;
CREATE INDEX product_fit_campaign_idx ON product_fit_assessments (organization_id, campaign_id) WHERE superseded_at IS NULL;
CREATE INDEX product_fit_review_idx ON product_fit_assessments (organization_id, assessed_at) WHERE superseded_at IS NULL AND review_decision IS NULL;

CREATE FUNCTION product_fit_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.host_id IS DISTINCT FROM OLD.host_id OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
     OR NEW.config_version IS DISTINCT FROM OLD.config_version OR NEW.config_snapshot IS DISTINCT FROM OLD.config_snapshot
     OR NEW.input_hash IS DISTINCT FROM OLD.input_hash OR NEW.total_score IS DISTINCT FROM OLD.total_score
     OR NEW.completeness IS DISTINCT FROM OLD.completeness OR NEW.confidence IS DISTINCT FROM OLD.confidence
     OR NEW.recommendation IS DISTINCT FROM OLD.recommendation OR NEW.dimensions IS DISTINCT FROM OLD.dimensions
     OR NEW.hard_checks IS DISTINCT FROM OLD.hard_checks OR NEW.reasons IS DISTINCT FROM OLD.reasons
     OR NEW.sources IS DISTINCT FROM OLD.sources OR NEW.assessed_by IS DISTINCT FROM OLD.assessed_by
     OR NEW.assessed_at IS DISTINCT FROM OLD.assessed_at THEN
    RAISE EXCEPTION 'product_fit_assessments 的評分內容寫入後不可修改；請重新評估產生新版本' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.superseded_at IS NOT NULL AND (NEW.superseded_at IS DISTINCT FROM OLD.superseded_at OR NEW.superseded_by IS DISTINCT FROM OLD.superseded_by) THEN
    RAISE EXCEPTION '已被取代的評估不可再變更取代資訊' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER product_fit_guard BEFORE UPDATE ON product_fit_assessments FOR EACH ROW EXECUTE FUNCTION product_fit_guard();
CREATE TRIGGER product_fit_touch BEFORE UPDATE ON product_fit_assessments FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER product_fit_nodelete BEFORE DELETE ON product_fit_assessments FOR EACH ROW EXECUTE FUNCTION forbid_delete();
