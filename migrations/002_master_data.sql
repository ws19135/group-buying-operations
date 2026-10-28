-- 002 主檔：團主、社群、廠商、商品、SKU、合作協議

CREATE TABLE hosts (
  id               text PRIMARY KEY,             -- OWN-0001
  organization_id  text NOT NULL REFERENCES organizations(id),
  display_name     text NOT NULL,
  normalized_name  text NOT NULL,
  legal_name       text,
  contact_email    text,
  contact_phone    text,
  line_id          text,
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','ENDED')),
  audience_note    text,                          -- 客群描述
  cooperation_terms text,                         -- 合作條件（文字）
  internal_note    text,                          -- 內部備註（團主/廠商不可見）
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  updated_by       text,
  version          int NOT NULL DEFAULT 1,
  deleted_at       timestamptz
);
CREATE UNIQUE INDEX hosts_name_uq ON hosts (organization_id, normalized_name) WHERE deleted_at IS NULL;
CREATE TRIGGER hosts_touch BEFORE UPDATE ON hosts FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER hosts_nodelete BEFORE DELETE ON hosts FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- 團主可承接 / 不可承接的檔期區間
CREATE TABLE host_availability (
  id               text PRIMARY KEY,             -- AVL-000001
  organization_id  text NOT NULL REFERENCES organizations(id),
  host_id          text NOT NULL REFERENCES hosts(id),
  start_date       date NOT NULL,
  end_date         date NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('AVAILABLE','BLOCKED')),
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  updated_by       text,
  version          int NOT NULL DEFAULT 1,
  deleted_at       timestamptz,
  CHECK (start_date <= end_date)
);
CREATE INDEX host_avail_idx ON host_availability (organization_id, host_id, start_date, end_date);
CREATE TRIGGER host_avail_touch BEFORE UPDATE ON host_availability FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER host_avail_nodelete BEFORE DELETE ON host_availability FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE communities (
  id               text PRIMARY KEY,             -- GRP-0001
  organization_id  text NOT NULL REFERENCES organizations(id),
  platform         text NOT NULL CHECK (platform IN ('LINE','FACEBOOK','INSTAGRAM','THREADS','YOUTUBE','OTHER')),
  name             text NOT NULL,
  normalized_name  text NOT NULL,
  url              text,
  member_count     int CHECK (member_count IS NULL OR member_count >= 0),
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','ENDED')),
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  updated_by       text,
  version          int NOT NULL DEFAULT 1,
  deleted_at       timestamptz
);
CREATE UNIQUE INDEX communities_name_uq ON communities (organization_id, platform, normalized_name) WHERE deleted_at IS NULL;
CREATE TRIGGER communities_touch BEFORE UPDATE ON communities FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER communities_nodelete BEFORE DELETE ON communities FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE host_communities (
  organization_id  text NOT NULL REFERENCES organizations(id),
  host_id          text NOT NULL REFERENCES hosts(id),
  community_id     text NOT NULL REFERENCES communities(id),
  role             text NOT NULL DEFAULT 'OWNER' CHECK (role IN ('OWNER','ADMIN','MEMBER')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  ended_at         timestamptz,
  PRIMARY KEY (host_id, community_id)
);
CREATE INDEX host_comm_comm_idx ON host_communities (community_id);
CREATE TRIGGER host_comm_nodelete BEFORE DELETE ON host_communities FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE vendors (
  id                 text PRIMARY KEY,           -- VEN-0001
  organization_id    text NOT NULL REFERENCES organizations(id),
  name               text NOT NULL,              -- 廠商／品牌名稱（消費者認得的名字）
  normalized_name    text NOT NULL,
  company_name       text,                       -- 公司全名（開立發票用）
  tax_id             text,
  category           text,
  website            text,
  status             text NOT NULL DEFAULT 'PROSPECT'
                     CHECK (status IN ('PROSPECT','CONTACTED','ACTIVE','PAUSED','BLACKLISTED')),
  cooperation_note   text,
  internal_note      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         text,
  updated_by         text,
  version            int NOT NULL DEFAULT 1,
  deleted_at         timestamptz
);
CREATE UNIQUE INDEX vendors_name_uq ON vendors (organization_id, normalized_name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX vendors_tax_uq ON vendors (organization_id, tax_id) WHERE deleted_at IS NULL AND tax_id IS NOT NULL;
CREATE TRIGGER vendors_touch BEFORE UPDATE ON vendors FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER vendors_nodelete BEFORE DELETE ON vendors FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE vendor_contacts (
  id               text PRIMARY KEY,             -- VCT-000001
  organization_id  text NOT NULL REFERENCES organizations(id),
  vendor_id        text NOT NULL REFERENCES vendors(id),
  name             text NOT NULL,
  title            text,
  email            text,
  phone            text,
  line_id          text,
  is_primary       boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  updated_by       text,
  version          int NOT NULL DEFAULT 1,
  deleted_at       timestamptz
);
CREATE INDEX vendor_contacts_idx ON vendor_contacts (organization_id, vendor_id);
CREATE UNIQUE INDEX vendor_contacts_primary_uq ON vendor_contacts (vendor_id) WHERE is_primary AND deleted_at IS NULL;
CREATE TRIGGER vendor_contacts_touch BEFORE UPDATE ON vendor_contacts FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER vendor_contacts_nodelete BEFORE DELETE ON vendor_contacts FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE products (
  id               text PRIMARY KEY,             -- PRD-000001
  organization_id  text NOT NULL REFERENCES organizations(id),
  vendor_id        text NOT NULL REFERENCES vendors(id),
  name             text NOT NULL,
  normalized_name  text NOT NULL,
  category         text,
  description      text,
  listing_url      text,                          -- 品項介紹連結
  selling_points   text,                          -- 賣點
  compliance_note  text,                          -- 檢驗報告／認證／法規備註
  review_status    text NOT NULL DEFAULT 'DRAFT'
                   CHECK (review_status IN ('DRAFT','PENDING_REVIEW','APPROVED','REJECTED')),
  review_note      text,
  reviewed_by      text,
  reviewed_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  updated_by       text,
  version          int NOT NULL DEFAULT 1,
  deleted_at       timestamptz
);
CREATE UNIQUE INDEX products_name_uq ON products (organization_id, vendor_id, normalized_name) WHERE deleted_at IS NULL;
CREATE INDEX products_vendor_idx ON products (organization_id, vendor_id);
CREATE TRIGGER products_touch BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER products_nodelete BEFORE DELETE ON products FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE product_assets (
  id               text PRIMARY KEY,             -- AST-000001
  organization_id  text NOT NULL REFERENCES organizations(id),
  product_id       text NOT NULL REFERENCES products(id),
  kind             text NOT NULL CHECK (kind IN ('IMAGE','DOCUMENT','CERTIFICATE','LINK','OTHER')),
  title            text NOT NULL,
  url              text NOT NULL,
  status           text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','APPROVED','REJECTED')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  updated_by       text,
  version          int NOT NULL DEFAULT 1,
  deleted_at       timestamptz
);
CREATE INDEX product_assets_idx ON product_assets (organization_id, product_id);
CREATE TRIGGER product_assets_touch BEFORE UPDATE ON product_assets FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER product_assets_nodelete BEFORE DELETE ON product_assets FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE skus (
  id               text PRIMARY KEY,             -- SKU-000001
  organization_id  text NOT NULL REFERENCES organizations(id),
  product_id       text NOT NULL REFERENCES products(id),
  sku_code         text NOT NULL,                -- 廠商端規格編號，同商品內唯一
  name             text NOT NULL,                -- 規格名稱
  list_price       bigint CHECK (list_price IS NULL OR list_price >= 0),   -- 原價（TWD 整數）
  group_price      bigint CHECK (group_price IS NULL OR group_price >= 0), -- 團購價
  cost_price       bigint CHECK (cost_price IS NULL OR cost_price >= 0),   -- 成本（敏感：財務權限）
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  updated_by       text,
  version          int NOT NULL DEFAULT 1,
  deleted_at       timestamptz
);
CREATE UNIQUE INDEX skus_code_uq ON skus (product_id, lower(sku_code)) WHERE deleted_at IS NULL;
CREATE INDEX skus_org_idx ON skus (organization_id, product_id);
CREATE TRIGGER skus_touch BEFORE UPDATE ON skus FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER skus_nodelete BEFORE DELETE ON skus FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- 合作協議（Phase 1 只建立契約／Schema，尚無 CRUD 介面）
CREATE TABLE agreements (
  id               text PRIMARY KEY,             -- AGR-0001
  organization_id  text NOT NULL REFERENCES organizations(id),
  vendor_id        text NOT NULL REFERENCES vendors(id),
  title            text NOT NULL,
  terms            text,
  commission_note  text,
  effective_from   date,
  effective_to     date,
  status           text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','EXPIRED','TERMINATED')),
  document_url     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  updated_by       text,
  version          int NOT NULL DEFAULT 1,
  deleted_at       timestamptz
);
CREATE TRIGGER agreements_touch BEFORE UPDATE ON agreements FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER agreements_nodelete BEFORE DELETE ON agreements FOR EACH ROW EXECUTE FUNCTION forbid_delete();
