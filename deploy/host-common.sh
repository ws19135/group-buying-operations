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
