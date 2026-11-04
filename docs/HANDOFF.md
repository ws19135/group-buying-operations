# 交接文件（Handoff）

## 1. 需要 Owner 親自完成的事

**完整、依操作順序的清單（含設定位置、輸入內容、驗證方法）在 [`OWNER_SETUP_CHECKLIST.md`](./OWNER_SETUP_CHECKLIST.md)。**
摘要：①選主機（建議 staging＋production 各一台 VPS，台灣／東京）②網域與 DNS ③部署用 SSH 金鑰 ④GitHub Environments（staging、production）與 Secrets ⑤主機登入 ghcr ⑥主機上的 `.env.production` ⑦初次建置（`prod:bootstrap`，你親自執行一次）⑧正式管理者啟用與刪除初次密碼 ⑨備份排程與異地儲存 ⑩外部監控 ⑪財務與資安政策待決（KPI 是否並列台帳實際費用、預付款提示、MFA／SSO）。
所有機密只輸入在主機或 GitHub Secrets 欄位，**不要貼到聊天**。

## 2. 已完成（可直接使用）
三個 PR 已依序合併 `main`；`main` 程式碼；容器映像與 compose（含 HTTPS 反向代理）；`prod:bootstrap`／`prod:check`；`/api/health`、`/api/ready`；初次啟用強制變更密碼；備份與還原演練腳本；部署與回滾流程（手動核准）；Live UAT 腳本；全部文件。

## 3. 維運速查
- 看狀態：`/api/health`（版本、commit）、`/api/ready`。
- 日誌：`docker compose logs -f app proxy`。
- 稽核：系統內 `/audit`（系統管理者）。
- 常見問題：忘記密碼→管理者在 `/users` 重設；登入被鎖→15 分鐘後或管理者處理；`/api/ready` 回 409→有 migration 尚未套用。

## 4. 文件索引
`PRODUCTION_ARCHITECTURE`、`ENVIRONMENT_MATRIX`、`DEPLOYMENT_RUNBOOK`、`BACKUP_RESTORE_RUNBOOK`、`ROLLBACK_PLAN`、`PRODUCTION_UAT`、`SECURITY_REVIEW`、`FEATURE_STATUS_MATRIX`（功能驗收矩陣）、`TEST_REPORT`、`KNOWN_ISSUES`、`DEVELOPMENT_LOG`。
