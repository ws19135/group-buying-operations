# 備份與還原手冊

## 備份
- 工具：`scripts/backup.sh`（`pg_dump` 自訂格式＋SHA-256 校驗＋立即以 `pg_restore --list` 驗證可讀＋保留期限 `KEEP_DAYS`，預設 30 天）。
- 排程（主機 cron，每日一次，建議離峰時段）：`0 3 * * * DATABASE_URL=... BACKUP_DIR=/var/backups/erp /opt/erp/scripts/backup.sh >> /var/log/erp-backup.log 2>&1`
- 備份檔含商業資料：目錄權限 700、檔案 600；異地保存並加密（建議另存到不同機房／不同帳號的儲存空間）。
- 目標：RPO ≤ 24 小時（每日備份）；若要更低，需啟用 PostgreSQL WAL 歸檔（Owner 決定）。RTO 目標 ≤ 4 小時（本演練實測見下）。

## 還原演練（不碰正式資料）
`DATABASE_URL=<來源> ADMIN_DATABASE_URL=<可建立資料庫的連線> scripts/restore-drill.sh <備份檔>`：驗證校驗碼 → 還原到暫存資料庫 → 逐表比對筆數 → 移除暫存資料庫。建議**每月至少一次**，並在每次含 migration 的版本更新前做一次。

**本次演練證據（預備環境本機、含 UAT 資料）**：備份 620 KB；校驗碼 OK；還原後 `schema_migrations` 27 筆；所有資料表筆數與來源一致；暫存資料庫已清除。

## 真正的災難復原（正式環境資料遺失或損毀）
1. 停止 app（`docker compose stop app`），保留現場（不要覆蓋損毀的資料卷，先複製或改名）。
2. 建立新的空資料庫（新資料卷），`pg_restore --no-owner --no-privileges --dbname=<新資料庫> <最近的備份>`。
3. `docker compose run --rm app npm run db:migrate`（若備份時間點的版本落後於目前映像）。
4. 把 `DATABASE_URL` 指向新資料庫、啟動 app，檢查 `/api/ready`、抽查資料；通知使用者備份時間點之後的資料需要補登。
5. 事後檢討並記錄於 `DEVELOPMENT_LOG.md`。
**正式資料庫的任何還原都屬於高風險操作，需要 Owner 明確授權。**
