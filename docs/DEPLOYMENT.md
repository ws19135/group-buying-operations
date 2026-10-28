# 本機啟動、還原與部署說明

> 範圍：本機／隔離測試環境。**未做、也不應在未經 Owner 授權下進行**：Production 部署、對外公開、真實通知、真實資料匯入。

## 1. 需求

Node.js ≥ 20（開發用 22）、PostgreSQL 16、npm。（Docker 非必要；本環境沒有 Docker daemon，直接安裝 PostgreSQL。）

## 2. 第一次啟動（可重現）

```bash
# 0. 安裝並啟動 PostgreSQL（Ubuntu 範例）
sudo apt-get install -y postgresql && sudo service postgresql start
sudo -u postgres psql -c "create user erp with password 'erp_dev_pw' createdb"
sudo -u postgres psql -c "create database erp_dev owner erp"
sudo -u postgres psql -c "create database erp_test owner erp"

# 1. 安裝依賴與設定
npm ci
cp .env.example .env.local        # 然後編輯：ADMIN_INITIAL_PASSWORD、DEMO_PASSWORD、SESSION_SECRET

# 2. 建 schema 與基礎資料（組織、預設流程模板、初始管理者；沒有任何假資料）
npm run db:migrate
npm run db:seed

# 3.（選擇性）建立 DEMO 示範資料（全部以 [DEMO] 標示，訂單 data_origin=DEMO，拒絕在 production 執行）
npm run db:seed:demo

# 4. 啟動
npm run dev                       # http://localhost:3000
# 或：npm run build && npm start
```

初始管理者的密碼只存在你的 `.env.local`（未提交）；沒設定 `ADMIN_INITIAL_PASSWORD` 時，開發環境會產生隨機密碼並只顯示一次。

## 3. 驗證指令（與 CI 相同）

```bash
npm run typecheck && npm run lint && npm test && npm run build
npm run e2e            # Playwright 煙霧測試（需先 build；用 DEMO 資料登入逐頁檢查）
npm run docs:gen       # 重新產生 docs/generated（資料字典、ERD、API 清單）
```

`npm test` 會**重建 `TEST_DATABASE_URL` 指向的資料庫**（資料庫名稱必須含 `test`，否則拒絕執行）。

## 4. 重設與還原

| 需求 | 指令 | 說明 |
|---|---|---|
| 把開發資料庫清空重來 | `npm run db:reset && npm run db:seed` | 拒絕在 `APP_ENV=production` 執行 |
| 備份 | `pg_dump -Fc -h 127.0.0.1 -U erp erp_dev > backup.dump` | 備份檔含個資時請加密保管 |
| 還原 | `createdb erp_restore && pg_restore -d erp_restore backup.dump`，再把 `DATABASE_URL` 指向它 | **還原演練尚未排入正式流程**（見 KNOWN_ISSUES） |
| 套用新 migration | `npm run db:migrate` | 已套用的檔案不可修改（checksum 會擋） |

## 5. Worker（自動化）

見 [AUTOMATION.md](AUTOMATION.md)。預設不執行任何自動化：需 `AUTOMATION_ENABLED=on`，並在 `/automation` 啟用個別工作。通知只走測試 Adapter。

## 6. 環境變數

| 變數 | 說明 |
|---|---|
| `APP_ENV` | `development`／`test`／`production`；production 會要求 `SESSION_SECRET` ≥ 32 字元、cookie 加 Secure、拒絕 DEMO 種子與資料庫重設 |
| `DATABASE_URL`／`TEST_DATABASE_URL` | PostgreSQL 連線字串 |
| `SESSION_SECRET` | 目前 session 以隨機 token＋資料庫雜湊，不依賴此值簽章；保留給後續簽章用途，production 仍要求設定 |
| `ADMIN_EMAIL`／`ADMIN_INITIAL_PASSWORD`／`ADMIN_NAME` | 僅 `db:seed` 使用 |
| `DEMO_PASSWORD` | 僅 `db:seed:demo` 使用 |
| `NOTIFY_ADAPTER` | 目前只支援 `test` |
| `AUTOMATION_ENABLED` | worker 總開關，預設 `off` |

## 7. 上線前必須另行完成（目前都沒做，且需 Owner 授權）

1. 受保護的網路環境（內網／VPN／帶驗證的反向代理）；TLS。**不得匿名公開。**
2. SSO／MFA 決策與實作；密碼重設流程。
3. 資料庫備份排程與**實際還原演練**；RPO／RTO 決定。
4. 多實例時的共用限流儲存；監控與告警（目前只有 `GET /api/health` 與 `automation_runs`）。
5. 真實通知 Adapter（LINE／Email）與憑證管理（Secret Manager）。
6. 個資盤點（本系統設計為不存姓名／電話／地址，但廠商聯絡資料、團主聯絡資料屬個資）、資料保留與刪除政策。
7. 正式資料遷移計畫（備份、試跑、差異報告、回滾演練）——見路線圖 P6。
