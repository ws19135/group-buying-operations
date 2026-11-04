# 交接文件（Handoff）

## 1. 需要 Owner 親自完成的事（一次列出；完成前正式環境無法上線）

| # | 事項 | 為什麼只能 Owner 做 |
|---|---|---|
| 1 | **選定並開通主機／雲端帳號**（建議：台灣或東京機房的 VPS＋Docker；或經核准的付費託管方案） | 涉及付費承諾與帳號開通 |
| 2 | **網域與 DNS**（例如 `erp.<公司網域>` 指向主機） | 網域購買與 DNS 控制權 |
| 3 | **環境密鑰**：在主機建立 `.env.production`（`POSTGRES_PASSWORD` 長且隨機、`ADMIN_EMAIL`＝真實公司信箱、`ADMIN_INITIAL_PASSWORD`＝隨機初始密碼） | 密鑰不可由代理人持有或寫入文件 |
| 4 | **GitHub Environment `production`**：設定 Required reviewers（核准人）、Secrets（`DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`、`DEPLOY_PATH`）、Variable `ERP_URL`；建議同時為 `main` 開啟 Branch protection（要求 CI `verify`） | 正式部署金鑰與核准權限 |
| 5 | **正式管理者啟用**：依 `DEPLOYMENT_RUNBOOK.md` A-4～A-6 執行 `prod:bootstrap`，管理者第一次登入時自行設定新密碼，再建立真實使用者與角色（不由代理人建立真實使用者） | 真實人員與權限授權 |
| 6 | 備份：提供異地備份儲存空間與保留政策；在主機設定 cron；完成第一次正式還原演練 | 儲存空間與政策 |
| 7 | 外部健康監控服務與告警接收人 | 帳號與通知對象 |
| 8 | 在預備環境（HTTPS）重跑 Live UAT 並簽核（`PRODUCTION_UAT.md`） | 驗收簽核 |
| 9 | 財務政策仍待裁決的事項（見 `FINAL_PREMERGE_REVIEW.md` §4 的 O-1 後續：KPI 是否改為並列台帳實際費用；O-3：預付款是否需要提示）；MFA／SSO 是否要做 | 財務與資安政策 |

## 2. 已完成（可直接使用）
三個 PR 已依序合併 `main`；`main` 程式碼；容器映像與 compose（含 HTTPS 反向代理）；`prod:bootstrap`／`prod:check`；`/api/health`、`/api/ready`；初次啟用強制變更密碼；備份與還原演練腳本；部署與回滾流程（手動核准）；Live UAT 腳本；全部文件。

## 3. 維運速查
- 看狀態：`/api/health`（版本、commit）、`/api/ready`。
- 日誌：`docker compose logs -f app proxy`。
- 稽核：系統內 `/audit`（系統管理者）。
- 常見問題：忘記密碼→管理者在 `/users` 重設；登入被鎖→15 分鐘後或管理者處理；`/api/ready` 回 409→有 migration 尚未套用。

## 4. 文件索引
`PRODUCTION_ARCHITECTURE`、`ENVIRONMENT_MATRIX`、`DEPLOYMENT_RUNBOOK`、`BACKUP_RESTORE_RUNBOOK`、`ROLLBACK_PLAN`、`PRODUCTION_UAT`、`SECURITY_REVIEW`、`FEATURE_STATUS_MATRIX`（功能驗收矩陣）、`TEST_REPORT`、`KNOWN_ISSUES`、`DEVELOPMENT_LOG`。
