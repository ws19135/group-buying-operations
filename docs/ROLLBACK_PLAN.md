# 回滾計畫

| 情境 | 作法 | 資料影響 |
|---|---|---|
| 新版本有問題、**沒有**含 migration | GitHub Actions → Deploy production → `image_tag` 填上一個正常版本的 commit SHA（不重新建置）→ Owner 核准 | 無（資料不變） |
| 新版本含 migration，且 migration 已套用 | migration 為向前相容（只新增欄位／表／約束／觸發器）：舊版映像通常仍可運作；先回滾映像。若舊版無法運作，從部署前的備份還原到新資料庫（見備份手冊） | 備份後的新資料會遺失，需補登 |
| migration 套用失敗 | 每支 migration 在單一交易內執行，失敗自動 ROLLBACK，資料庫維持原狀；修正後重新部署 | 無 |
| 設定錯誤（環境變數） | 修正 `.env.production` 後 `docker compose up -d app` | 無 |

規則：每次含 migration 的部署**前**必須先有可驗證的備份（`backup.sh` 通過、必要時演練）；回滾後在 `DEVELOPMENT_LOG.md` 記錄原因與影響；回滾不得使用強制推送或改寫 main 歷史。
