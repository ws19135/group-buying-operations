# 需求追溯矩陣（RTM）

> 需求來源：藍圖（BP）章節、路線圖（RM）、本次任務指示（T-STEP）。狀態：`IMPLEMENTED_NEW`（已實作且有自動化測試）｜`PROPOSED`｜`BLOCKED`｜`NOT_STARTED`。
> 測試欄位的檔名都在 `tests/`；「E2E」指 `scripts/e2e-smoke.ts`（結果見 [UAT_EVIDENCE.md](UAT_EVIDENCE.md)）。實際通過與否以 [TEST_REPORT.md](TEST_REPORT.md) 為準。

## A. 角色、權限、資料範圍（BP §2、T-STEP 5）

| 需求 | 來源 | 實作 | 測試 | 狀態 |
|---|---|---|---|---|
| 六個角色（管理者／營運主管／營運小編／團主／廠商／財務） | BP §2.2、T-STEP 5 | `permissions.ts`、`roles` 表 | `unit/misc`（權限矩陣） | IMPLEMENTED_NEW |
| RBAC＋資料範圍，後端強制，不只前端隱藏 | BP §2.3 | `scope.ts`、各模組 `requirePerm` | `rbac` | IMPLEMENTED_NEW |
| 團主只能取得自己被授權的團購、社群、業績 | T-STEP 5 | `campaignScope`、`listCommunities`、`getHostDashboard` | `rbac`、`orders-dashboard` | IMPLEMENTED_NEW |
| 廠商只能取得自身合作資料 | T-STEP 5 | 同上（VENDOR 範圍） | `rbac` | IMPLEMENTED_NEW |
| 財務敏感資料獨立權限（成本、佣金規則、財務稽核） | T-STEP 5 | `product.cost.read`、`commission.write`、`listAudit` 財務過濾 | `rbac`、`unit/misc` | IMPLEMENTED_NEW |
| 內部成本、其他團主資料不得意外顯示 | T-STEP 5 | 欄位投影；Dashboard 目標欄位過濾 | `rbac`、`orders-dashboard`（敏感欄位） | IMPLEMENTED_NEW |
| 越權、跨團主讀取、未登入存取、敏感資料洩漏測試 | T-STEP 5 | — | `rbac`（21 項） | IMPLEMENTED_NEW |
| 金額覆寫／跨群組查看／匯出個資／權限變更需額外權限並寫 Audit Log | BP §2.3 | 權限變更、封存、狀態變更、日期調整皆寫稽核；金額覆寫與匯出屬 Phase 2 | `rbac`、`lifecycle` | 部分（金額覆寫、匯出＝NOT_STARTED） |
| 廠商入口：單筆／單檔授權、回填≠確認 | BP §2.3、P4 | — | — | NOT_STARTED |
| 客服／履約、稽核唯讀角色 | BP §2.2 | — | — | NOT_STARTED |
| SSO／MFA | BP §8.3 | — | — | NOT_STARTED（需 Owner 決定） |

## B. 資料模型（BP §3、T-STEP 2）

