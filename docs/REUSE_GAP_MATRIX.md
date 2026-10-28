# 複用與缺口矩陣（REUSE_GAP_MATRIX）

> 來源：`zhaocai-groupbuy-system`（Apps Script 版招財兔系統，以下稱 ZC）、`groupbuy-flow-sop`（SOP 以下稱 SOP）、主儲存庫藍圖（BP）。
> 處理方式：**沿用**（直接採用規則）｜**改寫**（概念沿用、實作重做）｜**避開**（已知問題，刻意不做）｜**不適用**。

## A. 商業規則與概念

| 項目 | 來源 | 處理 | 在本系統的位置 | 備註 |
|---|---|---|---|---|
| 單一事實來源＋「入口→核心處理」寫入路徑 | ZC NFR-1 | 改寫 | 所有寫入走服務層 `src/server/modules/*`；前端不直連資料庫 | 以交易取代入口分頁 |
| ID 規則（GB-/VEN-/EXP-/SET-） | ZC | 改寫 | `src/server/lib/ids.ts`：VEN-/CMP-/TSK-… | 計數器由資料庫原子遞增；不再用名稱／列號 |
| 軟刪除 | ZC NFR-5 | 沿用＋強化 | 觸發器禁止 DELETE；API 無 DELETE | ADR-007 |
| 雙 Log（System_Log＋Web_Request_Log，含前後值） | ZC FR-9 | 改寫 | `audit_logs`（不可竄改）＋ `automation_runs` | |
| TEST／LIVE 開關 | ZC NFR-2 | 改寫 | `APP_ENV`、`NOTIFY_ADAPTER=test`、自動化預設停用 | 目前沒有 LIVE 路徑，真實通知 = BLOCKED |
| 無時間觸發器 | ZC NFR-4 | 不適用 | 本系統用 worker；預設關閉且逐項啟用 | 藍圖要求主動提醒，與 ZC 決策不同，已在 ADR-012 說明 |
| 狀態機（11 種）與 `getStatusList_()` 單一來源 | ZC | 改寫 | `src/server/workflow/state.ts`（14 種）＋轉移表 | ZC 的缺口 G-04（可任意跳轉）已避免 |
| 分潤公式（比例鏈）、勾選制批次結算、覆寫雙欄 | ZC SDD D3 | **避開（不套用）** | `settlements` 僅 Schema | BP §1.5 明示不擴張；公式屬招財兔內部 |
| 團購層級費用明細 | ZC D2 | 不適用 | — | Phase 2（財務模組） |
| 發票清冊、銀行對帳、廠商回填 | ZC | 不適用 | — | Phase 2/3；廠商入口 NOT_STARTED |
| 疑似重複偵測（同廠商＋同開團日） | ZC `validateNewRequest` | 沿用＋強化 | 檔期自然鍵唯一索引＋同商品重疊衝突偵測 | |
| 11 步任務與日期規則 | SOP | 沿用 | `template-default.ts` | 見 WORKFLOW_MAPPING |
| 天數參數預設值（7/14/3/7/7/14/14） | SOP `build_nx.py` | 沿用 | `DEFAULT_PARAMS` | 團購天數 10 以實際開／結團日取代 |
| 條件式任務（需回收才有；有 Live Talk 日才有） | SOP | 沿用 | `condition_key`＋SKIPPED 狀態 | |
| 逐檔覆寫日期 | SOP（實際到貨日、試用結束日） | 改寫 | 任務「人工鎖定」（需原因）＋預覽後確認 | 避免全域改天數覆寫已確認檔期 |
| 案主只看自己的進度 | SOP（IMPORTRANGE＋勾選開放） | 改寫 | `HOST` 角色＋後端資料範圍 | SOP 靠 Sheet 共享，本系統靠後端授權 |
| 廠商一檔填一次表單、自動收件 | SOP | 改寫 | `vendor_intake_submissions` + `vendor_intake` job | 以 `external_submission_id` 去重 |
| 表單回覆_待處理（安全網） | SOP | 改寫 | `import_errors`、`exceptions` | 錯誤不會消失 |
| 分潤％可能填 20／20%／0.2 | SOP 踩雷 #6 | 沿用 | `parseCommissionText` | 剛好 1 或無法辨識 → 人工 |
| 一團填一次（避免同名品項撞鍵） | SOP B3/B4 | 改寫 | 以不可變 ID 為鍵；自然鍵含開團日 | |

## B. 參考系統的缺口／安全問題（本系統刻意避開）

| # | 參考系統的問題 | 證據 | 本系統的作法 | 測試 |
|---|---|---|---|---|
| S1 | 權限旗標只讀不驗；操作者姓名由前端自填 → 稽核不可信 | ZC `WebApp.gs` `extractOperator_`、旗標未被使用 | 後端依 session 決定 Actor；每個 API 都做權限＋資料範圍檢查 | `tests/rbac.test.ts` |
| S2 | 狀態可被任意手動跳轉（含「已分潤」） | ZC `validateUpdateRequest` 只檢查在清單內 | 轉移表＋Gate；Gate 轉移不可手動 | `tests/lifecycle.test.ts`、`tests/unit/misc.test.ts` |
| S3 | 入帳／金額寫入前不比對 | ZC `apiConfirmBankMatch` | 本次不做金額確認；結算屬 Phase 2，保留人工核准 | — |
| S4 | 線上程式與 repo 版本不一致、無版本控制／備份／自動化測試 | ZC README、PLATFORM_LESSONS | Git＋CI＋migration checksum＋自動化測試；備份見 DEPLOYMENT.md | CI、`tests/database.test.ts` |
| S5 | 寫死的儲存格位置、連結 gid、清單 | ZC `Settings!$B$15`、`gid=…` | 設定放資料庫；模板放資料表 | — |
| S6 | 重建腳本清掉人工欄位 | SOP 踩雷 #2 | 重排不覆寫鎖定／已完成；migration 不改舊檔 | `tests/reschedule.test.ts` |
| S7 | 用品項名稱／列位置當鍵 | SOP 踩雷 #3 | 不可變 ID | `tests/database.test.ts` |
| S8 | 公開表單無防濫用 | SOP `setRequireLogin(false)` | 本系統不開匿名入口；進件需登入且需 `intake.write` | `tests/rbac.test.ts` |
| S9 | 一把共用 ADMIN_KEY、無個人身分 | ZC D4 設計 | 個人帳號＋角色＋稽核 | `tests/rbac.test.ts` |

## C. 本系統尚未覆蓋的參考功能（缺口）

| 缺口 | 狀態 | 原因／下一步 |
|---|---|---|
| 發票清冊、請款、入帳確認、銀行對帳 | NOT_STARTED | Phase 3（財務）；需先定義金流模式（待決策 #4） |
| 廠商專屬連結／回填 | NOT_STARTED | 涉及對外存取；需 Owner 解凍並設計單一範圍入口（藍圖 P4） |
| 退款／客訴／履約 | NOT_STARTED | Phase 2（P4） |
| 分潤結算（試算／覆寫／確認／調整批次） | NOT_STARTED（僅 Schema） | Phase 2（P5）；公式待 Owner 定義 |
| Google 日曆同步、Sheets 匯出 | BLOCKED / PROPOSED | 需 Google 授權；目前以應用內行事曆與 CSV 取代 |
| LINE／Email 真實通知 | BLOCKED | 需憑證與 Owner 授權；已有 Adapter 介面 |
| 電商 API／Webhook 訂單同步 | BLOCKED | 缺平台與憑證；已有 CSV 匯入 |
| 歷史資料遷移 | NOT_STARTED | 待決策 #5、#6；不碰正式資料 |
