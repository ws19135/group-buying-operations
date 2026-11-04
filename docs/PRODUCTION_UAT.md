# 正式系統操作驗收（Live UAT）

## 方法與邊界
- 腳本：`scripts/prod-uat.ts`（20 個驗收項目，HTTP 對實際運行的系統操作）、`scripts/prod-uat-verify.ts`（重新部署後資料不遺失）。
- **隔離**：所有資料以 `[UAT-<日期>-<碼>]` 標示；腳本寫入前會檢查目標環境：若已有任何「不是 UAT 標示」的廠商／團主／商品，**立即拒絕**；結束時只做軟刪除／作廢／停用測試帳號（沒有實體刪除）。
- **只在預備環境執行**（與正式相同的映像、獨立的空資料庫）。正式環境**不執行**會寫入資料的 UAT：正式環境一旦有真實資料，就不得被 UAT 或 DEMO 資料污染；正式環境只做唯讀煙霧檢查（`/api/health`、`/api/ready`、登入頁、未登入 401）。
- 不觸發真實付款、通知、結算確認；沒有外部連線。密碼由環境變數提供且不印出（測試帳號密碼為隨機）。

## 本次執行結果（本機 production 模式＋全新空資料庫；**不是**正式主機）

| 項目 | 結果 |
|---|---|
| 目標 | 本機 `next start`（APP_ENV=production）＋空 PostgreSQL（`prod:bootstrap` 建置，27 支 migration，demoRows=0）；HTTP（本機無 TLS） |
| 結果 | **21/21 通過**（20 個驗收項目＋未登入 401 檢查）；重新部署（重啟程序、版本號變更）後資料仍在（廠商／檔期／試用／訂單 5 筆） |
| 覆蓋 | 入口與健康／就緒；登入與**初次啟用強制變更密碼**；角色權限差異；商品、廠商、團主建檔；建立檔期；選品評估；試用案件；導購資料；**第二人查核（自查被擋）**；KPI（八項齊全、CVR、每單貢獻利潤口徑）；商業可行性；匯入 5 筆測試訂單；物流與售後；財務差異查核；費用資料權限；未授權角色 403；稽核紀錄；重新部署後資料不遺失 |
| 結果檔 | 執行時由 `UAT_RESULT_FILE` 指定輸出（本次未提交，因含測試帳號信箱）；指令與預期見上 |

## 在預備／正式主機建立後的重跑方式
```bash
BASE_URL=https://<預備網域> UAT_ALLOW_WRITE=yes UAT_ADMIN_EMAIL=<管理者> UAT_ADMIN_PASSWORD=<初始密碼> UAT_ADMIN_NEW_PASSWORD=<新密碼> npx tsx scripts/prod-uat.ts
# 重新部署後：
BASE_URL=... UAT_ADMIN_EMAIL=... UAT_ADMIN_PASSWORD=<新密碼> UAT_SNAPSHOT_FILE=uat-snapshot-<id>.json npx tsx scripts/prod-uat-verify.ts
```
**LIVE_VERIFIED 的定義**：在真正的預備／正式網域（HTTPS）上以上述腳本通過。目前所有功能只到「本機 production 模式驗證」，**尚未 LIVE_VERIFIED**。
