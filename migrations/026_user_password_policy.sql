-- 026 初次啟用與密碼變更（正式環境上線準備）。只新增欄位。
-- users.must_change_password 早在 001 就有（原本未使用）：由正式環境啟用流程建立的管理者帳號為 true，登入後必須先變更密碼才能使用其他功能（後端 API 同樣擋）。
ALTER TABLE users ADD COLUMN password_changed_at timestamptz;
