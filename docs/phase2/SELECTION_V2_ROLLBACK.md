# SOP 02 選品評分 V2：相容與回滾策略

## 相容性（為什麼舊資料不受影響）

- migration 016 **只新增欄位與資料表**，沒有改任何既有欄位的語意、型別或資料。
- V1 舊評估：`rubric_version IS NULL`，`scores`、`total_score`、`recommendation` 等欄位原樣保存；V2 欄位為 `NULL`。畫面依 `rubric_version` 決定用舊版（1～5 分）或新版（子條件）呈現，**不會用新規則重算舊分數**。
- V2 評估仍填寫 V1 就有的 `total_score`／`completeness`／`confidence`／`recommendation`／`evidence_gaps`／`config_version`／`config_snapshot`，所以評估列表、`/selection` 總覽、G1 決策摘要、覆核流程不需要認得 V2 也能運作。
- 已送出的評估（V1 與 V2）由觸發器 `product_evaluations_guard()` 保護：評分內容、規則版本快照、V2 欄位都不可修改；要改只能建立新版本。
- 資料庫 CHECK 約束 `product_evaluations_v2_shape`：`rubric_version` 為 `NULL` 時 V2 欄位必須全為 `NULL`；為 2 時必須有 `v2_input`。

## 回滾（只在 V2 尚未被依賴、或決定退回 V1 時使用）

migration 檔案本身是單向的（執行器以雜湊值驗證，不支援 down）。回滾用下面的 SQL，**手動**在維護時段執行，並先備份：

```sql
-- 0. 先匯出 V2 資料留底（回滾會丟失這些欄位）
--    COPY (SELECT id, product_id, version_no, rubric_version, commerce_model, v2_input, v2_result FROM product_evaluations WHERE rubric_version = 2) TO '/tmp/v2_backup.csv' CSV HEADER;

-- 1. 先處理仍在進行的 V2 草稿（V1 畫面看不懂 V2 草稿）：由人決定刪除（改為軟刪除不適用於此表）或送出後再回滾
-- 2. 還原觸發器（內容為 migration 014 的版本）
-- 3. 移除新欄位與約束
ALTER TABLE product_evaluations DROP CONSTRAINT product_evaluations_v2_shape;
ALTER TABLE product_evaluations DROP COLUMN rubric_version, DROP COLUMN commerce_model, DROP COLUMN v2_input, DROP COLUMN v2_result, DROP COLUMN evidence_completeness;
DROP TABLE evaluation_supplement_requests;
ALTER TABLE vendor_dd_records DROP COLUMN supersedes_id, DROP COLUMN superseded_at, DROP COLUMN copied_from_id;
DELETE FROM schema_migrations WHERE name = '016_selection_v2.sql';   -- 欄位名稱以實際 schema_migrations 為準
```

注意：
- **V2 已送出的評估在回滾後只剩 V1 欄位**（總分、建議、可信度、證據缺口仍在，子條件明細會消失）。因此回滾前務必匯出。
- 回滾前要先停止應用程式（新程式碼會讀取 V2 欄位）。
- 設定 `system_settings` 的 `selection.scoring.v2` 可保留（舊程式不讀）；要清除用 `DELETE FROM system_settings WHERE key = 'selection.scoring.v2'`。
- 沒有使用 V2 之前（尚未建立任何 V2 評估），回滾沒有資料損失。

## 不建議回滾的情況

已有 V2 評估被覆核採用、並被 G1 決策摘要引用時，建議改用「停用 V2 建立入口＋保留既有資料唯讀」而不是刪欄位：把設定 `selection.scoring.v2.enabled` 設為 `false`（見規格 §8），新評估改回建立 V1，既有 V2 評估仍可閱讀。