| 需求 | 實作 | 測試 | 狀態 |
|---|---|---|---|
| Users／Roles／UserScopes | 表 `users`、`roles`、`user_scopes`、`sessions` | `database`、`rbac` | IMPLEMENTED_NEW |
| Hosts／Communities／HostCommunities | `hosts`、`communities`、`host_communities`、`host_availability` | `scenarios`、`database` | IMPLEMENTED_NEW |
| Vendors／VendorContacts | `vendors`、`vendor_contacts` | `scenarios`、`rbac` | IMPLEMENTED_NEW |
| Products／SKUs | `products`、`skus`、`product_assets` | `scenarios` | IMPLEMENTED_NEW |
| Agreements | `agreements`（僅 Schema） | `database`（表存在） | IMPLEMENTED_NEW（僅 Schema；無 API） |
| Campaigns／CampaignProducts／CampaignHosts | `campaigns`、`campaign_products`、`campaign_hosts` | `lifecycle`、`scenarios` | IMPLEMENTED_NEW |
| CampaignPlacements | `campaign_placements` | `scenarios` | IMPLEMENTED_NEW |
| WorkflowTemplates／Tasks／TaskDependencies | `workflow_templates`、`workflow_template_steps`、`tasks`、`task_dependencies` | `campaign-basic`、`unit/schedule`、`reschedule` | IMPLEMENTED_NEW |
| Approvals | `approvals` | `lifecycle` | IMPLEMENTED_NEW |
| Orders／OrderItems／Attributions | `orders`、`order_items`、`attributions`、`import_batches`、`import_errors` | `orders-dashboard`、`database` | IMPLEMENTED_NEW |
| CommissionRules | `commission_rules`（版本化） | `orders-dashboard`、`rbac` | IMPLEMENTED_NEW |
| Settlements | `settlements`、`settlement_items`（僅 Schema） | `database` | IMPLEMENTED_NEW（僅 Schema）；邏輯 NOT_STARTED |
| Events／AutomationRuns／Notifications／AuditLogs | `events`、`automation_runs`、`notifications`、`audit_logs` + `exceptions`、`vendor_intake_submissions`、`daily_summaries` | `automation`、`database` | IMPLEMENTED_NEW |
| 穩定唯一 ID、正確主外鍵、必要索引、唯一約束與去重 | 計數器、FK、部分唯一索引 | `database`、`scenarios` | IMPLEMENTED_NEW |
| 建立／修改時間與操作者、變更稽核 | `touch_row` 觸發器、`audit_logs` | `database`、`lifecycle` | IMPLEMENTED_NEW |
| 避免實體刪除 | `forbid_delete` 觸發器；API 無 DELETE | `database`、`scenarios`（405） | IMPLEMENTED_NEW |
| 多租戶隔離 | `organization_id`＋服務層 | `rbac`（跨組織）、`database` | IMPLEMENTED_NEW |
| 欄位級資料字典（BP §3.5 五個核心字典的業務定義） | 自動產生的技術字典 | — | 部分（業務定義＝PROPOSED） |

## C. 核心管理模組（T-STEP 3）

| 模組 | 功能 | 測試 | E2E | 狀態 |
|---|---|---|---|---|
| 廠商 | CRUD、聯絡人、合作狀態、商品與檔期、待補資料與異常、封存（軟刪除） | `scenarios` | ✓ | IMPLEMENTED_NEW |
| 團主 | CRUD、所屬社群、合作條件、可承接／不可承接檔期、歷史團購 | `scenarios`、`rbac` | ✓ | IMPLEMENTED_NEW |
| 社群 | LINE／FB／IG／Threads／YouTube、團主關聯、曝光紀錄 | `scenarios` | ✓ | IMPLEMENTED_NEW |
| 商品 | 商品／SKU／團購價／素材連結／審核狀態；成本僅授權角色 | `scenarios`、`rbac` | ✓ | IMPLEMENTED_NEW |
| 團購檔期 | 建立／編輯、關聯商品／團主／社群、日期、負責人、目標、狀態、衝突提醒 | `lifecycle`、`scenarios`、`reschedule` | ✓ | IMPLEMENTED_NEW |
| 曝光安排 | 團主＋社群＋日期＋形式；檢查歸屬與區間；狀態 | `scenarios` | ✓ | IMPLEMENTED_NEW |
| 搜尋／篩選／分頁 | 各列表 | `scenarios`（missing=1）、`rbac` | ✓ | IMPLEMENTED_NEW |

## D. 狀態機與 Gate（BP §4、T-STEP 4）

| 需求 | 實作 | 測試 | 狀態 |
|---|---|---|---|
| 13 種檔期狀態＋暫緩，轉移表 | `state.ts` | `unit/misc`、`lifecycle` | IMPLEMENTED_NEW |
| 倒退／跳步需原因與稽核；不可繞過關卡 | `gates.ts` | `lifecycle` | IMPLEMENTED_NEW |
| G1–G5 系統檢查＋人工核准＋退回 | `runGateChecks`、`requestApproval`、`decideApproval` | `lifecycle`、`scenarios` | IMPLEMENTED_NEW |
| 取消／暫緩／恢復；取消時任務、核准、曝光一併處理 | `cancelCampaign` 等 | `lifecycle` | IMPLEMENTED_NEW |
| 缺資料或未通過 Gate 時無法進入下一狀態（RM P2 Exit） | 同上 | `lifecycle` | IMPLEMENTED_NEW |
| 狀態與日期變更可從 Audit Log 還原（RM P2 Exit） | 稽核前後值 | `lifecycle`（狀態路徑）、`reschedule` | IMPLEMENTED_NEW |

