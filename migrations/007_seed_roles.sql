-- 007 角色定義（系統設定資料，不是營運資料）。權限對應見 src/server/lib/permissions.ts
INSERT INTO roles (key, name_zh, description, is_internal) VALUES
  ('SYSTEM_ADMIN', '系統管理者', '組織設定、使用者與角色、全域檢視、所有關卡核准', true),
  ('OPS_MANAGER',  '營運主管',   '跨團監控、關卡核准、取消／暫緩檔期、例外升級', true),
  ('OPS_EDITOR',   '營運小編',   '廠商／團主／商品／檔期維護與任務執行（僅自己負責的檔期）', true),
  ('HOST',         '團主',       '只能看自己被邀請的檔期、任務與業績', false),
  ('VENDOR',       '廠商',       '只能看自己廠商的商品與檔期，回填自己的任務', false),
  ('FINANCE',      '財務',       '訂單、佣金規則與結算相關（含敏感財務資料）', true)
ON CONFLICT (key) DO NOTHING;
