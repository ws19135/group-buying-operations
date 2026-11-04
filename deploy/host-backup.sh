#!/usr/bin/env bash
# 主機端每日備份（給 cron 用）。例：0 3 * * * /opt/erp/host-backup.sh >> /var/log/erp-backup.log 2>&1
# 環境變數：BACKUP_DIR（預設 ./backups）、KEEP_DAYS（預設 30）。備份檔含商業資料：權限 600，請另外加密並異地保存。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/host-common.sh"
db_is_bootstrapped || fail "資料庫尚未初次建置，沒有可備份的內容"
do_backup erp
