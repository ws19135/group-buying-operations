-- 004 工作流程：模板（版本化）、任務、相依關係

CREATE TABLE workflow_templates (
  id               text PRIMARY KEY,             -- WFT-0001
  organization_id  text NOT NULL REFERENCES organizations(id),
  key              text NOT NULL,                -- 例如 GROUPBUY_STANDARD
  version          int NOT NULL,                 -- 模板版本（另有 row version 欄位 row_version）
  name             text NOT NULL,
  description      text,
  status           text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  params           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- 預設天數參數
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text,
  UNIQUE (organization_id, key, version)
);
CREATE TRIGGER workflow_templates_nodelete BEFORE DELETE ON workflow_templates FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE workflow_template_steps (
  template_id   text NOT NULL REFERENCES workflow_templates(id),
  step_key      text NOT NULL,
  seq           int NOT NULL,
  name          text NOT NULL,
  phase         int NOT NULL CHECK (phase BETWEEN 1 AND 8),   -- ERP 八階段（見 docs/adr/ADR-004）
  owner_role    text NOT NULL REFERENCES roles(key),
  kind          text NOT NULL DEFAULT 'TASK' CHECK (kind IN ('TASK','GATE','MILESTONE')),
  gate_key      text CHECK (gate_key IS NULL OR gate_key IN ('G1','G2','G3','G4','G5')),
  start_rule    jsonb NOT NULL,
  duration      jsonb NOT NULL,
  depends_on    text[] NOT NULL DEFAULT '{}',
  optional      boolean NOT NULL DEFAULT false,
  condition_key text,                            -- 例如 needs_sample_recovery / has_live_talk
  description   text,
  PRIMARY KEY (template_id, step_key)
);
CREATE TRIGGER workflow_template_steps_nodelete BEFORE DELETE ON workflow_template_steps FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE tasks (
  id                text PRIMARY KEY,            -- TSK-20261028-0001
  organization_id   text NOT NULL REFERENCES organizations(id),
  campaign_id       text NOT NULL REFERENCES campaigns(id),
  step_key          text NOT NULL,
  name              text NOT NULL,
  phase             int NOT NULL CHECK (phase BETWEEN 1 AND 8),
  seq               int NOT NULL,
  owner_role        text NOT NULL REFERENCES roles(key),
  assignee_user_id  text REFERENCES users(id),
  kind              text NOT NULL DEFAULT 'TASK' CHECK (kind IN ('TASK','GATE','MILESTONE')),
  gate_key          text CHECK (gate_key IS NULL OR gate_key IN ('G1','G2','G3','G4','G5')),
  status            text NOT NULL DEFAULT 'TODO' CHECK (status IN
                      ('TODO','IN_PROGRESS','BLOCKED','WAITING_APPROVAL','DONE','SKIPPED','CANCELLED')),
  planned_start     date,
  planned_end       date,
  actual_start      date,
  completed_at      timestamptz,
  completed_by      text,
  date_locked       boolean NOT NULL DEFAULT false,   -- 人工確認過的日期，自動重排不得覆寫
  date_lock_reason  text,
  optional          boolean NOT NULL DEFAULT false,
  skip_reason       text,
  blocker_reason    text,
  evidence_url      text,
  evidence_note     text,
  schedule_issue    text,                             -- 排程無法計算的原因（缺少錨點日期）
  overdue_flagged_at timestamptz,
  template_version  int,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text,
  updated_by        text,
  version           int NOT NULL DEFAULT 1,
  UNIQUE (campaign_id, step_key)
);
CREATE INDEX tasks_org_status_idx ON tasks (organization_id, status, planned_end);
CREATE INDEX tasks_assignee_idx ON tasks (organization_id, assignee_user_id) WHERE assignee_user_id IS NOT NULL;
CREATE INDEX tasks_campaign_idx ON tasks (organization_id, campaign_id, seq);
CREATE TRIGGER tasks_touch BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER tasks_nodelete BEFORE DELETE ON tasks FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE task_dependencies (
  task_id             text NOT NULL REFERENCES tasks(id),
  depends_on_task_id  text NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);
CREATE TRIGGER task_dependencies_nodelete BEFORE DELETE ON task_dependencies FOR EACH ROW EXECUTE FUNCTION forbid_delete();