## E. 工作流程引擎（T-STEP 4、BP §4.4）

| 需求 | 實作 | 測試 | 狀態 |
|---|---|---|---|
| SOP 11 步轉為可配置任務模板（含 G1/G2/G3/G5） | `template-default.ts`、`templates.ts` | `unit/schedule` | IMPLEMENTED_NEW |
| 自動建立任務、負責人、預計／實際日期、相依、選擇性任務 | `generateTasks` | `campaign-basic`、`automation` | IMPLEMENTED_NEW |
| 逾期判斷、審核閘門 | `isOverdue`、`overdue_detection` | `automation` | IMPLEMENTED_NEW |
| 日期變更影響預覽（改前列出受影響任務，確認後連動） | `previewCampaignReschedule` | `reschedule`、`unit/schedule` | IMPLEMENTED_NEW |
| 排程衝突檢查（同商品、同社群、團主不可承接、團主同時多檔） | `conflicts.ts`、排程 `schedule_issue` | `scenarios`、`unit/schedule` | IMPLEMENTED_NEW |
| 避免全域修改預設天數未經核准覆寫已確認檔期 | 模板版本化＋參數快照＋鎖定 | `reschedule` | IMPLEMENTED_NEW |
| 任務完成與操作紀錄 | `setTaskStatus` | `lifecycle`、`rbac` | IMPLEMENTED_NEW |

## F. Dashboard（BP §5、§7、T-STEP 6）

| 需求 | 實作 | 測試 | 狀態 |
|---|---|---|---|
| 管理者 Dashboard（進行中檔數、預定開結團、團主／社群概況、本期業績、達成率、團主績效、待處理任務、逾期、廠商進度） | `getAdminDashboard` | `orders-dashboard` | IMPLEMENTED_NEW |
| 團主 Dashboard（我的檔期、行事曆、待辦、業績與目標、預估佣金、試用／素材狀態、結算進度） | `getHostDashboard` | `orders-dashboard`、`rbac` | IMPLEMENTED_NEW |
| 無訂單時只顯示 Demo／待串接，不產生假業績 | `dataQuality`、KPI null | `orders-dashboard` | IMPLEMENTED_NEW |
| KPI 可追溯來源與計算方式 | `KPI_DEFS` 隨回應回傳 | `orders-dashboard` | IMPLEMENTED_NEW |
| 最後同步時間、資料不完整警告 | `dataQuality` | `orders-dashboard` | IMPLEMENTED_NEW |
| 管理端與團主端同口徑（RM P3 Exit） | 共用口徑 | `orders-dashboard` | IMPLEMENTED_NEW |
| 抽樣訂單可下鑽到來源與匯入批次（RM P3 Exit） | `orders.import_batch_id`、`/orders`、`/imports` | `orders-dashboard` | IMPLEMENTED_NEW（UI 下鑽：匯入頁；訂單明細頁 NOT_STARTED） |
| 與一檔歷史結案數字手工對帳（RM P3 Exit） | — | — | BLOCKED（無真實歷史資料） |
| 每日／結單快照 | `daily_summaries`（每日摘要）；結單快照 | `automation` | 部分（結單快照＝NOT_STARTED） |
| 介面：繁中、淺色專業、桌面為主、手機基本可用 | `src/app`、`globals.css` | E2E | IMPLEMENTED_NEW |

## G. 自動化（BP §6、T-STEP 7）

