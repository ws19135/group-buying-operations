-- 029 合作申請：承辦／交接、個資保留例外與清除紀錄（D-39、D-40、D-37）
--
-- 背景（Owner 決策 D-37～D-44）：
--  D-39  營運小編只看得到「自己承辦或被正式指派」的合作申請；沒有人承辦的案件進「待指派佇列」，不會消失。
--        → 承辦人（PRIMARY）與共同承辦（CO_OWNER）存在 collaboration_assignments；
--          每一次指派／交接／釋出寫一筆 append-only 的 collaboration_handovers。
--          collaboration_applications.owner_user_id 保留為「目前主要承辦人」的反正規化欄位（列表顯示用），
--          資料範圍判斷一律以 collaboration_assignments 為準（見 src/server/lib/scope.ts）。
--  D-40  個資保留與清除：補上「保留例外」（有依據、有期限）與「清除執行紀錄」（含失敗紀錄）。
--  不改 028 已套用的檔案；本檔只新增，不修改既有欄位語意（僅對匯入暫存列新增一個欄位）。

-- ---------------------------------------------------------------- 承辦人／共同承辦（目前狀態）
CREATE TABLE collaboration_assignments (
  id               text PRIMARY KEY,                      -- CAS-000001
  organization_id  text NOT NULL REFERENCES organizations(id),
  application_id   text NOT NULL REFERENCES collaboration_applications(id),
  user_id          text NOT NULL REFERENCES users(id),
  role             text NOT NULL CHECK (role IN ('PRIMARY','CO_OWNER')),
  assigned_at      timestamptz NOT NULL DEFAULT now(),
  assigned_by      text,
  ended_at         timestamptz,                           -- 結束承辦（交接、釋出、移除共同承辦）；不實體刪除，留下歷史
  ended_by         text,
  end_reason       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          int NOT NULL DEFAULT 1
);
-- 一筆申請同時只有一位有效的主要承辦人；同一個人在同一筆申請只會有一個有效身分
CREATE UNIQUE INDEX collab_assign_primary_uq ON collaboration_assignments (application_id) WHERE role = 'PRIMARY' AND ended_at IS NULL;
CREATE UNIQUE INDEX collab_assign_user_uq    ON collaboration_assignments (application_id, user_id) WHERE ended_at IS NULL;
CREATE INDEX collab_assign_user_idx ON collaboration_assignments (organization_id, user_id) WHERE ended_at IS NULL;
CREATE TRIGGER collab_assign_touch    BEFORE UPDATE ON collaboration_assignments FOR EACH ROW EXECUTE FUNCTION touch_row();
CREATE TRIGGER collab_assign_nodelete BEFORE DELETE ON collaboration_assignments FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------- 交接紀錄（append-only）
CREATE TABLE collaboration_handovers (
  id               bigserial PRIMARY KEY,
  organization_id  text NOT NULL REFERENCES organizations(id),
  application_id   text NOT NULL REFERENCES collaboration_applications(id),
  handover_type    text NOT NULL CHECK (handover_type IN ('ASSIGN','CLAIM','TRANSFER','RELEASE','ADD_CO_OWNER','REMOVE_CO_OWNER','BULK_REASSIGN')),
  from_user_id     text REFERENCES users(id),
  to_user_id       text REFERENCES users(id),
  reason           text,
  actor_user_id    text,
  actor_role       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- 交接與釋出一定要有原因（指派與認領可以沒有）
  CONSTRAINT collab_handover_reason CHECK (handover_type NOT IN ('TRANSFER','RELEASE','BULK_REASSIGN') OR coalesce(btrim(reason), '') <> '')
);
CREATE INDEX collab_handover_app_idx ON collaboration_handovers (application_id, id);
CREATE TRIGGER collab_handover_immutable BEFORE UPDATE OR DELETE ON collaboration_handovers FOR EACH ROW EXECUTE FUNCTION forbid_modify();

-- 回填：028 已存在、有 owner_user_id 的案件 → 正式的 PRIMARY 指派（沒有承辦人的案件自動落入待指派佇列）
INSERT INTO collaboration_assignments (id, organization_id, application_id, user_id, role, assigned_by)
SELECT 'CAS-B' || lpad(row_number() OVER (ORDER BY a.id)::text, 5, '0'), a.organization_id, a.id, a.owner_user_id, 'PRIMARY', 'migration-029'
  FROM collaboration_applications a
 WHERE a.owner_user_id IS NOT NULL AND a.deleted_at IS NULL;

