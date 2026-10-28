-- 008 冪等鍵加上請求內容雜湊：相同 key 搭配不同內容視為誤用，回報錯誤而不是默默回傳舊結果
ALTER TABLE idempotency_keys ADD COLUMN request_hash text;
