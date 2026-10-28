-- 001 基礎：組織、角色、使用者、工作階段、ID 計數器、稽核、冪等、事件
-- 原則：所有業務表都有 organization_id；不做實體刪除（軟刪除）；稽核表不可改不可刪。

CREATE TABLE organizations (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  timezone      text NOT NULL DEFAULT 'Asia/Taipei',
  currency      text NOT NULL DEFAULT 'TWD',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       int NOT NULL DEFAULT 1
);

-- 通用：更新時自動遞增 version 與 updated_at
CREATE FUNCTION touch_row() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  NEW.version := OLD.version + 1;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- 通用：禁止實體刪除（以 deleted_at / status 軟刪除）
CREATE FUNCTION forbid_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'physical delete forbidden on %: use soft delete', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$ LANGUAGE plpgsql;

-- 稽核表不可改、不可刪
CREATE FUNCTION forbid_modify() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$ LANGUAGE plpgsql;

CREATE TABLE roles (
  key          text PRIMARY KEY,
  name_zh      text NOT NULL,
  description  text NOT NULL DEFAULT '',
  is_internal  boolean NOT NULL DEFAULT true
);

CREATE TABLE users (
  id                 text PRIMARY KEY,
  organization_id    text NOT NULL REFERENCES organizations(id),
  email              text NOT NULL,
  name               text NOT NULL,
  role_key           text NOT NULL REFERENCES roles(key),
  password_hash      text NOT NULL,
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  failed_login_count int NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  last_login_at      timestamptz,
  must_change_password boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         text,
  updated_by         text,
  version            int NOT NULL DEFAULT 1,
  deleted_at         timestamptz
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE deleted_at IS NULL;
CREATE INDEX users_org_idx ON users (organization_id);
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER users_nodelete BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- 資料範圍：團主帳號綁 HOST、廠商帳號綁 VENDOR；scope_id 為該實體的穩定 ID
CREATE TABLE user_scopes (
  user_id     text NOT NULL REFERENCES users(id),
  scope_type  text NOT NULL CHECK (scope_type IN ('HOST','VENDOR','COMMUNITY')),
  scope_id    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text,
  revoked_at  timestamptz,
  PRIMARY KEY (user_id, scope_type, scope_id)
);
CREATE INDEX user_scopes_scope_idx ON user_scopes (scope_type, scope_id);
CREATE TRIGGER user_scopes_nodelete BEFORE DELETE ON user_scopes FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE sessions (
  token_hash   text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  ip           text,
  user_agent   text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- ID 產生器：key 例如 'VEN'、'CMP'；period 例如 '202610' 或 ''（不分期）
CREATE TABLE id_counters (
  key     text NOT NULL,
  period  text NOT NULL DEFAULT '',
  n       bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (key, period)
);

CREATE TABLE audit_logs (
  id               bigserial PRIMARY KEY,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  organization_id  text,
  actor_user_id    text,
  actor_role       text,
  actor_type       text NOT NULL DEFAULT 'USER' CHECK (actor_type IN ('USER','SYSTEM')),
  action           text NOT NULL,
  entity_type      text NOT NULL,
  entity_id        text NOT NULL,
  campaign_id      text,
  before_data      jsonb,
  after_data       jsonb,
  reason           text,
  request_id       text,
  source           text NOT NULL DEFAULT 'WEB',
  ip               text
);
CREATE INDEX audit_entity_idx ON audit_logs (organization_id, entity_type, entity_id);
CREATE INDEX audit_campaign_idx ON audit_logs (organization_id, campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX audit_time_idx ON audit_logs (organization_id, occurred_at DESC);
CREATE TRIGGER audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_modify();

-- 重複送出保護：同一個 scope + key 只會處理一次
CREATE TABLE idempotency_keys (
  scope        text NOT NULL,
  key          text NOT NULL,
  organization_id text NOT NULL,
  response     jsonb,
  status_code  int,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, scope, key)
);

CREATE TABLE system_settings (
  organization_id text NOT NULL REFERENCES organizations(id),
  key             text NOT NULL,
  value           jsonb NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      text,
  PRIMARY KEY (organization_id, key)
);

-- 領域事件（Transactional Outbox）：與業務資料同一個交易寫入，由 worker 處理
CREATE TABLE events (
  id               bigserial PRIMARY KEY,
  organization_id  text NOT NULL,
  type             text NOT NULL,
  entity_type      text NOT NULL,
  entity_id        text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key       text,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  attempts         int NOT NULL DEFAULT 0,
  last_error       text
);
CREATE UNIQUE INDEX events_dedupe_uq ON events (organization_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX events_pending_idx ON events (organization_id, id) WHERE processed_at IS NULL;
CREATE TRIGGER events_nodelete BEFORE DELETE ON events FOR EACH ROW EXECUTE FUNCTION forbid_delete();
