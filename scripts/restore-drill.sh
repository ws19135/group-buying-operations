#!/usr/bin/env bash
# 還原演練：把備份還原到「暫存資料庫」，核對資料表與筆數，再移除暫存資料庫。**不會碰來源資料庫，也不會覆蓋任何正式資料。**
# 用法：DATABASE_URL=postgres://...（來源；用於比對筆數）  ADMIN_DATABASE_URL=postgres://.../postgres（可建立資料庫的連線）  scripts/restore-drill.sh <備份檔>
set -euo pipefail
dump="${1:?用法：scripts/restore-drill.sh <備份檔.dump>}"
: "${DATABASE_URL:?需要 DATABASE_URL}"; : "${ADMIN_DATABASE_URL:?需要 ADMIN_DATABASE_URL}"
if [ -f "$dump.sha256" ]; then ( cd "$(dirname "$dump")" && sha256sum -c "$(basename "$dump").sha256" ); fi
tmp="erp_restore_drill_$$"
cleanup() { psql "$ADMIN_DATABASE_URL" -Atqc "DROP DATABASE IF EXISTS $tmp" >/dev/null 2>&1 || true; }
trap cleanup EXIT
psql "$ADMIN_DATABASE_URL" -Atqc "CREATE DATABASE $tmp"
restore_url="$(python3 - "$ADMIN_DATABASE_URL" "$tmp" <<'PY'
import sys, urllib.parse as u
p = u.urlparse(sys.argv[1]); print(u.urlunparse(p._replace(path='/' + sys.argv[2])))
PY
)"
pg_restore --no-owner --no-privileges --dbname="$restore_url" "$dump"
fail=0
for t in $(psql "$DATABASE_URL" -Atqc "select tablename from pg_tables where schemaname='public' order by 1"); do
  a="$(psql "$DATABASE_URL" -Atqc "select count(*) from \"$t\"")"; b="$(psql "$restore_url" -Atqc "select count(*) from \"$t\"")"
  if [ "$a" != "$b" ]; then echo "❌ $t 筆數不同：來源 $a／還原 $b"; fail=1; fi
done
m="$(psql "$restore_url" -Atqc "select count(*) from schema_migrations")"
echo "還原後 schema_migrations：$m 筆"
[ "$fail" = 0 ] && echo "✅ 還原演練通過：所有資料表筆數與來源一致" || { echo "❌ 還原演練失敗"; exit 1; }
