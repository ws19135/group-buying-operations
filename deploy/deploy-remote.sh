#!/usr/bin/env bash
# 在主機上部署指定映像：拉取 → 啟動資料庫 → 確認已初次建置 → 部署前備份 → 套用 migration → 啟動 app／proxy → 就緒檢查。
# 用法（由 deploy-production.yml 透過 SSH 呼叫，也可手動執行）：./deploy-remote.sh <映像:tag>
# 不會做的事：不執行 prod:bootstrap（初次建置要由人刻意執行）、不匯入任何資料、不改 .env.production。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/host-common.sh"
IMAGE="${1:?用法：./deploy-remote.sh <映像:tag>}"
export APP_IMAGE="$IMAGE"
confirm_checklist   # 先詢問；沒確認就停止，不做任何變更
preflight_env       # 設定檢查（必要欄位、密碼長度、不得含 DEMO 設定）
echo "== 部署映像 $IMAGE"
C pull app || fail "拉取映像失敗。私有映像需要先在主機執行一次：docker login ghcr.io（使用只有 read:packages 權限的 token；token 只輸入在主機，不要貼到聊天或 GitHub）"
C up -d db
wait_db
db_is_bootstrapped || fail "資料庫尚未初次建置。請先依 docs/DEPLOYMENT_RUNBOOK.md A-4 在主機執行 prod:bootstrap（需要 ADMIN_EMAIL／ADMIN_INITIAL_PASSWORD），再部署。"
echo "== 部署前備份"
BACKUP_DIR="${BACKUP_DIR:-./backups}" KEEP_DAYS="${KEEP_DAYS:-30}" do_backup pre-deploy >/dev/null
echo "== 套用 migration（只向前、單一交易；失敗會自動回復，資料庫維持原狀）"
C run --rm app npm run db:migrate
echo "== 啟動 app 與 proxy"
C up -d app proxy
for _ in $(seq 1 40); do
  if C exec -T app curl -fsS http://127.0.0.1:3000/api/ready >/dev/null 2>&1; then
    echo "== 就緒"; C exec -T app curl -fsS http://127.0.0.1:3000/api/health; echo; exit 0
  fi
  sleep 3
done
C logs --tail=50 app >&2 || true
fail "app 在 2 分鐘內沒有通過 /api/ready。回滾方式見 docs/ROLLBACK_PLAN.md（用上一個正常版本的 tag 再執行本腳本）。"
