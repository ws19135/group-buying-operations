# API 說明

> 完整端點清單（含是否需登入）：[generated/API_ENDPOINTS.md](generated/API_ENDPOINTS.md)，由路由表自動產生。實作：`src/server/api/routes.ts`；測試：`tests/rbac.test.ts`、`tests/scenarios.test.ts`。
> 所有路徑都在 `/api` 底下。除 `GET /health`、`POST /auth/login`、`POST /auth/logout` 外，**未登入一律 401**。

## 通用約定

| 項目 | 規則 |
|---|---|
| 成功 | `200`/`201`，body `{ "data": … }` |
| 失敗 | `{ "error": { "code", "message", "details?", "requestId" } }`；`message` 為繁體中文，可直接顯示 |
| 狀態碼 | 400 JSON 格式錯誤｜401 未登入｜403 沒有權限／跨來源請求｜404 找不到（外部角色對「不在其資料範圍內」的資料也回 404）｜405 方法不支援｜409 衝突（重複、版本過期、系統忙碌）｜412 前置條件不符（例如 Gate 檢查未過、狀態不允許）｜415 非 JSON｜422 驗證失敗｜429 登入過於頻繁／帳號暫時鎖定｜500 內部錯誤（不含內部細節，只有 requestId） |
| 驗證 | `POST /auth/login` 設定 `erp_session` cookie（HttpOnly、SameSite=Lax；production 加 Secure）。沒有 API key／匿名模式。 |
| 寫入請求 | `Content-Type: application/json`；瀏覽器請求若帶 `Origin`，必須與 `Host` 相同，否則 403 |
| 冪等 | 建立類端點（廠商、團主、社群、商品、檔期）支援 `Idempotency-Key: <任意唯一字串>`；相同 key 重送回傳第一次的結果（`replayed: true`），並發請求只會建立一筆。沒有 key 時由自然鍵唯一約束擋下（409，`details.existingId`） |
| 樂觀鎖 | 更新類端點可帶 `version`；與目前版本不同回 409，`details.currentVersion` |
| 分頁 | 列表回傳 `{ items, total, limit, offset }`；`?page=1&limit=50`（limit 上限 200） |
| 刪除 | **沒有 DELETE 方法**。封存／取消／停用都是 `POST …/archive` 等，需填原因並寫稽核 |
| 日期 | `YYYY-MM-DD`（台北日曆日）；時間戳為 ISO 8601 |
| 金額 | TWD 整數（元） |
| 追蹤 | 每個回應（含錯誤）都有 `requestId`，同值寫入稽核紀錄 |

## 端點群組與所需權限

