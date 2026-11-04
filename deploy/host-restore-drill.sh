#!/usr/bin/env bash
# 主機端還原演練：把備份還原到「暫存資料庫」（同一個 PostgreSQL 內），逐表比對筆數後移除暫存資料庫。**不會覆蓋或修改正式資料庫。**
# 用法：./host-restore-drill.sh <備份檔.dump>
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/host-common.sh"
dump="${1:?用法：./host-restore-drill.sh <備份檔.dump>}"
[ -f "$dump" ] || fail "找不到備份檔 $dump"
if [ -f "$dump.sha256" ]; then ( cd "$(dirname "$dump")" && sha256sum -c "$(basename "$dump").sha256" ) || fail "校驗碼不符"; fi
tmp="erp_restore_drill_$$"
cleanup() { C exec -T db sh -c "dropdb -U \"\$POSTGRES_USER\" --if-exists $tmp" >/dev/null 2>&1 || true; }
trap cleanup EXIT
C exec -T db sh -c "createdb -U \"\$POSTGRES_USER\" $tmp"
C exec -T db sh -c "pg_restore -U \"\$POSTGRES_USER\" --no-owner --no-privileges --dbname=$tmp" < "$dump"
bad=0
PSQL_LIVE='psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'
PSQL_TMP="psql -U \"\$POSTGRES_USER\" -d $tmp -At"
live_tables="$(echo "select tablename from pg_tables where schemaname='public' order by 1" | C exec -T db sh -c "$PSQL_LIVE")"
rest_tables="$(echo "select tablename from pg_tables where schemaname='public' order by 1" | C exec -T db sh -c "$PSQL_TMP")"
[ -n "$rest_tables" ] || fail "還原後沒有任何資料表"
# 判讀規則：資料表集合必須完全一致；還原的筆數不可「多於」現行資料庫（不可能發生，代表備份或還原有問題）；
# 少於現行是正常的（備份之後新增的資料），只列出供參考。
[ "$live_tables" = "$rest_tables" ] || { echo "❌ 資料表集合不同"; diff <(echo "$live_tables") <(echo "$rest_tables") || true; bad=1; }
newer=0
for t in $rest_tables; do
  a="$(echo "select count(*) from \"$t\"" | C exec -T db sh -c "$PSQL_LIVE")"
  b="$(echo "select count(*) from \"$t\"" | C exec -T db sh -c "$PSQL_TMP")"
  if [ "$b" -gt "$a" ]; then echo "❌ $t：還原 $b 筆多於現行 $a 筆"; bad=1
  elif [ "$b" -lt "$a" ]; then newer=$((newer+1)); echo "ℹ️  $t：備份 $b 筆／現行 $a 筆（備份之後新增）"; fi
done
m="$(echo "select count(*) from schema_migrations" | C exec -T db sh -c "$PSQL_TMP")"
echo "還原後 schema_migrations：$m 筆；備份之後有變動的資料表：$newer 個"
[ "$bad" = 0 ] && echo "✅ 還原演練通過：可還原、資料表齊全、筆數無異常" || fail "還原演練失敗"
