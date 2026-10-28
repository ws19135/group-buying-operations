-- 006 自動化：開關、執行紀錄、通知佇列、廠商進件、每日摘要

CREATE TABLE automation_settings (
  organization_id  text NOT NULL REFERENCES organizations(id),
  job_key          text NOT NULL,
  enabled          boolean NOT NULL DEFAULT false,    -- 預設全部停用；需有人明確啟用
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       text,
  PRIMARY KEY (organization_id, job_key)
);

CREATE TABLE automation_runs (
  id               text PRIMARY KEY,                  -- RUN-20261028-0001
  organization_id  text NOT NULL REFERENCES organizations(id),
  job_key          text NOT NULL,
  idempotency_key  text NOT NULL,                     -- 例如 daily:2026-10-28 / event:123
  trigger          text NOT NULL CHECK (trigger IN ('MANUAL','SCHEDULED','EVENT')),
  status           text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','SKIPPED')),
  attempts         int NOT NULL DEFAULT 1,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  error            text,
  stats            jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (organization_id, job_key, idempotency_key)
);
CREATE INDEX automation_runs_job_idx ON automation_runs (organization_id, job_key, started_at DESC);
CREATE TRIGGER automation_runs_nodelete BEFORE DELETE ON automation_runs FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE notifications (
  id               text PRIMARY KEY,                  -- NTF-20261028-000001
  organization_id  text NOT NULL REFERENCES organizations(id),
  channel          text NOT NULL CHECK (channel IN ('IN_APP','EMAIL','LINE')),
  recipient_user_id text REFERENCES users(id),
  subject          text NOT NULL,
  body             text NOT NULL,
  entity_type      text,
  entity_id        text,
  dedupe_key       text,
  status           text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','DELIVERED','SENT_TEST','FAILED','DEAD','READ')),
  attempts         int NOT NULL DEFAULT 0,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  read_at          timestamptz
);
CREATE UNIQUE INDEX notifications_dedupe_uq ON notifications (organization_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX notifications_recipient_idx ON notifications (organization_id, recipient_user_id, created_at DESC);
CREATE INDEX notifications_queue_idx ON notifications (organization_id, status) WHERE status IN ('QUEUED','FAILED');
CREATE TRIGGER notifications_nodelete BEFORE DELETE ON notifications FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- 廠商進件（對應 SOP 的「廠商填表單」）：以外部送出編號去重
CREATE TABLE vendor_intake_submissions (
  id                     text PRIMARY KEY,            -- INT-000001
  organization_id        text NOT NULL REFERENCES organizations(id),
  external_submission_id text NOT NULL,
  payload                jsonb NOT NULL,
  status                 text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','CREATED','MATCHED','NEEDS_REVIEW','REJECTED')),
  vendor_id              text REFERENCES vendors(id),
  campaign_id            text REFERENCES campaigns(id),
  note                   text,
  received_at            timestamptz NOT NULL DEFAULT now(),
  processed_at           timestamptz,
  received_by            text,
  UNIQUE (organization_id, external_submission_id)
);
CREATE TRIGGER vendor_intake_nodelete BEFORE DELETE ON vendor_intake_submissions FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE daily_summaries (
  organization_id  text NOT NULL REFERENCES organizations(id),
  summary_date     date NOT NULL,
  metrics          jsonb NOT NULL,
  generated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, summary_date)
);
CREATE TRIGGER daily_summaries_nodelete BEFORE DELETE ON daily_summaries FOR EACH ROW EXECUTE FUNCTION forbid_delete();