| 群組 | 代表端點 | 需要的權限（角色） |
|---|---|---|
| 認證 | `POST /auth/login`、`/auth/logout`、`GET /auth/me` | 公開／登入者 |
| 使用者 | `GET/POST /users`、`POST /users/:id/status` | `user.manage`（管理者） |
| 廠商 | `GET/POST /vendors`、`GET/PATCH /vendors/:id`、`POST /vendors/:id/archive`、`/vendors/:id/contacts` | 讀 `vendor.read`（廠商本人可讀自己）；寫 `vendor.write` |
| 團主／社群 | `/hosts…`、`/communities…`、`/hosts/:id/availability`、`/hosts/:id/communities` | 讀 `host.read`／`community.read`（團主可讀自己）；寫 `host.write`／`community.write` |
| 商品 | `/products…`、`/skus/:id`、`/products/:id/review`、`/products/:id/assets` | 讀 `product.read`（依範圍）；寫 `product.write`；成本 `product.cost.read`；核准 `product.review` |
| 檔期 | `GET/POST /campaigns`、`GET/PATCH /campaigns/:id` | 讀 `campaign.read`（依範圍）；寫 `campaign.write`；目標／內部欄位 `campaign.sensitive.read` |
| 檔期內容 | `/campaigns/:id/products`、`/hosts`、`/placements`、`/hosts/:hostId/respond` | `campaign.write`（團主可回覆自己的邀請） |
| 日期調整 | `POST /campaigns/:id/reschedule` | `campaign.write`（已排程以後：管理者／營運主管＋原因） |
| 狀態與關卡 | `POST /campaigns/:id/status`、`GET /campaigns/:id/gates/:gate`、`POST …/gates/:gate/request`、`POST /approvals/:id/decision` | 狀態：`campaign.transition`（取消限管理者／營運主管）；申請：`approval.request`；決定：依 Gate 的核准角色 |
| 任務 | `GET /tasks`、`GET/PATCH /tasks/:id`、`POST /tasks/:id/status`、`GET /workflow/template` | 讀 `task.read`；完成 `task.complete`（負責角色）；指派／調日期 `task.write` |
| 訂單 | `GET /orders`、`GET/POST /imports`、`GET /imports/:id/errors`、`POST /import-errors/:id/resolve` | 讀 `order.read`；匯入 `order.import` |
| 佣金 | `GET/POST /commission-rules` | 讀 `commission.read`（團主僅自己的）；寫 `commission.write`（管理者、財務） |
| Dashboard | `GET /dashboard/admin?month=`、`GET /dashboard/host?hostId=&month=` | `dashboard.admin`／`dashboard.host` |
| 例外 | `GET /exceptions`、`POST /exceptions/:id/status` | `exception.read`／`exception.manage` |
| 自動化 | `GET /automation/jobs`、`POST /automation/jobs/:key {action: enable|disable|run}`、`GET /automation/runs` | `automation.manage`／`automation.run` |
| 進件 | `GET/POST /intake` | `intake.write` |
| 通知 | `GET /notifications`、`POST /notifications/:id/read`、`GET /notifications/all` | 本人；`/all` 需 `automation.manage` |
| 稽核 | `GET /audit`、`GET /campaigns/:id/audit` | `audit.read`（財務僅限財務相關實體）；檔期稽核限內部角色且在資料範圍內 |

權限與角色的完整對應：`src/server/lib/permissions.ts`；`GET /auth/me` 會回傳目前使用者的權限清單（供前端決定要顯示哪些按鈕，**後端仍會再次檢查**）。

## 範例

```bash
# 登入（保存 cookie）
curl -c jar -H 'content-type: application/json' -d '{"email":"demo-manager@example.invalid","password":"<DEMO_PASSWORD>"}' http://127.0.0.1:3000/api/auth/login

# 建立檔期（冪等）
curl -b jar -H 'content-type: application/json' -H 'Idempotency-Key: form-123' \
  -d '{"title":"秋季活動","vendorId":"VEN-0001","sampleReadyDate":"2026-11-10","openDate":"2026-12-10","closeDate":"2026-12-20"}' \
  http://127.0.0.1:3000/api/campaigns

# 日期調整：先預覽，再確認
curl -b jar -H 'content-type: application/json' -d '{"changes":{"openDate":"2026-12-12","closeDate":"2026-12-22"}}' \
  http://127.0.0.1:3000/api/campaigns/CMP-202611-0001/reschedule
curl -b jar -H 'content-type: application/json' -d '{"confirm":true,"token":"<上一步回傳的 token>","changes":{"openDate":"2026-12-12","closeDate":"2026-12-22","reason":"…"}}' \
  http://127.0.0.1:3000/api/campaigns/CMP-202611-0001/reschedule

# 匯入訂單 CSV（內容放在 JSON 的 csv 欄位）
curl -b jar -H 'content-type: application/json' --data-binary @payload.json http://127.0.0.1:3000/api/imports
```

## 訂單 CSV 格式

必要欄位：`source_order_id, campaign_id, ordered_at, status, quantity, unit_price`；可選：`sku_code, buyer_ref, host_id, community_id, refund_amount`。
`status`：`PAID`、`PENDING`、`CANCELLED`、`REFUNDED`、`PARTIAL_REFUND`。`ordered_at`：`YYYY-MM-DD HH:mm`（視為台北時間）或含時區的 ISO 8601。同一 `source_order_id` 的多列合併成一張訂單（每列一個品項）。**請勿放姓名、電話、地址**；`buyer_ref` 請用去識別化代號。