| 需求 | 測試 | 狀態 |
|---|---|---|
| 新廠商資料進件（去重、配對、草稿檔期） | `automation` | IMPLEMENTED_NEW |
| 建立團購後產生任務（冪等） | `automation`、`campaign-basic` | IMPLEMENTED_NEW |
| 日期調整後預覽與重排 | `reschedule` | IMPLEMENTED_NEW |
| 試用回饋催辦、團主未回覆 | `automation` | IMPLEMENTED_NEW |
| 開團前檢查 | `automation` | IMPLEMENTED_NEW |
| 逾期異常偵測 | `automation` | IMPLEMENTED_NEW |
| 結團後產生後續作業（狀態推進、通知、任務齊全） | `automation` | IMPLEMENTED_NEW |
| 每日營運摘要資料 | `automation` | IMPLEMENTED_NEW |
| 冪等／可重試／可停用／有執行紀錄／失敗可查 | `automation` | IMPLEMENTED_NEW |
| 不自動修改財務與合作條件 | `automation`（進件不寫佣金規則） | IMPLEMENTED_NEW |
| 通知佇列＋測試 Adapter；不對真人發送 | `automation` | IMPLEMENTED_NEW |
| 真實 LINE／Email／電商 API／Google Workspace 整合 | — | BLOCKED |
| Google Sheets／Apps Script 相容層 | — | PROPOSED（目前僅 CSV） |

## H. 驗收情境（BP §9.3、T-STEP 8 清單）

| 情境 | 測試 |
|---|---|
| 新團建立：缺欄阻擋、ID 唯一、正確帶入群組／團主／廠商 | `scenarios`、`database`、`campaign-basic` |
| 日期延誤：顯示受影響任務、確認後連動、保留前後值 | `reschedule` |
| 團主查看：只看到自己的團，數字與管理端同口徑 | `rbac`、`orders-dashboard` |
| 業績匯入：重跑不重複、錯誤列進待處理、可追溯來源 | `orders-dashboard` |
| 退款：淨銷售與佣金預估同步調整，保留原訂單 | `orders-dashboard`（部分退款、退款更新） |
| 權限：未授權角色無法經 API 讀取或改寫 | `rbac` |
| 結算：試算可重算、覆寫有原因、確認後不可覆蓋 | — NOT_STARTED（Phase 2） |
| 稽核：能查到誰在何時改了什麼以及前後值 | `lifecycle`、`reschedule`、`rbac` |
| 同一商品重複開團／一檔多 SKU／一檔多團主／同團主多社群 | `scenarios` |
| 日期衝突／團主未回覆／團購取消 | `scenarios`、`automation`、`lifecycle` |
| 重複表單送出（含並發） | `scenarios` |
| 訂單缺漏與資料延遲 | `orders-dashboard`（NO_DATA、錯誤列、延遲警告） |
| 外部整合不可用 | `automation`（Adapter 失敗→DEAD→例外） |

## I. 非功能（BP §8.4、T-STEP 1/8）

| 需求 | 實作／證據 | 狀態 |
|---|---|---|
| 可重現本機環境、`.env.example`、migration、seed | DEPLOYMENT.md、`scripts/` | IMPLEMENTED_NEW |
| 錯誤處理、輸入驗證、操作日誌 | `router.ts`、zod、`audit_logs` | IMPLEMENTED_NEW |
| 健康檢查、資料庫連線檢查 | `GET /api/health` | IMPLEMENTED_NEW（`scenarios`/`rbac` 覆蓋公開性；連線以 E2E 驗證） |
| Typecheck／Lint／單元／整合／API／RBAC／Workflow／Migration／KPI／E2E／Build | `npm run check`、CI | IMPLEMENTED_NEW（結果見 TEST_REPORT） |
| 基本 CI | `.github/workflows/ci.yml` | IMPLEMENTED_NEW（以 PR 上的實際執行結果為準） |
| 備份還原演練、監控告警、RLS、靜態加密 | — | NOT_STARTED |
| 履約、售後、退款、客訴、結算（RM P4/P5） | `settlements` 等僅 Schema | NOT_STARTED |

## J. SOP 01 市場定位與客群分析（本次任務指示 T-SOP01）