-- ---------------------------------------------------------------- 個資保留例外（有依據、有期限、可解除、全程稽核）
-- 預設政策（核准後 90 天／送達後 30 天取較早）遇到爭議、法定保存義務等情況時，不能「悄悄」延後清除；
-- 必須建一筆保留例外：寫明事由與依據、設定明確的到期日（最長 365 天），到期自動失效、不會無限期保留。
-- 例外只阻止「清除」，不擴大任何人的讀取權限（廠商仍受履約期限限制）。
CREATE TABLE collaboration_retention_holds (
  id               text PRIMARY KEY,                      -- CRH-000001
  organization_id  text NOT NULL REFERENCES organizations(id),
  application_id   text NOT NULL REFERENCES collaboration_applications(id),
  reason_code      text NOT NULL CHECK (reason_code IN ('DISPUTE','LEGAL_OBLIGATION','RETURN_OR_REFUND','OWNER_APPROVED')),
  basis            text NOT NULL CHECK (char_length(btrim(basis)) >= 10),   -- 依據：案號／法條／爭議說明（不可填個資）
  placed_on        date NOT NULL,
  hold_until       date NOT NULL,
  placed_by        text NOT NULL,
  released_at      timestamptz,
  released_by      text,
  release_reason   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT collab_hold_bounded CHECK (hold_until > placed_on AND hold_until <= placed_on + 365),
  CONSTRAINT collab_hold_release_pair CHECK ((released_at IS NULL) = (released_by IS NULL))
);
CREATE INDEX collab_hold_app_idx ON collaboration_retention_holds (application_id, hold_until);
CREATE TRIGGER collab_hold_nodelete BEFORE DELETE ON collaboration_retention_holds FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- ---------------------------------------------------------------- 清除執行紀錄與逐筆結果（含失敗）
CREATE TABLE collaboration_purge_runs (
  id               bigserial PRIMARY KEY,
  organization_id  text NOT NULL REFERENCES organizations(id),
  trigger_source   text NOT NULL CHECK (trigger_source IN ('MANUAL','SCRIPT')),
  dry_run          boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED')),
  actor_user_id    text,
  candidates       int NOT NULL DEFAULT 0,
  purged           int NOT NULL DEFAULT 0,
  skipped_hold     int NOT NULL DEFAULT 0,
  skipped_fulfilment int NOT NULL DEFAULT 0,
  forced_by_cap    int NOT NULL DEFAULT 0,
  failed           int NOT NULL DEFAULT 0,
  staging_scrubbed int NOT NULL DEFAULT 0,
  error_summary    text,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);
CREATE INDEX collab_purge_run_org_idx ON collaboration_purge_runs (organization_id, id DESC);
CREATE TRIGGER collab_purge_run_nodelete BEFORE DELETE ON collaboration_purge_runs FOR EACH ROW EXECUTE FUNCTION forbid_delete();

CREATE TABLE collaboration_purge_items (
  id               bigserial PRIMARY KEY,
  run_id           bigint NOT NULL REFERENCES collaboration_purge_runs(id),
  organization_id  text NOT NULL REFERENCES organizations(id),
  recipient_id     text NOT NULL REFERENCES collaboration_recipients(id),
  application_id   text NOT NULL REFERENCES collaboration_applications(id),
  outcome          text NOT NULL CHECK (outcome IN ('PURGED','PURGED_HARD_CAP','SKIPPED_HOLD','SKIPPED_FULFILMENT','FAILED','WOULD_PURGE')),
  detail           text,                                   -- 只放原因，不放任何個資
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX collab_purge_item_run_idx ON collaboration_purge_items (run_id, id);
CREATE TRIGGER collab_purge_item_immutable BEFORE UPDATE OR DELETE ON collaboration_purge_items FOR EACH ROW EXECUTE FUNCTION forbid_modify();

-- ---------------------------------------------------------------- 匯入暫存列的個資清除標記
-- 匯入暫存列的 raw（jsonb）原本會完整留下表單二的收件人／電話／地址；建立申請單（或跳過）後立即清掉，
-- 超過 30 天仍未處理的暫存列也由清除作業清掉。此欄記錄清除時間。
ALTER TABLE collaboration_import_rows ADD COLUMN pii_scrubbed_at timestamptz;
