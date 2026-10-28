-- 010 售後：案件（退款／客訴／換貨／其他）、處理紀錄（append-only）、退款申請
-- 原則：不實體刪除（案件以 CANCELLED 軟刪除）；處理紀錄不可改不可刪；買家只存去識別化代號（不存姓名／電話／地址）。

CREATE TABLE service_cases (
  id                text PRIMARY KEY,            -- CAS-000001
  organization_id   text NOT NULL REFERENCES organizations(id),
  campaign_id       text NOT NULL REFERENCES campaigns(id),
  order_id          text REFERENCES orders(id),
  case_type         text NOT NULL CHECK (case_type IN ('REFUND','COMPLAINT','EXCHANGE','OTHER')),
  status            text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','WAITING_VENDOR','RESOLVED','CLOSED','CANCELLED')),
  priority          text NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN ('LOW','MEDIUM','HIGH')),
  title             text NOT NULL,
  description       text,
  buyer_ref         text,                        -- 去識別化購買人代號
  assignee_user_id  text REFERENCES users(id),
  due_date          date,
  resolution        text,                        -- 處理結果（可對外摘要）
  internal_note     text,                        -- 內部備註：僅內部角色可見
  resolved_at       timestamptz,
  closed_at         timestamptz,
  cancelled_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text,
  updated_by        text,
  version           int NOT NULL DEFAULT 1
);
CREATE INDEX service_cases_campaign_idx ON service_cases (organization_id, campaign_id, status);
CREATE INDEX service_cases_status_idx ON service_cases (organization_id, status, due_date);
CREATE INDEX service_cases_order_idx ON service_cases (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX service_cases_assignee_idx ON service_cases (organization_id, assignee_user_id) WHERE assignee_user_id IS NOT NULL;
CREATE TRIGGER service_cases_touch BEFORE UPDATE ON service_cases FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER service_cases_nodelete BEFORE DELETE ON service_cases FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- 處理紀錄：只能新增（比照 audit_logs）。is_internal=true 的紀錄只有內部角色看得到
CREATE TABLE case_events (
  id                bigserial PRIMARY KEY,
  organization_id   text NOT NULL REFERENCES organizations(id),
  case_id           text NOT NULL REFERENCES service_cases(id),
  event_type        text NOT NULL CHECK (event_type IN ('CREATED','STATUS','NOTE','ASSIGN','UPDATE','REFUND_REQUESTED','REFUND_APPROVED','REFUND_REJECTED','REFUND_COMPLETED')),
  from_status       text,
  to_status         text,
  note              text,
  is_internal       boolean NOT NULL DEFAULT false,
  actor_user_id     text,
  actor_role        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_events_case_idx ON case_events (case_id, id);
CREATE TRIGGER case_events_immutable BEFORE UPDATE OR DELETE ON case_events FOR EACH ROW EXECUTE FUNCTION forbid_modify();

CREATE TABLE refund_requests (
  id                text PRIMARY KEY,            -- RFD-000001
  organization_id   text NOT NULL REFERENCES organizations(id),
  case_id           text NOT NULL REFERENCES service_cases(id),
  campaign_id       text NOT NULL REFERENCES campaigns(id),
  order_id          text REFERENCES orders(id),
  amount            bigint NOT NULL CHECK (amount > 0),
  reason            text NOT NULL,
  status            text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','APPROVED','REJECTED','COMPLETED')),
  requested_by      text,
  decided_by        text,
  decided_at        timestamptz,
  decision_note     text,
  completed_by      text,
  completed_at      timestamptz,
  completion_note   text,
  writeback_applied boolean NOT NULL DEFAULT false,   -- 完成時是否已把金額寫回 orders.refund_amount
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           int NOT NULL DEFAULT 1,
  CHECK (status NOT IN ('APPROVED','REJECTED','COMPLETED') OR decided_by IS NOT NULL),
  CHECK (status <> 'COMPLETED' OR completed_by IS NOT NULL),
  CHECK (NOT writeback_applied OR (status = 'COMPLETED' AND order_id IS NOT NULL))
);
CREATE INDEX refund_requests_case_idx ON refund_requests (case_id);
CREATE INDEX refund_requests_status_idx ON refund_requests (organization_id, status);
CREATE INDEX refund_requests_order_idx ON refund_requests (order_id) WHERE order_id IS NOT NULL;
CREATE TRIGGER refund_requests_touch BEFORE UPDATE ON refund_requests FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER refund_requests_nodelete BEFORE DELETE ON refund_requests FOR EACH ROW EXECUTE FUNCTION forbid_delete();