| 需求 | 實作 | 測試 | 狀態 |
|---|---|---|---|
| 客群輪廓、需求與偏好、團主多客群關聯、商品適配評估、研究證據、版本紀錄（五張邏輯表） | migration 013：`customer_segments`、`segment_preferences`、`partner_segment_links`、`segment_evidence`、`product_fit_assessments`；版本＝`version` 樂觀鎖＋`audit_logs`＋評估多版本 | `segments`、`fit`、`database` | IMPLEMENTED_NEW |
| 一團主多客群、多通路、複選需求；區分事實／估計／未知 | `segments.ts`；`basis` 欄位；空值＝未知 | `segments`（多客群、占比、通路、未知／PARTIAL） | IMPLEMENTED_NEW |
| 團主詳情「客群分析」區（輪廓、動機、阻力、品類、週期、通路、觀察來源） | `hosts/[id]/HostSegments.tsx` | E2E | IMPLEMENTED_NEW |
| 商品／檔期頁的候選團主適配（評分、理由、完整度、人工覆核） | `FitTable.tsx`、商品頁、檔期「客群適配」分頁 | E2E、`fit` | IMPLEMENTED_NEW |
| 可解釋規則：需求30／品類20／價格15／歷史績效20／供應履約15，可配置，標示待確認 | `lib/fit-score.ts`、`system_settings['fit.scoring']`、`/fit?tab=config` | `unit/fit-score`、`fit`（設定與版本） | IMPLEMENTED_NEW（權重待確認） |
| 未知不當 0 分；標記缺乏證據與信心 | `scoreFit`（重新正規化、完整度、信心） | `unit/fit-score`（突變驗證） | IMPLEMENTED_NEW |
| 合規與品質為硬性檢查，不被總分抵銷 | `hardChecks`、建議等級 BLOCKED | `unit/fit-score`、`fit`（突變驗證） | IMPLEMENTED_NEW |
| 保留評分版本、來源、理由與人工覆核 | `config_snapshot`、`sources`、`reasons`、覆核欄位、DB 觸發器不可改 | `fit` | IMPLEMENTED_NEW |
| 流程串接；不改 G1–G5、不自動核准 | 面板與提示；結案回寫 API；未改 `gates.ts` | `fit`（G1 回歸）、`lifecycle`（既有） | IMPLEMENTED_NEW |
| 角色權限、審計、既有設計系統 | 6 個新權限；`audit()`；`ApiForm`／`Modal`／`Card` | `segments`、`fit`、`unit/misc`、`security-fuzz` | IMPLEMENTED_NEW |

## K. SOP 02 商品選品與廠商開發、SOP 03 商品試用與商業可行性驗證（本次任務指示 T-SOP02-03）

