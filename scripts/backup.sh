#!/usr/bin/env bash
# 資料庫備份（pg_dump 自訂格式）＋ SHA-256 校驗 ＋ 保留期限。備份檔含商業資料：請加密保管並限制權限。
# 用法：DATABASE_URL=postgres://... BACKUP_DIR=/var/backups/erp KEEP_DAYS=30 scripts/backup.sh
set -euo pipefail
: "${DATABASE_URL:?需要 DATABASE_URL}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"; KEEP_DAYS="${KEEP_DAYS:-30}"
umask 077; mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"; file="$BACKUP_DIR/erp-$stamp.dump"
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" > "$file"
( cd "$BACKUP_DIR" && sha256sum "$(basename "$file")" > "$(basename "$file").sha256" )
# 立即驗證備份檔可被讀取（列出目錄；不還原）
pg_restore --list "$file" > /dev/null
find "$BACKUP_DIR" -name 'erp-*.dump*' -mtime +"$KEEP_DAYS" -delete
echo "備份完成：$file（$(du -h "$file" | cut -f1)）"
