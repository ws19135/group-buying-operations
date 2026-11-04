-- 027 已付款費用的受控更正（Owner 裁決 O-2）：已付款或部分付款的費用不可直接修改金額，只能走「受控更正」：
-- 需有財務寫入與成本檢視權限、必須填寫原因；舊值與新值完整保留在本表（不可修改、不可刪除），並寫入稽核；已確認的應收應付會退回未確認。
CREATE TABLE expense_corrections (
  id                 text PRIMARY KEY,                -- ECR-000001
  organization_id    text NOT NULL REFERENCES organizations(id),
  expense_id         text NOT NULL REFERENCES expenses(id),
  old_amount         bigint NOT NULL,
  new_amount         bigint NOT NULL CHECK (new_amount > 0),
  old_payment_status text NOT NULL,
  new_payment_status text NOT NULL,
  old_paid_amount    bigint,
  new_paid_amount    bigint,
  reason             text NOT NULL CHECK (length(btrim(reason)) >= 5),
  corrected_by       text NOT NULL REFERENCES users(id),
  corrected_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (new_amount <> old_amount OR new_paid_amount IS DISTINCT FROM old_paid_amount OR new_payment_status <> old_payment_status)
);
CREATE INDEX expense_corrections_expense_idx ON expense_corrections (organization_id, expense_id, corrected_at);
CREATE TRIGGER expense_corrections_noupdate BEFORE UPDATE ON expense_corrections FOR EACH ROW EXECUTE FUNCTION forbid_modify();
CREATE TRIGGER expense_corrections_nodelete BEFORE DELETE ON expense_corrections FOR EACH ROW EXECUTE FUNCTION forbid_delete();