| 需求 | 實作 | 測試 | 狀態 |
|---|---|---|---|
| 盤點既有文件與程式（廠商、聯絡人、商品、SKU、素材、協議、客群適配、檔期、任務、核准），標示可沿用／需擴充／需新增／待 Owner 核准 | `docs/phase2/PRODUCT_SELECTION_TRIAL.md` §1（讀過程式與 migration 001–013，不只讀文件） | — | DONE（文件） |
| 選品評分：需求25／品質安全25／利潤價格20／供應履約15／內容10／複購5，1–5 分、加權 100、權重與門檻可設定且版本化 | `lib/selection-score.ts`、`selection.ts`、`system_settings['selection.scoring']`、`/selection?tab=config` | `unit/selection-score`（14）、`selection`（設定版本、衝突、驗證） | IMPLEMENTED_NEW（權重與門檻**待 Owner 確認**，D-25） |
| 記錄評估人、日期、證據、理由、審核者、版本；不與 SOP 01 客群適配重複 | `product_evaluations`（觸發器鎖定送出內容）、`evidence_items`；適配僅唯讀引用 | `selection`（版本、不可改、覆核、不寫入 `product_fit_assessments`） | IMPLEMENTED_NEW |
| 安全／合規是獨立必要查核，不被總分抵銷；分數只是建議，不自動核准商品或 G1 | `compliance`（PASS／FAIL／UNKNOWN／NEEDS_LEGAL）、建議等級 BLOCKED／SUPPLEMENT | `unit/selection-score`、`selection`、`selection-g1`（突變驗證） | IMPLEMENTED_NEW |
| 12 類廠商首次合作盡職調查（結構化資料；狀態、負責人、責任方、證據、更新／審核時間、合約版本） | `vendor_dd_records`／`vendor_dd_items`、`dd-catalog.ts`、`diligence.ts` | `unit/dd-catalog`（13）、`diligence`（30） | IMPLEMENTED_NEW |
| 轉售價格限制、食品、醫材等標示「需法務或合規審查」，不自行假定合法 | `legalTriggers`、`legal_status`（REQUIRED／CLEARED／BLOCKED）；CLEARED 需法務意見證據且限 `product.review` | `unit/dd-catalog`、`diligence` | IMPLEMENTED_NEW（受規範品類與窗口**待 Owner 指定**，D-29） |
| 兩層級試用（商品資格／團主適配）、三類型（內部／指定團主／小團）；欄位含商品、規格、廠商、試用人、團主、檔期、日期鏈、物流、回收 | `product_trials`、`trials.ts` | `trials`（31） | IMPLEMENTED_NEW |
| 四大面向結果、客觀證據、缺陷、風險、最終建議、審核者、版本與歷史；同商品可多次試用；重複進行中擋下；資格沿用 | `trial_checks`、`trial-catalog.ts`、部分唯一索引、商品指紋 | `unit/trial-catalog`（12）、`trials` | IMPLEMENTED_NEW |
| 沿用既有任務（SAMPLE_SHIP／TRIAL_ARRIVAL／TRIAL_FEEDBACK／G1），不另建任務狀態機 | 試用只有 OPEN／CONCLUDED／CANCELLED；任務現況唯讀顯示 | `trials`（任務與狀態不變） | IMPLEMENTED_NEW |
| 商業可行性：預估訂單、價格、成本、運費、平台費、分潤、其他變動與固定成本；GMV／有效淨銷售額／品牌利潤／公司營業收入分開；依收款模式；假設來源與版本；小團實際回寫 | `feasibility-calc.ts`、`feasibility.ts`、`feasibility_scenarios` | `unit/feasibility-calc`（21）、`feasibility`（18） | IMPLEMENTED_NEW（口徑**待 Owner 確認**，D-31） |
| ERP 整合：廠商頁「合作資格審查」、商品頁「選品評估／商品資格試用／可行性」、檔期頁試用與摘要 | `DiligenceCard`、`SelectionCards`、`SelectionTab`、`/diligence/[id]`、`/trials/[id]`、`/feasibility/[id]`、`/selection` | E2E | IMPLEMENTED_NEW |
| G1 核准畫面提供統一決策摘要（證據與風險），不改既有 G1 阻擋條件；保留商品 DRAFT→PENDING_REVIEW→APPROVED／REJECTED | `decision-summary.ts`、`lib/decision-risk.ts`；`gateImpact: NONE`；未修改 `gates.ts`／`products.ts` 審核 | `selection-g1`（G1 檢查項、核准、通知、任務、商品審核不變；唯讀摘要不寫入） | IMPLEMENTED_NEW |
| 權限：六角色不變；PM 可填報；成本與分潤沿用既有權限，不給營運小編或外部團主；後端強制資料範圍 | 3 個新權限（共 52）；`product.cost.read` 欄位投影；`campaignScope`；404／403 | 各測試檔的權限隔離案例、`security-fuzz`（自動涵蓋新路由）、`unit/misc` | IMPLEMENTED_NEW |
| 附件使用合法安全的儲存方式；GitHub 不放真實客戶、廠商機密、金鑰或未授權素材 | 證據只存連結（http／https，拒絕內嵌帳密、可設網域白名單）；DEMO 連結為 `docs.example.invalid` | `selection`（scheme、帳密、PII、白名單、素材引用） | IMPLEMENTED_NEW（存放位置與網域**待 Owner 指定**，D-32） |
| 版本、操作人、稽核 | `audit()`；稽核不記敏感數值 | `diligence`、`feasibility`（稽核不含成本與分潤數值） | IMPLEMENTED_NEW |
