#!/usr/bin/env bash
# 主機端共用函式（在 DEPLOY_PATH 內執行；由 deploy-remote.sh、host-backup.sh、host-restore-drill.sh 引用）。
# 設計：資料庫只在 compose 內部網路，所以備份／還原一律透過 `docker compose exec db` 執行，不需要在主機安裝 PostgreSQL 或開放連接埠。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
ENV_FILE="${ENV_FILE:-.env.production}"
fail() { echo "❌ $*" >&2; exit 1; }
[ -f "$ENV_FILE" ] || fail "找不到 $ENV_FILE（請依 .env.production.example 在主機建立，權限 600，不要提交到 GitHub）"
perm="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")"
case "$perm" in 600|400) ;; *) fail "$ENV_FILE 權限是 $perm，必須是 600（chmod 600 $ENV_FILE）";; esac
C() { docker compose --env-file "$ENV_FILE" -f docker-compose.prod.yml "$@"; }

wait_db() {
  for _ in $(seq 1 60); do
    if C exec -T db sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  fail "資料庫 2 分鐘內沒有就緒"
}

# 是否已完成初次建置（schema_migrations 存在）
db_is_bootstrapped() {
  local r
  r="$(echo "SELECT to_regclass('public.schema_migrations') IS NOT NULL" | C exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At')"
  [ "$r" = "t" ]
}

# 備份：pg_dump 自訂格式 → 檔案 → SHA-256 → 以 pg_restore --list 驗證可讀 → 依保留天數清理。檔案權限 600。
do_backup() {
  local prefix="${1:-erp}" dir="${BACKUP_DIR:-./backups}" keep="${KEEP_DAYS:-30}"
  umask 077; mkdir -p "$dir"
  local file="$dir/$prefix-$(date -u +%Y%m%dT%H%M%SZ).dump"
  C exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" --format=custom --no-owner --no-privileges "$POSTGRES_DB"' > "$file"
  [ -s "$file" ] || { rm -f "$file"; fail "備份檔是空的"; }
  ( cd "$dir" && sha256sum "$(basename "$file")" > "$(basename "$file").sha256" )
  C exec -T db pg_restore --list < "$file" >/dev/null || { fail "備份檔無法被 pg_restore 讀取：$file"; }
  find "$dir" -name "$prefix-*.dump*" -mtime +"$keep" -delete
  echo "備份完成：$file（$(du -h "$file" | cut -f1)）" >&2
  printf '%s\n' "$file"
}

env_get() { # 取 .env.production 的值（不印出、不 source）
  grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -e 's/[[:space:]]*#.*$//' -e 's/^"//' -e 's/"$//' || true
}

# 設定檢查：不通過就停止（不會做任何變更）
preflight_env() {
  local k v bad=0
  for k in ERP_DOMAIN POSTGRES_USER POSTGRES_DB POSTGRES_PASSWORD; do
    [ -n "$(env_get $k)" ] || { echo "❌ $ENV_FILE 缺少 $k" >&2; bad=1; }
  done
  v="$(env_get ERP_DOMAIN)"; case "$v" in *example*|"") echo "❌ ERP_DOMAIN 還是範本值或空白：$v" >&2; bad=1;; esac
  v="$(env_get POSTGRES_PASSWORD)"; [ "${#v}" -ge 24 ] || { echo "❌ POSTGRES_PASSWORD 長度不足 24 字元（請用 openssl rand -base64 36 產生）" >&2; bad=1; }
  grep -qE '^(ALLOW_DEMO_IN_PRODUCTION|DEMO_PASSWORD)=' "$ENV_FILE" && { echo "❌ $ENV_FILE 含有 DEMO 設定，正式／預備環境不可使用" >&2; bad=1; }
  [ "$bad" = 0 ] || fail "設定檢查未通過，請依 docs/OWNER_SETUP_CHECKLIST.md 步驟 7 修正後再執行"
}

# 先詢問是否已依 docs/OWNER_SETUP_CHECKLIST.md 設置。互動：輸入 yes；非互動（CI）：必須明確給 CONFIRM_CHECKLIST=yes。其他一律停止。
confirm_checklist() {
  [ "${CONFIRM_CHECKLIST:-}" = yes ] && return 0
  if [ ! -t 0 ] || [ ! -t 1 ]; then
    fail "部署前需要確認已依 docs/OWNER_SETUP_CHECKLIST.md 設置。非互動環境請明確設定 CONFIRM_CHECKLIST=yes（由 GitHub 部署工作流程的確認欄位帶入）。"
  fi
  cat <<'MSG'

即將部署到這台主機。請先確認已依 docs/OWNER_SETUP_CHECKLIST.md 完成：
  1) 主機與防火牆（只開 22／80／443）   2) Docker 與部署帳號   3) 網域 DNS 已指向本主機
  4) 部署用 SSH 金鑰   5) GitHub Environments 與 Secrets   6) 本機已登入 ghcr.io
  7) .env.production（權限 600、密碼為隨機值）   8) 初次建置（prod:bootstrap）已由你親自執行
  （部署 production 前：staging 已通過 Live UAT 與備份還原演練）
MSG
  local ans; read -r -p "以上都已照步驟設置完成嗎？輸入 yes 繼續，其他任何輸入都會停止：" ans
  [ "$ans" = yes ] || fail "已停止：尚未確認依清單設置。"
}
