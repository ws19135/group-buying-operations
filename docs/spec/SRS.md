# 軟體需求規格（SRS）

> **文件狀態**：草稿，待 Owner 審閱。本文件是對**已實作系統**的逆向整理（先有程式，再回頭寫需求），每一條功能需求都已回頭對照程式與自動化測試。它回答「系統現在要求什麼、做到哪」，不是事前設計。
> **基準**：分支 `feat/erp-spec-and-hardening`，起點 commit `3be9a94`（migrations 001–011、14 個測試檔 245 項測試）。撰寫期間工作目錄中另有其他進行中的修改（例如 `012_security_hardening.sql`），**不在本文件範圍**。
> **金額口徑**：佣金、KPI、結算的公式一律照現有實作如實描述，並標示 **「口徑待 Owner 確認」**；本文件沒有新增任何公式。
> **機密**：本文件不含 Sheet ID、帳號、密碼、金鑰或真實廠商／訂單資料；示範資料全部是虛構（名稱帶 `[DEMO]`）。

## 如何閱讀

| 標記 | 意義 |
|---|---|
| IMPLEMENTED | 已實作，且有對應自動化測試 |
| PARTIAL | 已實作一部分；或已實作但缺自動化測試；或需求與程式有落差（原因寫在該列） |
| NOT_STARTED | 未實作 |
| BLOCKED | 需要外部資源或 Owner 授權才能做（憑證、平台、解凍） |
| 驗（最後一欄） | ✅ 我讀過該測試的內容，斷言涵蓋驗收條件｜📄 只核對測試標題與被測程式存在（測試全數重跑通過）｜❌ 已實作但沒有自動化測試｜— 未實作，無可驗證項目 |
| 優先 | MUST（沒有就不能用）／SHOULD（應該要有）／COULD（有更好） |

測試引用格式：`檔名 ›「測試標題」`，檔案在 `tests/`（`unit/misc` 即 `tests/unit/misc.test.ts`）。測試重跑方式與結果見第 11 節。

---

## 1 目的與範圍

### 1.1 目的
定義「團購營運 ERP」（本儲存庫 `group-buying-operations`）的需求：讓營運團隊用同一筆檔期資料驅動排程、任務、核准、訂單與業績、履約、售後與結算，管理者看全局、團主與廠商只看自己的範圍，異常主動浮出（藍圖 §1.1）。

### 1.2 範圍

**範圍內（已實作，僅在本機與隔離環境驗證）**：認證與 RBAC、廠商／團主／社群／商品主檔、客群分析與商品適配評估（SOP 01，決策支援，不改 G1–G5）、商品選品評估／廠商合作資格審查／商品試用／商業可行性試算與 G1 統一決策摘要（SOP 02／03，決策支援，不改 G1–G5 與商品審核流程）、檔期與 15 步流程排程、日期變更影響預覽、14 狀態機與 G1–G5 關卡、訂單 CSV 匯入、管理者與團主 Dashboard、預估佣金、8 個自動化工作與通知佇列（測試 Adapter）、廠商進件、例外管理、履約與出貨與庫存紀錄、退款／客訴／售後、結算試算與確認、入帳／發票／費用紀錄、稽核。

**範圍外**：見第 8 節（電商 API、真實 LINE／Email、廠商入口、歷史資料遷移、SSO／MFA、Production 部署等）。

**非目標**（藍圖 §1.5）：不切換 LIVE、不部署正式服務、不搬動正式資料；不假設所有團購使用同一收款／發票／出貨／分潤模式；不把廠商回填視為會計已確認；不把退款或撥款做成無人審核的全自動動作；不把招財兔既有內部帳務規則擴張成共通規則。

### 1.3 名詞定義

| 名詞 | 定義 |
|---|---|
| 檔期（Campaign） | 一次團購活動；系統的核心識別單位（`CMP-YYYYMM-NNNN`）。商品名稱不是唯一鍵 |
| 團主（Host） | 在社群中開團的合作夥伴；可有多個社群 |
| 社群（Community） | 團主經營的平台群組（LINE／FACEBOOK／INSTAGRAM／THREADS／YOUTUBE／OTHER） |
| 曝光安排（Placement） | 某團主在某社群、某日、以某形式的曝光計畫 |
| 關卡（Gate，G1–G5） | 需系統檢查加人工核准才能通過的節點：G1 選品、G2 開團、G3 結單、G4 結算、G5 結案 |
| BLOCK／WARN | 關卡檢查項的等級：BLOCK 未通過就不能申請／核准；WARN 只提醒 |
| 任務（Task） | 依流程模板為檔期產生的工作項目；`kind` 為 TASK／GATE／MILESTONE |
| 鎖定 | 人工調整單一任務日期後，重排不覆寫該任務 |
| 預估佣金 | 歸因有效淨銷售額 × 生效費率，四捨五入到整數元；**不是正式結算**（口徑待 Owner 確認） |
| 結算試算 | 以預估佣金口徑為每位團主算出的草稿結算；可覆寫（需原因）與加調整項；確認後鎖定 |
| 歸因（Attribution） | 把訂單分攤到一位或多位團主（`share_percent`） |
| DEMO 資料 | 由種子程式寫入、`data_origin=DEMO` 的虛構資料；Dashboard 會明確標示 |
| 軟刪除 | 以狀態或 `deleted_at` 表示已刪除，資料列保留；資料庫觸發器禁止實體 DELETE |
| 冪等 | 重複送出相同請求不會產生重複資料（`Idempotency-Key`、自然鍵、唯一索引） |
| ADR | 架構決策紀錄（`docs/ARCHITECTURE_DECISIONS.md`），全部為 PROPOSED，待 Owner 確認 |

### 1.4 參考文件

`docs/ERP_MASTER_BLUEPRINT.md`（藍圖，BP）、`docs/REQUIREMENTS_TRACEABILITY_MATRIX.md`（RTM）、`docs/ARCHITECTURE_DECISIONS.md`（ADR-001～019）、`docs/WORKFLOW_MAPPING.md`、`docs/DASHBOARD_SPEC.md`、`docs/AUTOMATION.md`、`docs/FEATURE_STATUS_MATRIX.md`、`docs/phase2/{FULFILLMENT,AFTERSALES,FINANCE,SEGMENT_FIT,PRODUCT_SELECTION_TRIAL}.md`、`docs/KNOWN_ISSUES.md`、`docs/generated/*`（資料字典、ERD、端點清單）、`docs/TEST_REPORT.md`。

### 1.5 需求的權威順序
規格有歧義時依序參考：Owner 的明確指示 → 藍圖 → ADR（PROPOSED，待確認）→ 程式現況。本文件與程式不一致時，**以程式為準**，並把落差列在第 11.3 節，由 Owner 決定改程式還是改規格。

---

## 2 利害關係人與角色

### 2.1 利害關係人

| 利害關係人 | 關注點 | 在系統中的對應 |
|---|---|---|
| Owner（Winnie） | 決策者：口徑、範圍、授權、上線 | `SYSTEM_ADMIN`；第 9 節待決策清單的決定者 |
| 營運主管 | 資源配置、跨團監控、例外升級、核准 | `OPS_MANAGER` |
| 營運 PM／小編 | 廠商、商品、檔期、任務、素材、異常追蹤 | `OPS_EDITOR`（藍圖的「營運 PM」＝任務的「營運小編」，ADR-005） |
| 團主 | 看自己的檔期、業績、下一步、預估佣金 | `HOST`（資料範圍＝被邀請且未婉拒的檔期） |
| 廠商 | 看自己的商品與檔期、完成自己的任務 | `VENDOR`（目前唯讀；回填入口未解凍） |
| 財務 | 成本、佣金規則、入帳、費用、結算 | `FINANCE` |
| 客服／履約 | 訂單、出貨、退換貨、客訴 | 未建立獨立角色（藍圖 §2.2 有，尚未實作）；履約與售後功能由營運角色與財務使用 |
| 稽核／唯讀 | 查看歷史與 Log | 未建立獨立角色；稽核讀取依角色過濾（FR-RBAC-07） |
| 開發／維運 | 部署、備份、監控 | 尚未有維運責任人（待決策 #7） |

### 2.2 角色與權限（程式現況，52 項權限）

一人一個角色（ADR-005）。下表由 `src/server/lib/permissions.ts` 的 `ROLE_PERMISSIONS` 直接匯出。「能不能做這類動作」由權限決定；「能碰哪些資料列」另由資料範圍決定（FR-RBAC-02～06）。

| 權限 | 系統管理者 | 營運主管 | 營運小編 | 團主 | 廠商 | 財務 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| `aftersales.read` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `aftersales.write` | ✅ | ✅ | ✅ | — | — | — |
| `approval.read` | ✅ | ✅ | ✅ | — | — | ✅ |
| `approval.request` | ✅ | ✅ | ✅ | — | — | — |
| `audit.read` | ✅ | ✅ | — | — | — | ✅ |
| `automation.manage` | ✅ | ✅ | — | — | — | — |
| `automation.run` | ✅ | ✅ | — | — | — | — |
| `campaign.read` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `campaign.sensitive.read` | ✅ | ✅ | — | — | — | ✅ |
| `campaign.transition` | ✅ | ✅ | ✅ | — | — | — |
| `campaign.write` | ✅ | ✅ | ✅ | — | — | — |
| `commission.read` | ✅ | ✅ | — | ✅ | — | ✅ |
| `commission.write` | ✅ | — | — | — | — | ✅ |
| `community.read` | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| `community.write` | ✅ | ✅ | ✅ | — | — | — |
| `dashboard.admin` | ✅ | ✅ | ✅ | — | — | ✅ |
| `dashboard.host` | ✅ | ✅ | — | ✅ | — | — |
| `exception.manage` | ✅ | ✅ | ✅ | — | — | — |
| `exception.read` | ✅ | ✅ | ✅ | — | — | ✅ |
| `finance.read` | ✅ | ✅ | — | — | — | ✅ |
| `finance.write` | ✅ | — | — | — | — | ✅ |
| `fit.assess` | ✅ | ✅ | ✅ | — | — | — |
| `fit.config` | ✅ | ✅ | — | — | — | — |
| `fit.read` | ✅ | ✅ | ✅ | — | — | — |
| `fit.review` | ✅ | ✅ | — | — | — | — |
| `fulfillment.read` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `fulfillment.write` | ✅ | ✅ | ✅ | — | — | — |
| `host.read` | ✅ | ✅ | ✅ | — | — | ✅ |
| `host.self` | ✅ | — | — | ✅ | — | — |
| `host.write` | ✅ | ✅ | ✅ | — | — | — |
| `intake.write` | ✅ | ✅ | ✅ | — | — | — |
| `order.import` | ✅ | ✅ | ✅ | — | — | — |
| `order.read` | ✅ | ✅ | ✅ | — | — | ✅ |
| `product.cost.read` | ✅ | ✅ | — | — | — | ✅ |
| `product.read` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `product.review` | ✅ | ✅ | — | — | — | — |
| `product.write` | ✅ | ✅ | ✅ | — | — | — |
| `refund.approve` | ✅ | ✅ | — | — | — | — |
| `refund.complete` | ✅ | — | — | — | — | ✅ |
| `segment.read` | ✅ | ✅ | ✅ | — | — | — |
| `segment.write` | ✅ | ✅ | ✅ | — | — | — |
| `selection.config` | ✅ | ✅ | — | — | — | — |
| `selection.read` | ✅ | ✅ | ✅ | — | — | ✅ |
| `selection.write` | ✅ | ✅ | ✅ | — | — | — |
| `settlement.confirm` | ✅ | — | — | — | — | ✅ |
| `task.complete` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `task.read` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `task.write` | ✅ | ✅ | ✅ | — | — | — |
| `user.manage` | ✅ | — | — | — | — | — |
| `vendor.read` | ✅ | ✅ | ✅ | — | — | ✅ |
| `vendor.self` | ✅ | — | — | — | ✅ | — |
| `vendor.write` | ✅ | ✅ | ✅ | — | — | — |
| **權限數** | 52 | 45 | 32 | 10 | 7 | 23 |

關卡核准者（`GATE_APPROVER_ROLES`）：

| 關卡 | 可核准的角色 |
|---|---|
| G1 | 系統管理者、營運主管 |
| G2 | 系統管理者、營運主管 |
| G3 | 系統管理者、營運主管、財務 |
| G4 | 系統管理者、財務 |
| G5 | 系統管理者、營運主管 |

**SOP 02／03 的權限組合**：填報（評估、調查、試用、可行性）= `selection.write`；覆核評估／試用、核准調查、確認法務無虞 = 沿用既有 `product.review`（只有管理者、營運主管）；成本、費用、分潤與利潤欄位 = 沿用既有 `product.cost.read`（營運小編沒有）；設定 = `selection.config`。團主、廠商沒有任何入口；財務只能讀。

**資料範圍摘要**：管理者／營運主管／財務＝整個組織；營運小編＝自己負責或被指派任務的檔期；團主＝自己被邀請（未婉拒）的檔期，且只看自己的團主資料、自己的目標與 HOST 角色任務；廠商＝自己廠商的商品與檔期與 VENDOR 角色任務；外部角色對範圍外資料一律 404（不洩漏存在與否）。

**與藍圖 §2.4 權限矩陣的差異**：藍圖「廠商可更新供貨／出貨（指定欄位）」「團主申請／有限欄位編輯檔期」尚未實作（FR-RBAC-10、FR-CMP-11）；藍圖「客服」「稽核唯讀」角色未建立（FR-RBAC-09）。

---

## 3 營運情境與使用案例

每個使用案例列出：行為者、前置條件、主要流程、替代流程、事後條件，以及對應的功能需求（FR）。


### UC-01 登入並依角色看到各自範圍

| 項目 | 內容 |
|---|---|
| 行為者 | 所有使用者 |
| 前置條件 | 帳號 ACTIVE；外部角色已綁定團主或廠商 |
| 主要流程 | 1. 輸入 Email 與密碼登入<br>2. 系統建立 12 小時 session（HttpOnly cookie）<br>3. 介面依權限顯示導覽；所有資料由後端依角色與資料範圍過濾 |
| 替代／例外流程 | • 密碼錯誤：訊息與「帳號不存在」相同；連續 5 次失敗鎖 15 分鐘<br>• 帳號被停用：既有 session 立即失效<br>• session 過期：回 401，需重新登入<br>• 登入頻率過高：429 |
| 事後條件 | 使用者僅能存取其角色與範圍內的資料 |
| 對應 FR | FR-AUTH-01～09、FR-RBAC-01～08 |

### UC-02 建立廠商與商品主檔

| 項目 | 內容 |
|---|---|
| 行為者 | 營運小編／營運主管 |
| 前置條件 | 具 `vendor.write`、`product.write` |
| 主要流程 | 1. 建立廠商（名稱、公司全名、統編…）；系統以正規化名稱／統編偵測重複<br>2. 新增聯絡人<br>3. 建立商品與規格（SKU），附素材連結<br>4. 送審；審核者核准或退回（退回需原因） |
| 替代／例外流程 | • 重複廠商：回報既有 ID，不新增<br>• 廠商資料不齊：列為「待補資料」<br>• 封存廠商：有未結案檔期時被拒；封存為軟刪除（需原因） |
| 事後條件 | 商品 APPROVED 後才能通過 G2 |
| 對應 FR | FR-MD-01～14 |

### UC-03 廠商進件（表單轉成草稿檔期）

| 項目 | 內容 |
|---|---|
| 行為者 | 內部登入者代送；自動化 worker |
| 前置條件 | `intake.write`；自動化工作 `vendor_intake` 已啟用（預設停用） |
| 主要流程 | 1. 送出進件（`externalSubmissionId` 去重）<br>2. worker 配對既有廠商／建立新廠商與商品<br>3. 建立草稿檔期與 15 個任務並通知<br>4. 人員接手後續 |
| 替代／例外流程 | • 黑名單廠商或分潤％無法判斷：標 NEEDS_REVIEW，不自動處理<br>• 同廠商再次進件：配對既有廠商，不重複建立<br>• 欄位缺漏或格式錯誤：直接拒絕，不寫入 |
| 事後條件 | 進件的分潤％只寫在備註，不寫佣金規則；系統沒有公開表單 |
| 對應 FR | FR-AUT-08、FR-AUT-01 |

### UC-04 建立檔期並自動排程

| 項目 | 內容 |
|---|---|
| 行為者 | 營運小編 |
| 前置條件 | 廠商 ACTIVE 且非暫停／黑名單；商品屬於該廠商 |
| 主要流程 | 1. 建立檔期：廠商、商品／規格、日期、負責人、目標<br>2. 系統以流程模板 v1 產生 15 個任務並排出日期（缺錨點日期的任務留空並說明）<br>3. 邀請團主、安排社群曝光<br>4. 系統顯示檔期衝突提醒 |
| 替代／例外流程 | • 同商品日期重疊：高風險衝突（仍可建立，G2 會擋）<br>• 重複送出：回報既有檔期或回傳同一筆（Idempotency-Key） |
| 事後條件 | 檔期為 DRAFT；任務產生且不重複 |
| 對應 FR | FR-CMP-01～09、FR-WF-01～04 |

### UC-05 選品核准（G1）

| 項目 | 內容 |
|---|---|
| 行為者 | 營運小編申請；營運主管／管理者核准 |
| 前置條件 | 檔期 EVALUATING；至少一位團主已確認；前置任務（寄樣、試用、回饋）已完成 |
| 主要流程 | 1. 小編申請 G1；系統先跑檢查（BLOCK 必須通過）<br>2. 檔期進入 PENDING_G1，核准者收到通知<br>3. 核准者核准 → PREPARING，G1 任務完成 |
| 替代／例外流程 | • 檢查未通過：申請被擋並列出原因<br>• 退回（需原因）：回 EVALUATING 並保留原因<br>• 組織啟用「申請人≠核准人」時自己不能核准自己 |
| 事後條件 | 每步有稽核（前後值） |
| 對應 FR | FR-GATE-01～04、FR-GATE-06、FR-GATE-09 |

### UC-06 籌備與開團核准（G2）

| 項目 | 內容 |
|---|---|
| 行為者 | 營運小編申請；營運主管／管理者核准 |
| 前置條件 | 檔期 PREPARING；日期、商品審核與價格、團主確認、曝光安排齊備 |
| 主要流程 | 1. 申請 G2；檢查日期、商品皆通過審核且有價格、已排曝光、衝突<br>2. 核准 → SCHEDULED |
| 替代／例外流程 | • 高風險衝突：核准者填寫風險確認原因後才能放行（原因進稽核）<br>• 中度衝突：僅提醒 |
| 事後條件 | 檔期 SCHEDULED；開團日到達後可進入 RUNNING |
| 對應 FR | FR-GATE-02、FR-GATE-05、FR-CMP-04 |

### UC-07 日期變更：先看影響再確認

| 項目 | 內容 |
|---|---|
| 行為者 | 營運小編／營運主管 |
| 前置條件 | 檔期未取消／結案 |
| 主要流程 | 1. 修改日期（試用品可寄出日、開團日、結團日、Live Talk、是否回收）或流程天數<br>2. 系統預覽每個任務的前後日期、被鎖定未動者、衝突，不寫入資料<br>3. 確認時帶預覽代碼；套用後寫稽核並發出事件通知負責人 |
| 替代／例外流程 | • 預覽後有人改動任務：代碼失效，需重新預覽<br>• 已排程以後：必須填原因且限主管；進行中不可改開團日；核准後改日期留例外<br>• 手動鎖定單一任務日期：重排不覆寫 |
| 事後條件 | 任務日期與預覽一致；稽核有前後值 |
| 對應 FR | FR-WF-05～08 |

### UC-08 開團與銷售進行中

| 項目 | 內容 |
|---|---|
| 行為者 | 營運小編；自動化 |
| 前置條件 | 檔期 SCHEDULED |
| 主要流程 | 1. 到開團日由 worker 推進 RUNNING（系統操作、稽核 SYSTEM），或人工推進<br>2. 銷售中執行任務（開團、話題、催單）<br>3. 過結團日由 worker 推進 PENDING_CLOSE_CHECK 並通知申請 G3 |
| 替代／例外流程 | • 人工提前開團：未到開團日被擋；營運主管填原因可強制<br>• 任務逾期：自動化開例外並通知 |
| 事後條件 | 狀態推進不重複 |
| 對應 FR | FR-GATE-07、FR-AUT-04、FR-AUT-05 |

### UC-09 匯入訂單並查看業績

| 項目 | 內容 |
|---|---|
| 行為者 | 營運主管／營運小編（`order.import`） |
| 前置條件 | 檔期已建立；CSV 已去除個資 |
| 主要流程 | 1. 上傳 CSV；系統檢查檔案層級錯誤<br>2. 逐列驗證；同訂單品項合併；建立歸因<br>3. 錯誤列進待處理佇列，其餘照常匯入<br>4. 管理者與團主 Dashboard 以同一口徑顯示 KPI |
| 替代／例外流程 | • 同一檔案再匯入：被擋<br>• 跨檔重疊：相同略過、退款變動更新並稽核、品項被改進錯誤佇列<br>• 取消的檔期：整批 FAILED<br>• 尚無訂單：Dashboard 顯示「待串接」，KPI 為「—」 |
| 事後條件 | 訂單可追溯到匯入批次；DEMO 資料明確標示 |
| 對應 FR | FR-ORD-01～09、FR-DSH-01～09 |

### UC-10 結單確認（G3）

| 項目 | 內容 |
|---|---|
| 行為者 | 營運小編申請；營運主管／管理者／財務核准 |
| 前置條件 | 檔期 PENDING_CLOSE_CHECK；已過結團日 |
| 主要流程 | 1. 申請 G3（檔期維持原狀態）<br>2. 系統檢查：已過結團日（BLOCK）、訂單存在與新鮮度（WARN）<br>3. 核准 → FULFILLING |
| 替代／例外流程 | • 沒有訂單：僅提醒資料是否延遲 |
| 事後條件 | 檔期進入履約 |
| 對應 FR | FR-GATE-02、FR-GATE-03、FR-GATE-09 |

### UC-11 履約出貨與簽收

| 項目 | 內容 |
|---|---|
| 行為者 | 營運主管／營運小編 |
| 前置條件 | 檔期 SCHEDULED 以後（寄樣不受限） |
| 主要流程 | 1. 建立出貨批次與出貨單（物流商、追蹤碼、預計日）<br>2. 包裝 → 出貨 → 送達，批次狀態自動彙總<br>3. 人工登錄簽收<br>4. 庫存異動以 append-only 紀錄；更正用反向異動 |
| 替代／例外流程 | • 出貨異常（需原因）：批次標異常、通知負責人一次<br>• 取消批次：連動取消未送達出貨單<br>• 重複追蹤碼：被擋 |
| 事後條件 | 履約資料在檔期取消／暫緩／結案後唯讀 |
| 對應 FR | FR-FUL-01～10 |

### UC-12 售後案件與退款

| 項目 | 內容 |
|---|---|
| 行為者 | 營運小編／主管；財務 |
| 前置條件 | 案件關聯檔期（訂單選填） |
| 主要流程 | 1. 建立案件（不得含個資）<br>2. 處理中 → 申請退款（金額不得超過可退餘額）<br>3. 主管核准或退回（退回需原因）<br>4. 財務完成退款；可明確選擇寫回訂單（預設不寫回）<br>5. 案件標記已解決 → 結案 |
| 替代／例外流程 | • 退款待處理時案件不能標記已解決或取消<br>• 併發申請只成功一筆<br>• 寫回時餘額漂移：整筆回滾，退款維持「已核准」 |
| 事後條件 | 案件處理紀錄不可改；團主／廠商只看得到自己範圍的摘要 |
| 對應 FR | FR-AFT-01～12 |

### UC-13 結算試算、確認（G4）

| 項目 | 內容 |
|---|---|
| 行為者 | 財務／管理者 |
| 前置條件 | 檔期已開賣（RUNNING 以後） |
| 主要流程 | 1. 開立結算試算：每位團主的歸因淨銷售與試算佣金<br>2. 必要時覆寫（需原因）或加調整項（需原因、只增不改）<br>3. 確認（財務／管理者）：檢查試算未過期、每位團主有可用金額；寫入規則版本快照<br>4. 確認後鎖定；另行走 G4 核准（不自動連動） |
| 替代／例外流程 | • 試算後有新訂單：確認被擋，需重新試算<br>• 要修正已確認結算：作廢（需原因）後重開 |
| 事後條件 | 結算確認後在資料庫層鎖定；全程標示「試算，口徑待 Owner 確認」 |
| 對應 FR | FR-FIN-01～11、FR-GATE-08、FR-COM-01～03 |

### UC-14 復盤與結案（G5）

| 項目 | 內容 |
|---|---|
| 行為者 | 營運主管／管理者 |
| 前置條件 | 檔期 SETTLED |
| 主要流程 | 1. 申請 G5；系統檢查無未結高風險例外、無未完成任務<br>2. 核准 → CLOSED |
| 替代／例外流程 | • 未通過：維持 SETTLED |
| 事後條件 | 結案後不可再變更或取消 |
| 對應 FR | FR-GATE-02、FR-CMP-06 |

### UC-15 團主自助查看

| 項目 | 內容 |
|---|---|
| 行為者 | 團主 |
| 前置條件 | 團主帳號已綁定團主 |
| 主要流程 | 1. 查看自己的檔期、行事曆、待辦、業績、預估佣金（標「預估」）<br>2. 回覆邀請（確認／婉拒，婉拒需原因）<br>3. 查看自己已確認的結算摘要（`/settlements/mine`） |
| 替代／例外流程 | • 讀他人的檔期：404<br>• 指定他人 `hostId`：被拒 |
| 事後條件 | 團主看不到成本、他團主、內部備註、檔期目標（僅自己的目標） |
| 對應 FR | FR-RBAC-02、FR-RBAC-03、FR-DSH-05、FR-CMP-05、FR-FIN-08 |

### UC-16 自動化與例外處理

| 項目 | 內容 |
|---|---|
| 行為者 | 管理者／營運主管；worker |
| 前置條件 | `AUTOMATION_ENABLED=on` 且個別工作被啟用（預設全部停用） |
| 主要流程 | 1. worker 依工作週期執行（事件、進件、提醒、逾期偵測、開團前檢查、狀態推進、每日摘要、通知派送）<br>2. 例外產生（去重）並通知負責人<br>3. 人員認領或結案例外（需說明） |
| 替代／例外流程 | • 工作失敗：留錯誤紀錄，重試最多 3 次<br>• 通知 Adapter 失敗：不影響主流程，3 次後標 DEAD 並開例外 |
| 事後條件 | 通知只進佇列與測試 Adapter，不對真人發送 |
| 對應 FR | FR-AUT-01～11 |

### UC-17 取消與暫緩

| 項目 | 內容 |
|---|---|
| 行為者 | 營運主管／管理者 |
| 前置條件 | 檔期尚未進入履約（取消）；非終態（暫緩） |
| 主要流程 | 1. 取消：任務、待核准、曝光安排一併取消，保留原狀態與原因<br>2. 暫緩：期間不可變更任務；恢復回到原狀態 |
| 替代／例外流程 | • 進入履約後不可取消<br>• 已取消不可恢復 |
| 事後條件 | 取消後新訂單被拒 |
| 對應 FR | FR-CMP-06、FR-ORD-06 |

### UC-18 稽核查詢

| 項目 | 內容 |
|---|---|
| 行為者 | 管理者／營運主管／財務 |
| 前置條件 | `audit.read` |
| 主要流程 | 1. 依實體或檔期查詢誰在何時改了什麼（前後值、原因、來源、request id） |
| 替代／例外流程 | • 財務只看到財務相關實體；團主、廠商無權 |
| 事後條件 | 稽核紀錄只增不改 |
| 對應 FR | FR-AUD-01～04、FR-RBAC-07 |

### UC-19 建立團主客群分析

| 項目 | 內容 |
|---|---|
| 行為者 | 營運小編／營運主管／管理者 |
| 前置條件 | 團主已建檔（新團主建檔後，團主清單「客群分析」欄顯示「未建立」，詳情頁顯示空狀態引導） |
| 主要流程 | 1. 在團主詳情「客群分析」選擇「新增客群」或「連結既有客群」<br>2. 填寫合作對象類型、年齡層、家庭型態、消費週期、價格帶、購買動機、購買阻力、偏好品類、活躍通路（可複選）；每項標示事實或估計，不確定留空＝未知<br>3. 選填占團主受眾比例、主要所在社群與觀察來源（證據）<br>4. 系統讀回彙整：狀態（未建立／待補資料／完整）與缺漏清單 |
| 替代／例外流程 | • 客群名稱重複：409 並回報既有 ID，可改為連結既有客群<br>• 占比合計超過 100%、社群非此團主所屬、通路非平台代碼：422<br>• 標為「事實」的證據沒有來源、內容含電話或 Email：422<br>• 團主／廠商／財務：403 |
| 事後條件 | 每個寫入有稽核（前後值）；移除一律軟刪除；空值顯示「未知」，不被當成「無」 |
| 對應 FR | FR-SEG-01～08 |

### UC-20 商品候選團主適配與覆核

| 項目 | 內容 |
|---|---|
| 行為者 | 營運小編（產生評估）；營運主管／管理者（覆核、調整評分設定） |
| 前置條件 | 商品已建檔（含類別、賣點、規格團購價更佳）；團主有客群分析者可得完整評估 |
| 主要流程 | 1. 在商品頁「候選團主適配」按「產生候選團主評估」<br>2. 系統對所有合作中團主逐一評分：總分、建議、信心、資料完整度、硬性檢查、各維度理由<br>3. 主管展開理由後覆核（同意採用／不採用／需補資料）<br>4. 客群、商品資料更新後，既有評估標示「資料已更新」，可重新評估 |
| 替代／例外流程 | • 資料不足：標示「資料不足」，不當 0 分<br>• 硬性檢查未過：BLOCKED，高分也不能抵銷<br>• 輸入相同再評估：不新增版本<br>• 已被新版取代的評估不能覆核（409）；不採用／需補資料未填原因：422 |
| 事後條件 | 每筆評估保留設定快照、來源與理由，內容寫入後不可改；覆核只記錄意見，不改任何檔期狀態 |
| 對應 FR | FR-FIT-01～09、FR-FIT-13 |

### UC-21 檔期適配、G1 查閱與結案回寫

| 項目 | 內容 |
|---|---|
| 行為者 | 營運小編（自己負責的檔期）；營運主管／管理者 |
| 前置條件 | 檔期已有商品與已邀請（未婉拒）的團主 |
| 主要流程 | 1. 在檔期「客群適配」分頁按「產生／更新適配評估」（商品 × 團主）<br>2. 核准者在 G1 核准區看到唯讀提示（共幾筆、待覆核、硬性未過），連到分頁查閱與覆核<br>3. G1 照既有規則申請與核准<br>4. 檔期 CLOSED／SETTLED 後按「回寫結案成效」，把實際歸因淨銷售、訂單數、退款率、目標達成率記到評估上 |
| 替代／例外流程 | • 他人負責的檔期：404（評估、列表、回寫皆然）<br>• 未結案回寫：412；沒有評估可回寫：412<br>• 沒有商品或沒有團主：412 |
| 事後條件 | G1 檢查項、核准者與狀態轉移不變；不自動核准、不寄通知；重複回寫內容相同不重複寫入 |
| 對應 FR | FR-FIT-10～12、FR-GATE-09 |

### UC-22 商品選品評估與廠商合作資格審查

| 項目 | 內容 |
|---|---|
| 行為者 | 營運小編（填報）；營運主管／管理者（覆核、核准調查、確認法務無虞、調整設定）；財務（唯讀） |
| 前置條件 | 商品與廠商已建檔；合作前要確認首次合作 12 類問題 |
| 主要流程 | 1. 商品頁「選品評估」按「開始評估」，為六項（客群需求符合度、品質與安全性、利潤與價格競爭力、供應商履約能力、內容展示與說服力、複購潛力）打 1–5 分並填理由，品質與供應附證據連結；另填獨立的安全合規查核<br>2. 送出後系統保存分數、完整度、信心、建議與設定快照；主管覆核（同意／不採用／需補資料）<br>3. 廠商頁「合作資格審查」新增一份調查（合約版本必填，可限定商品與受規範品類），系統自動建立 12 類項目<br>4. 逐項填結構化條款、責任方、負責人、狀態與證據；有轉售價格限制或受規範品類者自動標示「需法務／合規審查」，由主管附法務意見後確認無虞<br>5. 備齊後送審，主管核准（預設有效 365 天）或退回 |
| 替代／例外流程 | • 只評部分項目：未評＝未知，不當 0 分，完整度低於 0.5 為「資料不足」<br>• 合規未過：BLOCKED，高分不能抵銷；未查核或需法務：最多「補測／補件」<br>• 品質或供應沒有附有效證據：不能建議進入商務審查<br>• 同商品已有草稿、同廠商＋商品＋合約版本已有調查：409<br>• 標「已確認」但沒有有效證據、「不適用」沒原因、「有風險」沒說明：422<br>• 營運小編寫第 10 類（分潤）條款或核准／確認無虞：403<br>• 團主／廠商：403；他組織資料：404 |
| 事後條件 | 已送出的評估內容不可改（資料庫觸發器），重評＝新版本；核准後調查不能改證據；覆核與核准只記錄結果，不改商品審核狀態、不核准 G1；到期或證據過期自動視為失效（不改資料）；每個寫入有稽核（敏感條款不記數值） |
| 對應 FR | FR-SEL-01～09、FR-EVI-01～03、FR-DD-01～07 |

### UC-23 商品試用與商業可行性試算

| 項目 | 內容 |
|---|---|
| 行為者 | 營運小編（填報、下結論）；營運主管／管理者（覆核、覆寫建議、敏感欄位）；財務（唯讀） |
| 前置條件 | 商品已建檔；小規模測試團需商品已在該檔期內 |
| 主要流程 | 1. 商品頁「商品試用」新增試用：層級（商品資格驗證／團主・檔期適配）× 類型（內部／指定團主／小規模測試團），系統自動建立四面向檢核項<br>2. 記錄寄樣、到貨、開始、回饋、結案日期、物流與試用品回收；逐項填結果、客觀證據、缺陷嚴重度與說明<br>3. 系統給建議結論（通過／有條件通過／不通過／需重測）；填最終建議與說明後結論（通過類記錄有效期與商品指紋）；主管覆核<br>4. 商品資格仍有效時，團主適配試用自動沿用，只補客戶、內容、商業三面向<br>5. 商品頁「商業可行性」新增試算：填預估訂單、團購價、退款率（營運小編）與成本、費用、分潤、付款與負擔方（需成本檢視權限），每個數字註明假設來源；系統算出 GMV、有效淨銷售額、公司營業收入、團主分潤、公司貢獻利潤、品牌利潤、團主收入<br>6. 小規模測試團結單後回寫實際訂單、GMV、退款、客單價、客訴與出貨例外並與預測並列 |
| 替代／例外流程 | • 進行中的相同組合已存在：409<br>• 「通過」沒填客觀證據、缺陷沒說明：422<br>• 最終建議比系統建議樂觀：營運小編 403；主管需填覆寫原因，否則 422<br>• 沿用的商品資格在結論前已失效：412<br>• 缺少的輸入：結果顯示「未知」並列出缺什麼，不當 0<br>• 有金額的成本沒指定負擔方：利潤未知<br>• 營運小編填成本／分潤欄位：403；讀取時為 null 並標 restricted<br>• 別人負責的檔期：404 |
| 事後條件 | 結論後內容不可改（可補寫物流與回收）；試算假設與結果不可改，每次存檔是新版本；試用不新增任何任務狀態、不自動完成任務；商品名稱／類別／規格編號／合規備註變更使資格自動失效（價格不影響） |
| 對應 FR | FR-TRL-01～08、FR-FEA-01～04 |

### UC-24 G1 統一決策摘要（唯讀）

| 項目 | 內容 |
|---|---|
| 行為者 | 營運主管／管理者（核准者）；營運小編（自己負責的檔期）；財務（唯讀） |
| 前置條件 | 檔期已有商品；評估、調查、試用、可行性有的就彙整，沒有的列為缺口 |
| 主要流程 | 1. 檔期「選品與試用」分頁顯示每個商品的評估、合作資格審查、試用、可行性、客群適配統計與風險清單（阻礙／缺口）及總燈號<br>2. G1 核准區顯示簡短提示並連到該分頁<br>3. G1 照既有規則申請與核准 |
| 替代／例外流程 | • 他人負責的檔期：404；團主／廠商：403<br>• 營運小編的摘要沒有成本與利潤，風險訊息也不洩漏利潤正負 |
| 事後條件 | `gateImpact` 恆為 `NONE`：G1 檢查項、核准者、狀態轉移、通知、任務都不變；摘要不寫任何資料 |
| 對應 FR | FR-G1S-01～04、FR-GATE-09 |

---

## 4 功能需求

**統計**（程式現況，基準 `3be9a94`）：共 **204 條**功能需求（其中 SOP 01 新增 22 條：SEG 8、FIT 14；SOP 02／03 新增 40 條：SEL 11、EVI 3、DD 8、TRL 9、FEA 5、G1S 4）；IMPLEMENTED 161、PARTIAL 18、NOT_STARTED 18、BLOCKED 7。使用案例 24 個。SOP 02／03 部分的基準為 `feat/sop02-03-selection-trial`（migration 014）。SOP 01 部分的基準為 `feat/sop01-segment-fit`（migration 013）。

| 模組 | FR 數 | IMPLEMENTED | PARTIAL | NOT_STARTED | BLOCKED |
|---|--:|--:|--:|--:|--:|
| AUTH 認證與帳號 | 10 | 8 | 1 | 1 | 0 |
| RBAC 角色、權限與資料範圍 | 10 | 8 | 0 | 1 | 1 |
| MD 主檔：廠商、團主、社群、商品 | 14 | 10 | 2 | 2 | 0 |
| CMP 團購檔期 | 11 | 8 | 2 | 1 | 0 |
| WF 工作流程與排程引擎 | 11 | 9 | 1 | 1 | 0 |
| GATE 檔期狀態機與核准關卡（G1–G5） | 9 | 6 | 3 | 0 | 0 |
| ORD 訂單匯入 | 11 | 7 | 2 | 1 | 1 |
| DSH Dashboard 與 KPI | 12 | 9 | 1 | 1 | 1 |
| COM 佣金規則與預估佣金 | 3 | 2 | 0 | 0 | 1 |
| AUT 自動化、通知與例外 | 11 | 8 | 2 | 0 | 1 |
| FUL 履約與出貨（Phase 2） | 10 | 9 | 0 | 1 | 0 |
| AFT 退款、客訴與售後案件（Phase 2） | 12 | 10 | 0 | 1 | 1 |
| FIN 財務：結算試算、入帳、發票、費用（Phase 2） | 11 | 9 | 0 | 1 | 1 |
| AUD 稽核與資料保護 | 5 | 3 | 1 | 1 | 0 |
| UI 使用者介面 | 2 | 0 | 1 | 1 | 0 |
| SEG 客群分析（SOP 01） | 8 | 7 | 1 | 0 | 0 |
| FIT 商品適配評估（SOP 01） | 14 | 13 | 0 | 1 | 0 |
| SEL 商品選品評估（SOP 02） | 11 | 9 | 1 | 1 | 0 |
| EVI 證據連結（SOP 02／03） | 3 | 3 | 0 | 0 | 0 |
| DD 廠商合作資格審查（SOP 02） | 8 | 7 | 0 | 1 | 0 |
| TRL 商品試用（SOP 03） | 9 | 8 | 0 | 1 | 0 |
| FEA 商業可行性試算（SOP 03） | 5 | 4 | 0 | 1 | 0 |
| G1S G1 統一決策摘要（SOP 02／03） | 4 | 4 | 0 | 0 | 0 |
| **合計** | **204** | **161** | **18** | **18** | **7** |

> 狀態判定：只要有一條驗收條件沒有自動化測試保護，或實作與需求有落差，就標 PARTIAL，並在該列說明；不為了好看而標 IMPLEMENTED。

### 4.1 AUTH 認證與帳號

模組：`auth.ts`、`api/routes.ts`、`api/router.ts`。

| ID | 需求 | 優先 | 驗收條件（Given／When／Then） | 對應測試 | 狀態 | 來源 | 驗 |
|---|---|:-:|---|---|:-:|---|:-:|
| FR-AUTH-01 | 以 Email＋密碼登入／登出；錯誤帳密不洩漏帳號是否存在 | MUST | Given 有效帳號 When 以正確密碼登入 Then 設定 HttpOnly＋SameSite=Lax 的 session cookie，`/auth/me` 回角色；When 登出 Then 同一 cookie 之後回 401；錯誤密碼與不存在帳號回相同訊息的 401 | rbac ›「登入：錯誤帳密訊息一致不洩漏帳號是否存在…」 | IMPLEMENTED | ADR-006 | ✅ |
| FR-AUTH-02 | 連續登入失敗鎖定帳號（5 次、15 分鐘） | MUST | Given 同一帳號連續 5 次密碼錯誤 When 第 6 次輸入正確密碼 Then 仍被拒（429） | rbac ›「連續登入失敗會暫時鎖定帳號」（驗證鎖定效果；15 分鐘解鎖時間未被斷言） | IMPLEMENTED | ADR-006 | ✅ |
| FR-AUTH-03 | 停用帳號後既有 session 立即失效，且無法重新登入 | MUST | Given 使用者已登入 When 管理者將其停用 Then 其 session 立即回 401 且重新登入被拒 | rbac ›「停用帳號後既有 session 立即失效」 | IMPLEMENTED | ADR-006 | ✅ |
| FR-AUTH-04 | Session 12 小時到期失效 | MUST | Given session 已過期 When 呼叫任一受保護 API Then 回 401 | rbac ›「過期的 session 失效」（以直接改 `expires_at` 模擬；12 小時常數 `SESSION_TTL_HOURS` 未被測試斷言） | IMPLEMENTED | ADR-006 | ✅ |
| FR-AUTH-05 | 寫入類請求的 CSRF 與格式防護：Origin 必須等於 Host（或 X-Forwarded-Host）；僅接受 JSON | MUST | Given 已登入 When 跨來源 Origin 送出寫入 Then 403；When 內容為 form 表單 Then 415；When JSON 格式錯誤 Then 400；Origin 等於 Host 或 X-Forwarded-Host（通道／反向代理）時放行；無 Origin（腳本）放行 | rbac ›「跨來源（Origin 與 Host 不同）的寫入被拒…」；unit/misc ›「CSRF：Origin 比對」 | IMPLEMENTED | ADR-006 | ✅ |
| FR-AUTH-06 | 使用者管理：只有系統管理者可新增／停用；團主、廠商帳號必須綁定存在於同組織的團主／廠商 | MUST | Given 營運主管 When 新增使用者 Then 被拒；Given 管理者 When 新增 HOST 帳號但未綁定團主 Then 驗證失敗 | rbac ›「只有管理者能管理使用者；營運主管不行；新增團主帳號必須綁定團主」；database ›「團主帳號必須綁定團主、廠商帳號必須綁定廠商…」 | IMPLEMENTED | ADR-005 | 📄 |
| FR-AUTH-07 | 密碼強度（至少 10 字元且含英文字母與數字）；密碼以 scrypt 雜湊、每次加鹽 | MUST | Given 弱密碼 When 建立使用者 Then 驗證失敗；Given 同一密碼雜湊兩次 Then 雜湊值不同且皆可驗證 | unit/misc ›「密碼」（雜湊可驗證…、強度規則） | IMPLEMENTED | ADR-006 | 📄 |
| FR-AUTH-08 | 登入限流：每 IP 30 次／分鐘、每帳號 10 次／分鐘 | SHOULD | Given 同 IP 於視窗內超過上限 When 再次登入 Then 回 429，視窗過後恢復 | unit/misc ›「限流」（只測限流函式；`/auth/login` 路由是否套用該限制沒有被斷言。測試輔助程式會在每次請求前重設限流） | PARTIAL | ADR-006 | 📄 |
| FR-AUTH-09 | 未登入存取任何受保護 API 一律 401；`GET /api/health` 公開且不含業務資料 | MUST | Given 未登入 When 呼叫受保護端點 Then 401；When 呼叫 health Then 200 且僅含連線狀態 | rbac ›「未登入存取任何受保護 API 一律 401；健康檢查公開且不洩漏資料」 | IMPLEMENTED | ADR-006 | 📄 |
| FR-AUTH-10 | SSO／OAuth、管理者 MFA、密碼重設、首次登入強制改密碼 | SHOULD | （未實作）藍圖 §8.3 要求管理者啟用 MFA；登入方式屬待決策 #7 | — | NOT_STARTED | ADR-006；KNOWN_ISSUES K1 | — |

### 4.2 RBAC 角色、權限與資料範圍

模組：`lib/permissions.ts`、`lib/scope.ts`，各模組 `requirePerm`。權限共 52 項，6 個角色（SOP 01 新增 `segment.*`、`fit.*` 六項，團主、廠商、財務一律沒有；SOP 02／03 新增 `selection.read`／`selection.write`／`selection.config` 三項，團主、廠商沒有，財務只有 `selection.read`）。

| ID | 需求 | 優先 | 驗收條件（Given／When／Then） | 對應測試 | 狀態 | 來源 | 驗 |
|---|---|:-:|---|---|:-:|---|:-:|
| FR-RBAC-01 | 六個角色與權限矩陣固定，不得被默默放寬 | MUST | Given 權限矩陣 Then 團主／廠商沒有任何寫入、成本、佣金設定、稽核、使用者管理權限；成本只給 SYSTEM_ADMIN／OPS_MANAGER／FINANCE；佣金規則只有 SYSTEM_ADMIN／FINANCE 可寫；使用者管理只有 SYSTEM_ADMIN | unit/misc ›「權限矩陣（不可被默默放寬）」5 項 | IMPLEMENTED | ADR-005 | ✅ |
| FR-RBAC-02 | 資料範圍由後端強制：團主只看自己被邀請（未婉拒）的檔期；廠商只看自己的商品與檔期；範圍外一律 404 | MUST | Given 團主甲與乙 When 甲讀乙的檔期 Then 404（與不存在無法區分）；列表只含自己的檔期 | rbac ›「團主甲只看得到自己參與的檔期；讀乙的檔期得到 404」；rbac ›「廠商 B 看不到廠商 A 的商品」；unit/misc ›「資料範圍 SQL」 | IMPLEMENTED | ADR-003, ADR-005 | ✅ |
| FR-RBAC-03 | 欄位投影：團主看不到成本、其他團主、檔期目標（僅自己的目標）、內部備註、審核紀錄、衝突、例外 | MUST | Given 團主讀共用檔期 Then 回應不含他團主 ID／名稱、`targetRevenue`、`internalNote`、`approvals`、`conflicts`、`workflowParams`，且任務只含 HOST 角色任務 | rbac ›「團主看不到內部欄位、其他團主、檔期目標、內部備註、審核紀錄、衝突、例外」 | IMPLEMENTED | ADR-005 | ✅ |
| FR-RBAC-04 | 營運小編無成本讀寫權限；營運主管、財務可讀成本 | MUST | Given 營運小編 When 讀取／寫入商品成本 Then 看不到／被拒；營運主管與財務可 | rbac ›「營運小編看不到成本，也不能寫入成本；營運主管／財務可以」 | IMPLEMENTED | ADR-005 | 📄 |
| FR-RBAC-05 | 營運小編只看得到自己負責或被指派任務的檔期 | MUST | Given 兩位小編各自負責不同檔期 When 小編 A 列出檔期 Then 不含小編 B 的檔期 | rbac ›「營運小編只看得到自己負責的檔期；其他小編的看不到」 | IMPLEMENTED | ADR-005 | 📄 |
| FR-RBAC-06 | 跨組織隔離：另一組織的管理者看不到本組織任何資料 | MUST | Given 兩個組織 When 組織 B 的管理者查詢 Then 看不到組織 A 的資料 | rbac ›「跨組織隔離：另一個組織的管理者看不到這個組織的任何資料」 | IMPLEMENTED | ADR-003 | 📄 |
| FR-RBAC-07 | 稽核讀取範圍：財務只看到財務相關實體；營運主管看全部；團主、廠商無權 | MUST | Given 財務與營運主管 When 讀取稽核 Then 財務的結果僅含財務實體 | rbac ›「財務的稽核只看到財務相關實體；營運主管看全部」 | IMPLEMENTED | ADR-005 | 📄 |
| FR-RBAC-08 | 團主只能操作自己角色的任務、只能回覆自己的邀請，不能寫入主檔或檔期、不能核准 | MUST | Given 團主 When 嘗試寫入主檔／完成營運任務／核准 Then 被拒 | rbac ›「團主不能寫入主檔或檔期、不能核准…」；rbac ›「團主只能操作自己角色的任務…」 | IMPLEMENTED | ADR-005 | 📄 |
| FR-RBAC-09 | 客服／履約、稽核唯讀角色；匯出個資需額外權限 | SHOULD | （未實作）藍圖 §2.2 有此二角色；匯出功能本身也未做 | — | NOT_STARTED | ADR-005；RTM §A | — |
| FR-RBAC-10 | 廠商可在指定欄位回填供貨、出貨、請款資料（廠商入口） | SHOULD | （未實作，Owner 未解凍）廠商目前只能唯讀並完成自己角色的任務；回填由內部人員代登 | — | BLOCKED | KNOWN_ISSUES K7 | — |

### 4.3 MD 主檔：廠商、團主、社群、商品

模組：`vendors.ts`、`hosts.ts`、`products.ts`、`conflicts.ts`（部分）。

| ID | 需求 | 優先 | 驗收條件（Given／When／Then） | 對應測試 | 狀態 | 來源 | 驗 |
|---|---|:-:|---|---|:-:|---|:-:|
| FR-MD-01 | 廠商 CRUD：欄位驗證（統編、Email、日期、金額、百分比）、狀態（PROSPECT／CONTACTED／ACTIVE／PAUSED／BLACKLISTED） | MUST | Given 非法統編／Email When 建立廠商 Then 422 並指出欄位 | scenarios ›「API 層行為」›「資料驗證：統編、Email、日期、金額、百分比」 | IMPLEMENTED | ADR-002 | 📄 |
| FR-MD-02 | 廠商聯絡人新增與封存 | SHOULD | Given 廠商 When 新增／封存聯絡人 Then 聯絡人列表更新並寫稽核 | （只有建立廠商時帶非法 Email 的驗證測試；`POST /vendors/:id/contacts`、`/vendor-contacts/:id/archive` 沒有自動化測試） | PARTIAL | RTM §C | ❌ |
| FR-MD-03 | 廠商資料待補提示：ACTIVE 廠商缺公司全名／統編／類別／主要聯絡人時列出，可用 `missing=1` 篩選 | SHOULD | Given ACTIVE 廠商缺統編 When 讀取詳情 Then `missingFields` 含缺項且 `anomalies` 提示；列表 `missing=1` 包含該廠商 | scenarios ›「廠商資料待補提示…」 | IMPLEMENTED | RTM §C | ✅ |
| FR-MD-04 | 重複偵測：廠商（正規化名稱／統編）、團主、社群、商品、檔期以自然鍵擋下重複並回報既有 ID | MUST | Given 已有同名廠商 When 再次建立 Then 回報既有 ID，不新增；並發同名建立只成功 1 筆（資料庫唯一約束） | scenarios ›「重複表單送出」›「沒有 key 的重複送出：以自然鍵擋下…」「並發：無 key 同時建立同名廠商…」；database ›「唯一約束…」；unit/misc ›「名稱正規化」 | IMPLEMENTED | ADR-015 | 📄 |
| FR-MD-05 | 封存即軟刪除：有未結案檔期的廠商／團主不可封存；封存後資料列仍在、需原因並寫稽核；可用同名重新建立 | MUST | Given 廠商有進行中的檔期 When 封存 Then 被拒；檔期取消後封存成功，`deleted_at` 有值、稽核含原因 | scenarios ›「有未結案檔期的廠商／團主不能封存；結案後可封存；封存是軟刪除」 | IMPLEMENTED | ADR-007 | ✅ |
| FR-MD-06 | 暫停／黑名單廠商不能建立新檔期 | MUST | Given 廠商狀態 PAUSED When 建立檔期 Then 被拒 | scenarios ›「暫停／黑名單廠商不能建立新檔期」 | IMPLEMENTED | RTM §C | 📄 |
| FR-MD-07 | 團主 CRUD；可承接（AVAILABLE）與不可承接（BLOCKED）區間（含端點） | MUST | Given 團主有不可承接區間 When 檔期與之重疊 Then 提出高風險衝突；僅可承接區間不報 | scenarios ›「日期衝突」›「團主「不可承接」區間與檔期重疊 → 高風險…」 | IMPLEMENTED | RTM §C | 📄 |
| FR-MD-08 | 社群（LINE／FACEBOOK／INSTAGRAM／THREADS／YOUTUBE／OTHER）與團主多對多關聯（角色 OWNER／ADMIN／MEMBER）；解除關聯前須先處理未完成的曝光安排 | MUST | Given 社群有未完成曝光 When 解除關聯 Then 被拒 | scenarios ›「一檔多團主 / 同團主多社群」›「解除團主與社群關聯前，必須先處理未完成的曝光安排」；›「更新時可清空欄位／取消指派／團主社群角色」 | IMPLEMENTED | RTM §C | 📄 |
| FR-MD-09 | 團主「合作條件」結構化欄位 | COULD | （現況為文字欄位，無結構化條件；FEATURE_STATUS #6 限制） | — | PARTIAL | FEATURE_STATUS #6 | — |
| FR-MD-10 | 商品與規格（SKU）：一檔多 SKU；同商品內規格編號唯一；商品須屬於檔期的廠商 | MUST | Given 同商品兩個相同規格編號 Then 被擋；商品不屬於檔期廠商 Then 被拒 | scenarios ›「一檔多 SKU」›「同商品多規格各自一列…」「商品必須屬於檔期的廠商」；database ›「唯一約束：…同商品同規格編號…」 | IMPLEMENTED | RTM §C | 📄 |
| FR-MD-11 | 商品審核流程 DRAFT→PENDING_REVIEW→APPROVED／REJECTED：沒有規格不能送審、退回需原因、只有審核者能核准 | MUST | Given 無規格商品 When 送審 Then 被拒；退回未填原因 Then 被拒 | scenarios ›「商品審核流程：沒有規格不能送審；退回需原因；只有審核者能核准；非法轉移被擋」；rbac ›「廠商不能核准商品、不能改價格」 | IMPLEMENTED | RTM §C | 📄 |
| FR-MD-12 | 連結欄位（官網、社群網址、商品連結、素材、任務證據、進件連結）只接受 http(s) | MUST | Given `javascript:` 連結 When 儲存 Then 驗證失敗 | scenarios ›「連結欄位只接受 http(s)…」 | IMPLEMENTED | KNOWN_ISSUES（開發紀錄） | 📄 |
| FR-MD-13 | 素材檔案上傳與版本管理 | COULD | （未實作；現況只存連結） | — | NOT_STARTED | KNOWN_ISSUES K18 | — |
| FR-MD-14 | 合作協議（agreements）管理 | COULD | （僅資料表，無 API／介面） | database ›「所有核心資料表都已建立…」（只驗證表存在） | NOT_STARTED | KNOWN_ISSUES K17 | — |

### 4.4 CMP 團購檔期

模組：`campaigns.ts`、`conflicts.ts`、`tasks.ts`。

| ID | 需求 | 優先 | 驗收條件（Given／When／Then） | 對應測試 | 狀態 | 來源 | 驗 |
|---|---|:-:|---|---|:-:|---|:-:|
| FR-CMP-01 | 建立／編輯檔期：必填驗證、ID 規則（`CMP-YYYYMM-NNNN`）由資料庫計數器產生、並發建立 ID 不重複 | MUST | Given 缺必填欄位 When 建立 Then 阻擋；並發建立 Then ID 唯一且序號連續 | campaign-basic ›「建立檔期會依模板產生 15 個任務…」；database ›「ID 唯一且依規則產生」；scenarios ›「並發建立檔期：ID 不重複、序號連續遞增」 | IMPLEMENTED | ADR-014 | 📄 |
| FR-CMP-02 | 一檔多商品多 SKU、多團主（PRIMARY／CO）、團主多社群 | MUST | Given 三位團主各有多個社群 Then 每位團主只看到自己的曝光安排 | scenarios ›「一檔多團主 / 同團主多社群」›「三位團主、各自多個社群…」 | IMPLEMENTED | RTM §C | 📄 |
| FR-CMP-03 | 曝光安排：必須是該團主自己的社群；團主婉拒後不能再排；狀態 PLANNED／DONE／MISSED／CANCELLED | MUST | Given 團主已婉拒 When 新增曝光安排 Then 被拒 | scenarios ›（同上）；lifecycle ›「團主回覆」›「團主只能回覆自己的邀請…」 | IMPLEMENTED | RTM §C | ✅ |
| FR-CMP-04 | 檔期衝突提醒：同商品日期重疊（高）、同社群同期（高）、團主不可承接（高）、團主同時多檔（中，上限固定 2）；日期缺漏不判斷；已取消檔期不算 | MUST | Given 兩檔同商品日期重疊 Then 後建檔期的 `conflicts` 含 SAME_PRODUCT_OVERLAP／HIGH；不重疊或對方已取消 Then 無衝突 | scenarios ›「同一商品重複開團」›「允許再次開團…但日期重疊時提出高風險衝突」；›「一檔多團主…」›「同團主同時進行多檔 → 中度提醒；同社群同期 → 高風險」；›「日期衝突」›「缺少日期的草稿檔期不做衝突判斷」 | IMPLEMENTED | RTM §E | ✅ |
| FR-CMP-05 | 團主回覆邀請（確認／婉拒，婉拒需原因）；婉拒後該團主看不到該檔期 | MUST | Given 團主婉拒未填原因 Then 被拒；婉拒後讀取檔期 Then 找不到 | lifecycle ›「團主回覆」›「團主只能回覆自己的邀請；婉拒需原因；團主婉拒後看不到該檔期」 | IMPLEMENTED | ADR-005 | ✅ |
| FR-CMP-06 | 取消／暫緩／恢復：取消時任務、待核准、曝光安排一併取消並保留原狀態與原因；已取消不可恢復；暫緩可恢復到原狀態且暫緩期間不可變更任務；進入履約後不可取消 | MUST | Given 檔期已取消 When 恢復 Then 被拒；Given FULFILLING 以後 When 取消 Then 「不可取消」 | lifecycle ›「取消與暫緩」2 項；unit/misc ›「檔期狀態機」›「進入履約之後不可取消」；lifecycle ›「完整生命週期」（結案後不可取消） | IMPLEMENTED | ADR-008 | 📄 |
| FR-CMP-07 | 重複送出防護：`Idempotency-Key` 重送回同一筆；同 key 不同內容回 422；並發 8 個同請求只建 1 筆 | MUST | Given 相同 key When 重送建立（廠商／檔期／團主／商品）Then 回同一筆；key 相同內容不同 Then 422 | scenarios ›「重複表單送出」6 項 | IMPLEMENTED | ADR-015 | 📄 |
| FR-CMP-08 | API 通用行為：統一錯誤格式（422 含欄位訊息、404、405、500 不外洩）、4 MB 請求上限（413）、樂觀鎖（409＋目前版本） | MUST | Given 過期 `version` When 更新 Then 409 並提示目前版本；Given 超大內容 Then 413 | scenarios ›「API 層行為」3 項 | IMPLEMENTED | ADR-002 | 📄 |
| FR-CMP-09 | 檔期／廠商／團主列表的搜尋、篩選、分頁（上限 200 筆／頁）與排程日曆 | SHOULD | Given 篩選條件 When 列表 Then 只回符合者 | 僅 `vendors?missing=1`、`campaigns?limit=200` 有斷言；其餘篩選與日曆頁只由 E2E 煙霧測試覆蓋（`scripts/e2e-smoke.ts`，不在 `npm test`） | PARTIAL | RTM §C | ❌ |
| FR-CMP-10 | 檔期異動紀錄：內部角色可讀該檔期的稽核；團主、廠商不可 | SHOULD | Given 內部角色 When 讀取 `/campaigns/:id/audit` Then 取得該檔期稽核；團主 403 | rbac ›「團主不能讀其他團主資料、全部廠商、商品成本、訂單、佣金設定、稽核、使用者、自動化」（只斷言團主讀 `/campaigns/:id/audit` 為 403；內部角色讀取沒有 API 層斷言） | PARTIAL | ADR-007 | 📄 |
| FR-CMP-11 | 團主申請／提案檔期（有限欄位） | COULD | （未實作；藍圖 §2.4 標示為待決策） | — | NOT_STARTED | BP §2.4 | — |

### 4.5 WF 工作流程與排程引擎

模組：`workflow/schedule.ts`、`workflow/templates.ts`、`workflow/template-default.ts`、`tasks.ts`。

| ID | 需求 | 優先 | 驗收條件（Given／When／Then） | 對應測試 | 狀態 | 來源 | 驗 |
|---|---|:-:|---|---|:-:|---|:-:|
| FR-WF-01 | 預設模板 `GROUPBUY_STANDARD` v1：15 個任務、8 個階段；建立檔期自動產生任務（選擇性任務為 SKIPPED） | MUST | Given 預設模板 Then 通過驗證（無循環、相依存在）、15 步、涵蓋 8 階段；建立檔期後有 15 個任務 | unit/schedule ›「預設流程模板」›「通過驗證：無循環、相依存在、15 步、涵蓋八個階段」；campaign-basic ›「建立檔期會依模板產生 15 個任務」 | IMPLEMENTED | ADR-004 | ✅ |
| FR-WF-02 | 排程規則：結束日＝開始日＋天數−1；下一步＝前一步結束日＋1；以開團／結團日為錨點的步驟（開團前檢查、開團、話題、催單、結單、結算、請款） | MUST | Given 試用品可寄出日 2026-11-01 Then 寄樣 11/01–11/07、試用 11/08–11/21、回饋 11/22–11/24、G1 11/25、圖文 11/26–12/02 | unit/schedule ›「SOP 日期鏈…」「以開團／結團日為錨點的步驟…」 | IMPLEMENTED | ADR-009 | ✅ |
| FR-WF-03 | 缺錨點日期時不亂排：任務日期為空並標示原因；圖文來不及於開團前檢查前完成時標 `schedule_issue` | MUST | Given 無試用品可寄出日 Then 任務日期為空並說明原因 | unit/schedule ›「缺少錨點日期時不亂排…」「排程衝突檢查…」 | IMPLEMENTED | ADR-009 | 📄 |
| FR-WF-04 | 選擇性任務：Live Talk、試用品回收條件不成立時 SKIPPED；條件成立（經預覽確認）後變 TODO；相依被略過的步驟「穿透」到更前面的步驟 | MUST | Given 設定 Live Talk 日期 When 預覽並確認 Then LIVE_TALK 出現；移除後略過 | unit/schedule ›「選擇性步驟…」「相依到被略過的步驟時「穿透」…」；reschedule ›「條件任務：加入 Live Talk 日期與回收需求後任務自動出現；移除後略過」 | IMPLEMENTED | ADR-009 | 📄 |
| FR-WF-05 | 日期變更先預覽再確認：預覽無副作用；套用需帶預覽代碼，預覽後有人改動則代碼失效；稽核留前後值 | MUST | Given 預覽後任務被他人修改 When 以舊代碼套用 Then 被拒要求重新預覽；預覽前後資料完全相同 | reschedule ›「日期變更：先預覽，確認才套用」2 項（含「套用後：只更新未鎖定、未完成的任務…稽核留有前後值」） | IMPLEMENTED | ADR-009 | ✅ |
| FR-WF-06 | 已排程以後的檔期改日期：必須填原因且限營運主管／管理者；進行中不可改開團日；核准後改日期留下例外供追蹤；已取消／已結案不可調整 | MUST | Given 已排程檔期 When 小編不填原因套用 Then 被拒；主管填原因可套用並產生 SCHEDULE_CHANGED_AFTER_APPROVAL 例外；進行中改開團日 Then 被拒 | reschedule ›「已排程／進行中的檔期：不得未經核准就改日期」2 項 | IMPLEMENTED | ADR-009 | ✅ |
| FR-WF-07 | 人工調整單一任務日期＝鎖定（需原因）；重排不覆寫鎖定任務與已完成任務 | MUST | Given 任務被鎖定 When 預覽重排 Then 該任務標 `blocked_by_lock` 並維持原日期，下游以鎖定日期為準 | unit/schedule ›「日期變更影響預覽」›「被人工鎖定的任務…」「已完成的任務不會被改動…」；reschedule ›「套用後：只更新未鎖定、未完成的任務…」 | IMPLEMENTED | ADR-009 | 📄 |
| FR-WF-08 | 模板版本化：發佈新版不影響既有檔期（保存建立當下的版本與參數快照）；既有檔期採用新天數需逐檔預覽確認；非法參數被擋 | MUST | Given 發佈 trial_days=30 的 v2 Then 舊檔期日期不變、新檔期用 30 天；舊檔期預覽並確認後才套用 | reschedule ›「修改預設天數不會默默覆寫既有檔期」（呼叫服務函式 `publishTemplateVersion`） | PARTIAL | ADR-009 | ✅ |
| FR-WF-09 | 任務：狀態（TODO／IN_PROGRESS／BLOCKED／WAITING_APPROVAL／DONE／SKIPPED／CANCELLED）、相依檢查（營運主管可填原因強制）、關卡任務不可直接改狀態、阻擋／略過／重開需原因、指派與取消指派、證據備註 | MUST | Given 前置任務未完成 When 完成後面的任務 Then 被拒「前置任務尚未完成」；暫緩期間不可變更任務 | lifecycle ›「完整生命週期」（相依順序、G 任務）；lifecycle ›「暫緩可恢復…暫緩期間不可變更任務」；rbac ›「團主只能操作自己角色的任務…」；scenarios ›「可取消任務指派」 | IMPLEMENTED | ADR-009 | ✅ |
| FR-WF-10 | 逾期判斷：未完成且 `planned_end` 早於台北今日 | MUST | Given 任務逾期 Then 列為逾期並於自動化建立例外（逾期 1 天＝中、3 天以上＝高） | automation ›「逾期偵測、試用回饋催辦、團主未回覆」2 項 | IMPLEMENTED | ADR-012 | 📄 |
| FR-WF-11 | 模板發佈介面（API／畫面）與流程步驟編輯器 | SHOULD | （現況：只能呼叫服務函式發佈新版；`src/` 與 `scripts/` 中沒有任何呼叫端，使用者無法操作。步驟編輯器未做） | — | NOT_STARTED | KNOWN_ISSUES K10 | — |

### 4.6 GATE 檔期狀態機與核准關卡（G1–G5）

模組：`workflow/state.ts`、`gates.ts`。14 種狀態：DRAFT、EVALUATING、PENDING_G1、PREPARING、PENDING_G2、SCHEDULED、RUNNING、PENDING_CLOSE_CHECK、FULFILLING、PENDING_SETTLEMENT、SETTLED、CLOSED、CANCELLED、ON_HOLD。

| ID | 需求 | 優先 | 驗收條件（Given／When／Then） | 對應測試 | 狀態 | 來源 | 驗 |
|---|---|:-:|---|---|:-:|---|:-:|
| FR-GATE-01 | 狀態機：每個狀態有定義、終態無轉出；跳步被拒；GATE 類轉移不可用「變更狀態」繞過；倒退需原因 | MUST | Given DRAFT When 直接轉 RUNNING Then 被拒；PENDING_G2 手動轉 SCHEDULED Then 被拒；倒退不填原因 Then 被拒 | unit/misc ›「檔期狀態機」4 項；lifecycle ›「狀態機防呆」›「不能用「變更狀態」繞過關卡；倒退要原因；跳步被拒」 | IMPLEMENTED | ADR-008 | 📄 |
| FR-GATE-02 | G1–G5 每個關卡：先通過系統檢查（BLOCK 必須通過、WARN 只提醒）才能申請；人工核准時重新檢查；G1／G2 申請時先進入「待核准」狀態，G3–G5 維持原狀態直到決定 | MUST | Given G1 缺團主確認與前置任務 Then 申請被擋並列出原因；全部通過後 G1→PREPARING、G2→SCHEDULED、G3→FULFILLING、G4→SETTLED、G5→CLOSED，每步有稽核前後值 | lifecycle ›「完整生命週期：草稿 → 結案（含 G1–G5）」 | IMPLEMENTED | ADR-008 | ✅ |
| FR-GATE-03 | 核准者角色：G1／G2／G5＝管理者、營運主管；G3＝＋財務；G4＝管理者、財務；營運小編不能核准 | MUST | Given 小編核准 G1 Then 「不能決定」；主管核准 G4 Then 被拒；財務核准 G4 Then 成功 | lifecycle ›「完整生命週期…」；unit/misc ›「每個角色都有定義且關卡核准者皆為有效角色」 | IMPLEMENTED | ADR-008 | ✅ |
| FR-GATE-04 | 核准被退回：回到上一狀態、保留原因；退回需填原因 | MUST | Given 申請 G1 When 主管退回未填原因 Then 被拒；填原因 Then 檔期回 EVALUATING 且原因保留 | lifecycle ›「狀態機防呆」›「核准被退回：回到上一個狀態並保留原因；退回需填原因」 | IMPLEMENTED | ADR-008 | 📄 |
| FR-GATE-05 | G2 的「高風險衝突」可由核准者填寫風險確認原因後放行（原因進核准紀錄與稽核） | MUST | Given 高風險衝突 When 核准未填風險確認 Then 被拒；填寫後核准成功且 `decision_note` 含原因 | scenarios ›「同一商品重複開團」›「G2 會因高風險衝突擋下；…風險確認原因後才可核准」 | IMPLEMENTED | ADR-008 | ✅ |
| FR-GATE-06 | 組織設定「申請人≠核准人」（`approval.require_distinct_actor`） | SHOULD | Given 設定開啟 When 申請人自己核准 Then 被拒「不得為同一人」；換人核准成功 | lifecycle ›「組織設定要求申請人≠核准人時，自己不能核准自己的申請」（以 SQL 直接寫入 `system_settings`） | PARTIAL | ADR-008 | ✅ |
| FR-GATE-07 | 手動推進限制：未到開團日不可轉 RUNNING、未過結團日不可轉待結單；營運主管可填原因強制，小編不能 | MUST | Given SCHEDULED 且未到開團日 When 小編轉 RUNNING Then 「尚未到開團日」；小編 force 仍被拒；主管填原因 force 成功 | lifecycle ›「完整生命週期…」（手動開團段落） | IMPLEMENTED | ADR-008 | ✅ |
| FR-GATE-08 | G4（結算確認）檢查：請款任務（INVOICE_REQUEST）已完成為 BLOCK；另有一條提示「結算試算（Phase 2 尚未實作）」 | MUST | Given 請款作業未完成 When 申請 G4 Then 被擋；完成後可申請且只有財務／管理者能核准 | lifecycle ›「完整生命週期…」（G4 段落，只斷言請款檢查與核准者角色）。注意：那條提示在程式中恆為 WARN（`ok: false`），但結算模組已實作，文字已過時；結算確認也不會自動連動 G4（見第 11 節落差 G-01、G-02） | PARTIAL | ADR-008, ADR-013 | ✅ |
| FR-GATE-09 | 關卡其他檢查：G1（廠商可合作、商品與規格啟用、至少一位團主確認）、G2（日期、開團日不早於今天、商品皆通過審核且有價格、已排曝光、衝突）、G3（已過結團日；訂單存在與新鮮度為 WARN）、G5（無未結高風險例外、無未完成任務） | MUST | Given 各關卡條件 Then 系統檢查以 BLOCK／WARN 呈現（`GET /campaigns/:id/gates/:gate`） | lifecycle ›「完整生命週期…」涵蓋 G1／G2／G3／G4 的部分檢查項；G5 的兩項檢查與 G1 的 `vendor_ok`／`has_products` 沒有被個別斷言 | PARTIAL | ADR-008 | 📄 |

### 4.7 ORD 訂單匯入

模組：`orders.ts`、`lib/csv.ts`。唯一的訂單進入路徑是 CSV。

| ID | 需求 | 優先 | 驗收條件（Given／When／Then） | 對應測試 | 狀態 | 來源 | 驗 |
|---|---|:-:|---|---|:-:|---|:-:|
| FR-ORD-01 | CSV 匯入：每列一個品項，同 `source_order_id` 合併為一張訂單；金額由品項加總；建立品項與團主歸因；批次可追溯（來源、檔名、資料截至時間） | MUST | Given 含 7 張訂單的 CSV When 匯入 Then 6 張入庫（含狀態 PAID／PARTIAL_REFUND／REFUNDED／CANCELLED／PENDING），O1 金額為 3100 且有 2 個品項 | orders-dashboard ›「訂單 CSV 匯入」›「成功匯入：訂單、品項、歸因都建立；金額由品項加總；批次可追溯」 | IMPLEMENTED | ADR-011 | ✅ |
| FR-ORD-02 | 同一份檔案（內容 sha256）不能匯入兩次 | MUST | Given 已匯入某檔 When 再匯入同內容 Then 「已匯入過」，訂單不重複 | orders-dashboard ›「同一份檔案不能匯入兩次（內容 checksum）」 | IMPLEMENTED | ADR-011 | ✅ |
| FR-ORD-03 | 跨檔去重：(來源, 來源訂單編號) 相同且內容相同略過；退款／狀態變動則更新並寫稽核（前後值）；品項被改動進錯誤佇列（ITEMS_CHANGED） | MUST | Given 與既有訂單重疊的新檔 Then 新增 1、更新 1、略過 1、錯誤 1；O3 退款由 500 更新為 900 且稽核 `order.update_from_import` 有前後值 | orders-dashboard ›「不同檔案含重疊訂單：內容相同略過、退款有變動則更新（留稽核）、品項被改則進錯誤佇列」 | IMPLEMENTED | ADR-011 | ✅ |
| FR-ORD-04 | 錯誤列進入待處理佇列（UNKNOWN_CAMPAIGN、BAD_ORDERED_AT、BAD_STATUS、BAD_QUANTITY、BAD_PRICE、UNKNOWN_SKU、BAD_REFUND、HOST_NOT_IN_CAMPAIGN、FUTURE_ORDER、MISSING_ORDER_ID），不阻擋其餘正確列 | MUST | Given 12 列中 11 列有誤 When 匯入 Then 狀態 PARTIAL、1 筆入庫、11 筆錯誤依列號有對應代碼 | orders-dashboard ›「錯誤列進入待處理佇列而不是消失；正確的列照常匯入」 | IMPLEMENTED | ADR-011 | ✅ |
| FR-ORD-05 | 檔案層級驗證：缺必要欄位、未知欄位、僅標題列、空檔都被拒 | MUST | Given 缺欄位／多餘欄位／空檔 When 匯入 Then 拒絕並說明 | orders-dashboard ›「檔案層級的錯誤：缺必要欄位、未知欄位、空檔、非 CSV」 | IMPLEMENTED | ADR-011 | ✅ |
| FR-ORD-06 | 已取消的檔期不接受新訂單（批次 FAILED／CAMPAIGN_CANCELLED）；使用者不能匯入 DEMO 來源資料 | MUST | Given 已取消檔期 When 匯入 Then FAILED；使用者帶 `origin: DEMO` Then 422 | orders-dashboard ›「取消的檔期不接受新訂單；DEMO 資料不能由使用者匯入」 | IMPLEMENTED | ADR-011 | ✅ |
| FR-ORD-07 | 匯入權限：團主、廠商不能匯入；匯入僅限 `order.import` | MUST | Given 團主 When 匯入 Then 「沒有權限」 | orders-dashboard ›「團主與廠商不能匯入訂單」 | IMPLEMENTED | ADR-005 | ✅ |
| FR-ORD-08 | 匯入錯誤的處理流程（標記已處理／忽略） | SHOULD | Given 錯誤列 When 標記處理 Then 狀態 RESOLVED／IGNORED 並記錄處理人 | `POST /import-errors/:id/resolve` 沒有自動化測試 | PARTIAL | RTM §H | ❌ |
| FR-ORD-09 | 訂單去識別化：只存 `buyer_ref` 代號，不存姓名／電話／地址 | MUST | Given 匯入檔 Then 系統無姓名／電話／地址欄位；是否真的去識別化由人工在匯入前確保 | （資料表沒有個資欄位；`import` 不驗證代號內容 — KNOWN_ISSUES K15） | PARTIAL | ADR-011 | 📄 |
| FR-ORD-10 | 電商平台 API／Webhook 訂單同步 | MUST | （缺平台與憑證） | — | BLOCKED | ADR-011；待決策 #3 | — |
| FR-ORD-11 | 訂單明細頁；結單快照 | SHOULD | （未實作） | — | NOT_STARTED | KNOWN_ISSUES K14、K20 | — |

### 4.8 DSH Dashboard 與 KPI

模組：`dashboard.ts`、`lib/kpi.ts`（口徑單一來源）。KPI 口徑見 DASHBOARD_SPEC，**口徑待 Owner 確認**（ADR-010）。

| ID | 需求 | 優先 | 驗收條件（Given／When／Then） | 對應測試 | 狀態 | 來源 | 驗 |
|---|---|:-:|---|---|:-:|---|:-:|
| FR-DSH-01 | 管理者 Dashboard KPI：GMV、退款、淨銷售、有效訂單、AOV、退款率；口徑＝計入 PAID／PARTIAL_REFUND／REFUNDED，PENDING、CANCELLED 不計 | MUST | Given 已知訂單 Then KPI 等於以口徑手算的結果 | orders-dashboard ›「Dashboard 口徑與一致性」›「管理者 KPI 等於以口徑定義手算的結果…」；unit/kpi ›「KPI 口徑」8 項 | IMPLEMENTED | ADR-010 | 📄 |
| FR-DSH-02 | 目標達成率＝累計淨銷售÷目標；目標為空或 0 顯示「—」；未歸因金額明列 | MUST | Given 檔期無目標 Then 達成率為 null（不是 0%） | orders-dashboard ›「目標達成率＝累計淨銷售 ÷ 目標；未歸因金額被明確列出」；unit/kpi ›「達成率…」 | IMPLEMENTED | ADR-010 | 📄 |
| FR-DSH-03 | 尚無訂單時顯示「待串接」：資料品質 NO_DATA，所有業績 KPI 為 null，不產生假業績 | MUST | Given 無訂單 When 開管理者與團主 Dashboard Then 狀態 NO_DATA、狀態標籤含「待串接」、GMV／淨銷售／達成率／預估佣金皆為 null | orders-dashboard ›「尚無訂單：待串接狀態，不顯示任何假業績」 | IMPLEMENTED | ADR-010 | ✅ |
| FR-DSH-04 | 管理端與團主端同口徑：同一位團主的淨銷售在兩邊一致 | MUST | Given 同一團主 Then 管理端團主績效與團主 Dashboard 淨銷售相等 | orders-dashboard ›「管理端與團主端同口徑…」 | IMPLEMENTED | ADR-010 | 📄 |
| FR-DSH-05 | 團主 Dashboard：我的檔期（含我的目標）、行事曆、待辦、業績、預估佣金（標示「預估」與規則）、試用與素材狀態、結算進度；團主只看到自己 | MUST | Given 團主乙 Then 回應不含團主一的名稱／ID；指定他人 `hostId` 被拒；內部人員可用團主視角預覽且內容相同 | orders-dashboard ›「團主看到的資料不含其他團主的業績」；rbac ›「團主 Dashboard：只能看自己；指定別人的 hostId 被拒；內部人員可用團主視角預覽」 | IMPLEMENTED | ADR-005, ADR-010 | ✅ |
| FR-DSH-06 | 資料品質警告：未處理匯入錯誤、最近資料超過 3 天未更新、匯入 PARTIAL／FAILED、含 DEMO、佣金費率未設定 | MUST | Given 有匯入錯誤 Then 兩邊都有警告；資料截至 5 天前 Then 警告「3 天未更新」 | orders-dashboard ›「資料品質：有未處理的匯入錯誤時，兩邊都有警告」「資料延遲：最近一次資料截至超過 3 天會警告」 | IMPLEMENTED | ADR-010 | ✅ |
| FR-DSH-07 | DEMO 資料明確標示（DEMO／MIXED 顯示橫幅） | MUST | Given DEMO 來源訂單 Then 狀態 DEMO 且標籤含「不是真實」 | orders-dashboard ›「DEMO 標示」 | IMPLEMENTED | ADR-011 | ✅ |
| FR-DSH-08 | 敏感欄位不經 Dashboard 外洩：無 `campaign.sensitive.read` 的角色看不到檔期目標與達成率 | MUST | Given 小編負責有目標的檔期 Then Dashboard 有 GMV 但 `targets` 為 null 且回應不含目標數字 | orders-dashboard ›「敏感欄位不經 Dashboard 外洩」 | IMPLEMENTED | ADR-005 | ✅ |
| FR-DSH-09 | 月份切換（台北日曆月）、非法月份被拒；小編只看到自己負責檔期的業績；無 `order.read` 的角色無業績區塊 | MUST | Given 其他月份無訂單 Then 有效訂單 0 且仍帶口徑；`2020-13` 被拒 | orders-dashboard ›「月份切換…」「營運小編只看到自己負責檔期的業績…」 | IMPLEMENTED | ADR-010 | ✅ |
| FR-DSH-10 | KPI 可追溯：每個 KPI 隨回應帶來源與公式 | SHOULD | Given Dashboard 回應 Then 含 `kpiDefinitions`（程式已回傳於 `dashboard.ts`） | 沒有測試斷言 `kpiDefinitions` 或 KPI 的 `source`／`formula` 欄位 | PARTIAL | ADR-010 | ❌ |
| FR-DSH-11 | 趨勢圖、預測、每日快取／結單快照 | COULD | （未實作；Dashboard 為即時查詢） | — | NOT_STARTED | KNOWN_ISSUES K20 | — |
| FR-DSH-12 | 與一檔歷史結案數字的手工對帳 | MUST | （無真實歷史資料） | — | BLOCKED | KNOWN_ISSUES T4 | — |

### 4.9 COM 佣金規則與預估佣金

模組：`commission.ts`、`lib/commission-calc.ts`。**金額口徑待 Owner 確認**；不套用招財兔分潤公式（ADR-013）。

| ID | 需求 | 優先 | 驗收條件（Given／When／Then） | 對應測試 | 狀態 | 來源 | 驗 |
|---|---|:-:|---|---|:-:|---|:-:|
| FR-COM-01 | 佣金規則版本化：檔期專屬規則優先於團主預設；修改＝新增一版並封存舊版；只有 SYSTEM_ADMIN／FINANCE 可寫；團主只讀自己的 | MUST | Given 非財務角色 When 建立規則 Then 403；財務輸入費率 101 Then 422；團主列出規則只看到自己的 | scenarios ›「API 層行為」›「資料驗證…」（含 `/commission-rules` 403／422）；rbac ›「佣金規則：只有財務／管理者可寫；團主只讀到自己的」 | IMPLEMENTED | ADR-013 | 📄 |
| FR-COM-02 | 預估佣金＝歸因有效淨銷售×費率，四捨五入到整數元；沒有適用費率不猜並提示（顯示「尚未設定」） | MUST | Given 有費率 Then 預估值＝round(淨銷售×費率)；無費率 Then null 並提示 | orders-dashboard ›「預估佣金：有費率才估、四捨五入、標示為預估；沒有費率不猜並提示」；unit/kpi ›「預估佣金…」 | IMPLEMENTED | ADR-013 | 📄 |
| FR-COM-03 | 階梯費率、含稅／未稅差異、扣項（運費、平台費、退款扣回時點）、分潤比例與順序 | MUST | （口徑未定義，Owner 決策） | — | BLOCKED | ADR-013；待決策 #5 | — |

### 4.10 AUT 自動化、通知與例外

模組：`automation.ts`、`notifications.ts`、`intake.ts`、`scripts/worker.ts`。8 個工作預設全部停用。

| ID | 需求 | 優先 | 驗收條件（Given／When／Then） | 對應測試 | 狀態 | 來源 | 驗 |
|---|---|:-:|---|---|:-:|---|:-:|
| FR-AUT-01 | 安全欄杆：新組織 8 個工作預設停用；停用時執行回 SKIPPED 且無副作用；啟用／停用需管理者或營運主管並寫稽核 | MUST | Given 新組織 When 執行任一工作 Then SKIPPED(disabled)；小編啟用 Then 沒有權限 | automation ›「自動化安全欄杆：預設停用、可停用、有紀錄」2 項 | IMPLEMENTED | ADR-012 | 📄 |
| FR-AUT-02 | 冪等與重試：(工作, 冪等鍵) 唯一；失敗留錯誤紀錄，再次執行重試同一筆，最多 3 次；鍵粒度（分鐘／小時／日）固定 | MUST | Given 工作失敗 When 修好後再執行 Then 重試同一筆（attempts+1，上限 3） | automation ›「失敗可查、可重試」›「Job 失敗時留下錯誤紀錄；修好後再執行會重試同一筆（最多 3 次）」；unit/misc ›「自動化預設冪等鍵的粒度」 | IMPLEMENTED | ADR-012 | 📄 |
| FR-AUT-03 | 事件處理：建立檔期後確保任務齊全並通知負責人（重複處理不重複）；核准申請通知「有權限決定的人」（不含小編） | MUST | Given 同一事件處理兩次 Then 任務與通知不重複 | automation ›「事件處理：建立檔期後產生任務與通知，不重複」2 項 | IMPLEMENTED | ADR-012 | 📄 |
| FR-AUT-04 | 逾期偵測與催辦：任務逾期建立例外（去重）；試用回饋逾期＝團主未回覆（團主標 NO_RESPONSE、通知團主與負責人）；修正後例外自動結案 | MUST | Given 試用回饋逾期 Then 例外升級為高風險、通知、團主標未回覆；補齊後自動結案 | automation ›「逾期偵測、試用回饋催辦、團主未回覆」2 項 | IMPLEMENTED | ADR-012 | 📄 |
| FR-AUT-05 | 開團前檢查（開團前 3 天內重跑 G2 檢查，不通過開高風險例外並通知；不自動核准／開團）與狀態推進（已排程→進行中；過結團日→待結單確認；系統操作稽核 `actor_type=SYSTEM`） | MUST | Given 三檔：開團日已過／結團日已過／未到開團日 Then 分別變 RUNNING／PENDING_CLOSE_CHECK／維持 SCHEDULED，稽核為 SYSTEM／WORKER，再跑不重複推進 | automation ›「開團前檢查與狀態推進」2 項 | IMPLEMENTED | ADR-012 | ✅ |
| FR-AUT-06 | 每日營運摘要：每天一份（`daily_summaries`）並對管理者／營運主管排入 EMAIL 通知；重複執行冪等 | SHOULD | Given 同一天執行兩次 Then 只有一份摘要、一組通知 | automation ›「每日摘要：冪等」 | IMPLEMENTED | ADR-012 | 📄 |
| FR-AUT-07 | 通知佇列與 Adapter：IN_APP 直接送達；EMAIL／LINE 只經測試 Adapter（不對真人發送）；Adapter 失敗不影響主流程，重試後標 DEAD 並建立例外 | MUST | Given 外部通知服務不可用 Then 主流程不受影響，通知 3 次後 DEAD 並產生 NOTIFICATION_DEAD 例外 | automation ›「失敗可查、可重試」›「外部通知服務不可用…」「通知佇列：站內通知直接送達；EMAIL 只經測試 Adapter」 | IMPLEMENTED | ADR-012 | 📄 |
| FR-AUT-08 | 廠商進件：以 `externalSubmissionId` 去重；正規化名稱／統編配對既有廠商；建立廠商、商品、草稿檔期與任務；黑名單廠商或分潤％無法判斷 → NEEDS_REVIEW；欄位驗證；不寫佣金規則 | MUST | Given 同一份表單送兩次 Then 一筆進件；同廠商再次進件 Then 配對既有廠商；黑名單 Then 待人工確認 | automation ›「新廠商資料進件」4 項（服務層呼叫；介面只有 API，沒有進件頁面） | IMPLEMENTED | ADR-012 | 📄 |
| FR-AUT-09 | 例外管理：類型（TASK_OVERDUE、HOST_NO_RESPONSE、PRELAUNCH_CHECK_FAILED、SCHEDULE_CHANGED_AFTER_APPROVAL、NOTIFICATION_DEAD）、嚴重度、`dedupe_key` 去重、自動結案；人工認領／結案（需說明、寫稽核） | MUST | Given 例外 When 人工 ACKNOWLEDGED／RESOLVED Then 狀態更新並稽核 | 自動開立、去重、自動結案有測試（automation）；`POST /exceptions/:id/status` 的人工認領／結案沒有自動化測試 | PARTIAL | ADR-012 | ❌ |
| FR-AUT-10 | 站內通知列表與標示已讀 | SHOULD | Given 使用者有通知 When 開通知頁並標示已讀 Then 狀態變 READ | 通知的建立與派送有測試；`GET /notifications`、`/notifications/all`、`POST /notifications/:id/read` 沒有自動化測試 | PARTIAL | ADR-012 | ❌ |
| FR-AUT-11 | 真實 LINE／Email 發送、電商 API、Google Workspace／Sheets／日曆同步 | MUST | （缺憑證與 Owner 授權；`NOTIFY_ADAPTER` 設成其他值會拋 BLOCKED） | — | BLOCKED | ADR-012, ADR-019 | — |

### 4.11 FUL 履約與出貨（Phase 2）

模組：`fulfillment.ts`；詳見 `docs/phase2/FULFILLMENT.md`。

| ID | 需求 | 優先 | 驗收條件（Given／When／Then） | 對應測試 | 狀態 | 來源 | 驗 |
|---|---|:-:|---|---|:-:|---|:-:|
| FR-FUL-01 | 出貨批次（SAMPLE／ORDER）與出貨單：PENDING→PACKED→SHIPPED→DELIVERED；異常（需原因）可回到後續狀態；DELIVERED、CANCELLED 為終點；批次狀態由出貨單彙總 | MUST | Given 出貨單包裝→出貨→送達 Then 批次狀態跟著彙總；不可跳過出貨直接簽收；出貨前須有物流商；日期不可是未來、送達不可早於出貨 | fulfillment ›「純函式：批次彙總與提醒」；›「出貨批次與出貨單：完整流程」›「建立批次與出貨單…」「狀態只能依轉移表走…」「PACKED → SHIPPED → DELIVERED…」 | IMPLEMENTED | FEATURE_STATUS #28 | 📄 |
| FR-FUL-02 | 訂單出貨批次最早從 SCHEDULED 起建立；寄樣批次不受限；檔期取消／暫緩／結案後履約資料唯讀 | MUST | Given 草稿檔期 When 建立訂單出貨批次 Then 被擋；寄樣批次可建立 | fulfillment ›「訂單出貨批次在「草稿」檔期建立會被擋；寄樣批次可以」「檔期取消／暫緩／結案後履約資料唯讀」 | IMPLEMENTED | FEATURE_STATUS #28 | 📄 |
| FR-FUL-03 | 同物流商＋追蹤碼（不分大小寫）在未取消的出貨單上不可重複；規格須屬於該檔期 | SHOULD | Given 相同物流商與追蹤碼 When 新增第二張出貨單 Then 被拒 | fulfillment ›「規格必須屬於該檔期；相同物流商＋追蹤碼不可重複（大小寫不分）」 | IMPLEMENTED | FEATURE_STATUS #28 | 📄 |
| FR-FUL-04 | 出貨異常：必填原因、批次變 EXCEPTION、通知負責人且只通知一次 | SHOULD | Given 出貨單標異常 Then 批次為 EXCEPTION 並排入一則通知；處理後可繼續 | fulfillment ›「異常：必填原因、批次變異常、通知負責人且只通知一次；處理後可繼續」 | IMPLEMENTED | FEATURE_STATUS #28 | 📄 |
| FR-FUL-05 | 簽收確認：只能對已送達的出貨單；重送不覆蓋（冪等）；全部送達後批次為 DELIVERED | MUST | Given 未送達 When 簽收 Then 被拒；已簽收再送 Then 不覆蓋 | fulfillment ›「簽收確認：未送達不能簽；簽收後重送不覆蓋；全部送達後批次為 DELIVERED」 | IMPLEMENTED | FEATURE_STATUS #28 | 📄 |
| FR-FUL-06 | 取消批次：需原因、連動取消未送達的出貨單、已有送達者不可整批取消、取消後唯讀；樂觀鎖與清空欄位 | SHOULD | Given 批次內已有送達出貨單 When 整批取消 Then 被拒 | fulfillment ›「取消批次…」「編輯批次／出貨單：樂觀鎖版本衝突；空字串清空欄位；已出貨不可改數量」 | IMPLEMENTED | FEATURE_STATUS #28 | 📄 |
| FR-FUL-07 | 庫存異動 append-only：期初庫存只能設一次、庫存不可為負；更正＝新增反向異動（同一筆只能更正一次、更正紀錄不可再更正）；資料庫層禁止改寫與刪除 | MUST | Given 庫存異動 When 直接 UPDATE／DELETE Then 資料庫拒絕；更正使餘額為負 Then 被擋 | fulfillment ›「庫存異動（append-only）」5 項 | IMPLEMENTED | FEATURE_STATUS #28 | 📄 |
| FR-FUL-08 | 履約提醒（只提醒不擋關卡）：履約中沒有批次、異常、逾期未出貨、結算中仍有未送達、未簽收 | SHOULD | Given 結算中仍有未送達出貨單 Then 出現 WARN 但不阻擋任何動作 | fulfillment ›「結算中仍有未送達出貨單會出現 WARN，但不阻擋任何動作」；›「純函式…fulfillmentWarnings」 | IMPLEMENTED | FEATURE_STATUS #28 | 📄 |
| FR-FUL-09 | 履約權限與範圍：營運主管／負責的小編可讀寫；財務唯讀；團主、廠商只讀自己範圍且看不到內部備註與庫存（403）；範圍外 404；寫入有稽核 | MUST | Given 非負責的小編 Then 404；團主讀批次 Then 無內部備註；團主讀庫存 Then 403 | fulfillment ›「API：權限、資料範圍與重複送出」（未登入／主管與小編／財務／團主／廠商 5 項）；›「每個寫入都有稽核紀錄（含前後值）；資料不能實體刪除」 | IMPLEMENTED | FEATURE_STATUS #28 | 📄 |
| FR-FUL-10 | 庫存隨出貨自動扣除、預留／安全庫存、物流商 API／追蹤查詢、出貨單匯入、團主／廠商自行簽收 | SHOULD | （刻意未做或需解凍廠商入口） | — | NOT_STARTED | FULFILLMENT.md 限制 3–5；KNOWN_ISSUES P2-4 | — |

### 4.12 AFT 退款、客訴與售後案件（Phase 2）

模組：`aftersales.ts`；詳見 `docs/phase2/AFTERSALES.md`。

| ID | 需求 | 優先 | 驗收條件（Given／When／Then） | 對應測試 | 狀態 | 來源 | 驗 |
|---|---|:-:|---|---|:-:|---|:-:|
| FR-AFT-01 | 建立售後案件（REFUND／COMPLAINT／EXCHANGE／OTHER）：關聯檔期（必填）與訂單（選填）；個資防呆（含手機號碼／Email 被擋）；冪等；處理紀錄與稽核 | MUST | Given 描述含手機號碼 When 建案 Then 被拒；同 key 不同內容 Then 422；成功後讀回欄位、處理紀錄與稽核 | aftersales ›「建立案件」3 項 | IMPLEMENTED | FEATURE_STATUS #29 | 📄 |
| FR-AFT-02 | 案件狀態機 OPEN→IN_PROGRESS⇄WAITING_VENDOR→RESOLVED→CLOSED；取消與重新開啟需原因；終態不可離開；RESOLVED 需處理結果；樂觀鎖 | MUST | Given 非法轉移 Then 412；帶舊版本號 Then 409 | aftersales ›「案件狀態機」3 項 | IMPLEMENTED | FEATURE_STATUS #29 | 📄 |
| FR-AFT-03 | 團主／廠商只看得到自己範圍的案件摘要與「對外可見」備註；看不到描述、買家代號、訂單、負責人、內部備註、退款；範圍外 404 | MUST | Given 團主 Then 回應鍵集合僅含摘要欄位且不含「內部」字樣；別的團主／廠商 Then 404；內部角色看到完整欄位 | aftersales ›「權限與資料範圍」›「團主／廠商：只看得到自己範圍的案件摘要…」 | IMPLEMENTED | FEATURE_STATUS #29 | ✅ |
| FR-AFT-04 | 權限：小編可處理不可核准；主管可核准不可完成；財務可讀並完成不可核准；團主、廠商只讀；財務／團主／廠商不能建案（403） | MUST | Given 財務建案 Then 403；小編處理非負責檔期 Then 404 | aftersales ›「權限矩陣（定義）」；›「權限與資料範圍」2 項 | IMPLEMENTED | FEATURE_STATUS #29 | 📄 |
| FR-AFT-05 | 退款申請金額不得超過可退餘額（訂單金額−已退−其他申請中）；併發申請只成功一筆；訂單狀態須為 PAID／PARTIAL_REFUND；案件須處理中 | MUST | Given 兩個併發申請合計超過餘額 Then 只有一筆成功；剛好等於餘額可以；PENDING 訂單 Then 拒絕 | aftersales ›「退款申請：金額邊界」3 項 | IMPLEMENTED | FEATURE_STATUS #29 | 📄 |
| FR-AFT-06 | 退款核准／退回：僅主管與管理者；退回必填原因；已決定不能再決定；申請者收到通知；範圍外 404 | MUST | Given 小編核准 Then 403；退回未填原因 Then 被拒 | aftersales ›「退款核准」3 項 | IMPLEMENTED | FEATURE_STATUS #29 | 📄 |
| FR-AFT-07 | 完成退款：僅財務／管理者；預設不寫回訂單（`writeback` 必須明確為 `true`）；寫回時同交易內鎖訂單、重驗餘額、更新 `refund_amount` 與訂單狀態並寫稽核，失敗整筆回滾；併發完成只成功一次 | MUST | Given writeback=true Then 訂單 PAID→PARTIAL_REFUND→REFUNDED 且稽核有前後值；餘額漂移 Then 回滾，退款維持「已核准」；字串 "true" Then 422 | aftersales ›「完成退款與寫回訂單」7 項；›「API 串接」›「writeback 一定要明確傳 true 才會寫回」 | IMPLEMENTED | FEATURE_STATUS #29 | 📄 |
| FR-AFT-08 | 案件與退款連動限制：尚有待核准／待完成退款時，案件不能標記已解決或取消 | SHOULD | Given 有待核准退款 When 標記已解決 Then 被拒；退款完成後可以 | aftersales ›「案件與退款的連動限制」 | IMPLEMENTED | FEATURE_STATUS #29 | 📄 |
| FR-AFT-09 | 案件與退款不可實體刪除；處理紀錄 `case_events` 不可 UPDATE／DELETE | MUST | Given 直接 DELETE／UPDATE Then 資料庫拒絕 | aftersales ›「不可實體刪除／處理紀錄不可改」 | IMPLEMENTED | ADR-007 | 📄 |
| FR-AFT-10 | 列表篩選（狀態／類型／優先級／檔期／負責人／逾期／搜尋）與總覽統計（與資料庫直接計算一致；外部角色無退款金額） | SHOULD | Given 各篩選條件 Then 結果受範圍限制；總覽數字與 SQL 直接計算一致 | aftersales ›「列表與總覽」3 項 | IMPLEMENTED | FEATURE_STATUS #29 | 📄 |
| FR-AFT-11 | 逾期案件接入例外自動化；案件附件上傳；SLA 計時；客戶端查詢入口；售後卡片嵌入 Dashboard | COULD | （未實作；客戶入口涉及對外存取需 Owner 解凍） | — | NOT_STARTED | AFTERSALES.md 限制；KNOWN_ISSUES P2-5 | — |
| FR-AFT-12 | 真實金流退款 | MUST | （不處理；「完成」僅代表人工確認已退款） | — | BLOCKED | AFTERSALES.md | — |

### 4.13 FIN 財務：結算試算、入帳、發票、費用（Phase 2）

模組：`settlements.ts`、`finance.ts`；詳見 `docs/phase2/FINANCE.md`。**所有金額都是「試算」或「紀錄」，口徑待 Owner 確認，非正式付款依據。**

| ID | 需求 | 優先 | 驗收條件（Given／When／Then） | 對應測試 | 狀態 | 來源 | 驗 |
|---|---|:-:|---|---|:-:|---|:-:|
| FR-FIN-01 | 結算試算只重用既有預估佣金口徑（歸因淨銷售×生效費率，四捨五入）；無適用費率有銷售時為 null（不猜）、淨銷售 0 時為 0；只有已開賣（RUNNING 以後）的檔期可試算；同檔期不能同時有兩份草稿 | MUST | Given 檔期有訂單 Then 試算值與團主 Dashboard 預估佣金完全一致；無規則 Then null；作廢後可重開 | finance ›「結算試算：重用既有預估佣金口徑」3 項 | IMPLEMENTED | ADR-013 | 📄 |
| FR-FIN-02 | 人工調整只有兩種且系統不自動產生：覆寫（必填原因、不可為負、可清除）與調整項（金額非 0 可正負、原因必填、只增不改不刪）；最終佣金＝(覆寫 ?? 自動試算)＋調整合計；重新試算保留覆寫與調整 | MUST | Given 調整項金額 0 或無原因 Then 被拒；直接 UPDATE／DELETE 調整項 Then 資料庫拒絕 | finance ›「覆寫與調整項」3 項 | IMPLEMENTED | ADR-013 | 📄 |
| FR-FIN-03 | 結算確認（DRAFT→CONFIRMED）僅 FINANCE／SYSTEM_ADMIN；確認時寫入規則版本快照與資料基準；有團主沒有可用金額時不能確認；確認後鎖定（服務層與資料庫層皆擋），只能作廢後重開；作廢需權限與原因 | MUST | Given 主管／小編／團主／廠商 When 確認 Then 沒有權限；確認後覆寫／調整／重算／再確認皆被拒，直接改資料庫也被觸發器擋下；作廢後可重開新結算 | finance ›「確認與鎖定」4 項 | IMPLEMENTED | ADR-013 | ✅ |
| FR-FIN-04 | 試算過期偵測：確認前以最新訂單／規則重算，與草稿逐項比對，不同則 412 要求重新試算 | MUST | Given 試算後匯入新訂單 When 確認 Then 被擋；重新試算後可確認 | finance ›「確認與鎖定」›「試算後訂單有變動：確認被擋，重新試算後才能確認」 | IMPLEMENTED | ADR-013 | ✅ |
| FR-FIN-05 | 入帳／付款紀錄：金額正整數、方向 IN／OUT、對象類型；核對需先關聯檔期或結算項目，核對後鎖定，取消核對需原因，已核對不可作廢；不放真實銀行帳號 | MUST | Given 未關聯 When 核對 Then 被拒；已核對 When 作廢 Then 被拒 | finance ›「入帳確認紀錄」4 項 | IMPLEMENTED | FEATURE_STATUS #31 | 📄 |
| FR-FIN-06 | 發票紀錄：DRAFT→ISSUED→VOID；開立後不可改；同號碼只能有一張未作廢；作廢需原因；不串電子發票 | SHOULD | Given 已開立發票 When 修改 Then 被拒；作廢後號碼可重用 | finance ›「發票紀錄」 | IMPLEMENTED | FEATURE_STATUS #31 | 📄 |
| FR-FIN-07 | 費用紀錄（SHIPPING／MARKETING／SAMPLE／PLATFORM_FEE／OTHER）：建立、修改、作廢；彙總到財務總覽但不影響試算佣金；作廢的入帳／費用不計入 | SHOULD | Given 新增費用 Then 總覽費用增加、試算佣金不變 | finance ›「費用紀錄與財務總覽」2 項 | IMPLEMENTED | FEATURE_STATUS #31 | 📄 |
| FR-FIN-08 | 財務權限與範圍：OPS_MANAGER 唯讀；小編、團主、廠商完全不能用財務 API（403）；團主只能用 `GET /settlements/mine`，只看到自己且已確認的結算項（不含他人、原因、調整細節、草稿） | MUST | Given 團主 Then 其他財務端點 403；`/settlements/mine` 只回自己已確認的項 | finance ›「權限與資料範圍（API）」4 項 | IMPLEMENTED | FEATURE_STATUS #32 | 📄 |
| FR-FIN-09 | 財務寫入皆有稽核（含檔期、操作者、原因、前後值）；建立類端點支援 Idempotency-Key | MUST | Given 每個財務寫入動作 Then `audit_logs` 有對應紀錄 | finance ›「稽核」；›「相同 Idempotency-Key 重送不會重複建立結算」「重複送出（同 Idempotency-Key）只建立一筆」 | IMPLEMENTED | ADR-007 | 📄 |
| FR-FIN-10 | 結算確認連動檔期 G4／狀態；結算批次（跨檔期）、付款單、扣款抵銷；階梯與扣項公式；結算匯出（CSV／PDF）；雙人覆核；通知團主 | SHOULD | （口徑待 Owner 定義；確認不會自動推進 G4） | — | NOT_STARTED | FINANCE.md §8；KNOWN_ISSUES P2-1、P2-2 | — |
| FR-FIN-11 | 銀行對帳單匯入與自動比對、電子發票服務、金流 | SHOULD | （缺外部服務與授權） | — | BLOCKED | KNOWN_ISSUES P2-6 | — |

### 4.14 AUD 稽核與資料保護

模組：`lib/audit.ts`、`audit-read.ts`、`migrations/001`。

| ID | 需求 | 優先 | 驗收條件（Given／When／Then） | 對應測試 | 狀態 | 來源 | 驗 |
|---|---|:-:|---|---|:-:|---|:-:|
| FR-AUD-01 | 稽核紀錄 append-only（資料庫觸發器禁止 UPDATE／DELETE），含操作者、角色、來源（WEB／API／WORKER／SEED／IMPORT／TEST）、request id、前後值、原因；密碼雜湊一律遮蔽、只記錄有變動的欄位 | MUST | Given 嘗試修改或刪除稽核列 Then 資料庫拒絕 | database ›「稽核紀錄不可修改、不可刪除」；unit/misc ›「稽核工具」 | IMPLEMENTED | ADR-007 | 📄 |
| FR-AUD-02 | 所有業務資料表禁止實體 DELETE（觸發器），一律軟刪除；API 沒有 DELETE 方法 | MUST | Given 任一業務表 When DELETE Then `restrict_violation`；`DELETE` 方法 Then 405 | database ›「所有業務資料表都禁止 DELETE」「…涵蓋全部業務表（沒有漏網）」；scenarios ›「API 層行為」（405） | IMPLEMENTED | ADR-007 | 📄 |
| FR-AUD-03 | 重要操作可從稽核還原：狀態路徑與日期變更的前後值 | MUST | Given 檔期走完 G1–G5 Then 稽核 `campaign.status` 的 after 路徑依序為 11 個狀態 | lifecycle ›「完整生命週期」（稽核段落）；reschedule ›「套用後：…稽核留有前後值」 | IMPLEMENTED | ADR-007 | ✅ |
| FR-AUD-04 | 每一個寫入動作（全系統）都有稽核紀錄 | MUST | 各模組各有稽核斷言（財務、履約、售後、檔期、訂單更新）；沒有「全部寫入端點皆寫稽核」的通用測試 | finance ›「稽核」；fulfillment ›「每個寫入都有稽核紀錄」 | PARTIAL | ADR-007 | 📄 |
| FR-AUD-05 | 備份排程與還原演練、靜態加密、Row-Level Security、稽核匯出 | MUST | （未實作） | — | NOT_STARTED | KNOWN_ISSUES K2、K5 | — |

### 4.15 UI 使用者介面

模組：`src/app/**`、`src/ui/**`。

| ID | 需求 | 優先 | 驗收條件（Given／When／Then） | 對應測試 | 狀態 | 來源 | 驗 |
|---|---|:-:|---|---|:-:|---|:-:|
| FR-UI-01 | 繁體中文管理介面（淺色、桌面為主、手機基本可用）；伺服器元件直接呼叫服務層，後端永遠重新授權；導覽依權限顯示 | MUST | Given 各角色登入 Then 看到對應導覽；前端隱藏只是體驗 | `scripts/e2e-smoke.ts`（Playwright，49 項；不在 `npm test` 也不在 CI，結果記錄於 `docs/uat/e2e-results.json`） | PARTIAL | ADR-017 | ❌ |
| FR-UI-02 | 無障礙（a11y）審查、多語系 | COULD | （未做；僅繁體中文） | — | NOT_STARTED | KNOWN_ISSUES K22 | — |

### 4.16 SEG 客群分析（SOP 01）

模組：`segments.ts`、`lib/segment-vocab.ts`、`hosts.ts`（`partner_type`）、`migrations/013`。設計見 [`docs/phase2/SEGMENT_FIT.md`](../phase2/SEGMENT_FIT.md)。原則：**空值＝未知（不是「無」）**；事實／估計用 `basis` 區分；只記錄群體特徵，不記錄個人資料。測試檔在 `tests/`，`segments` 即 `tests/segments.test.ts`。

| ID | 需求 | 優先 | 驗收條件（Given／When／Then） | 對應測試 | 狀態 | 來源 | 驗 |
|---|---|:-:|---|---|:-:|---|:-:|
| FR-SEG-01 | 客群輪廓 CRUD：名稱、說明、年齡層、家庭型態、消費週期、價格帶（下限≤上限）、整體依據；同組織同名（正規化）唯一；封存為軟刪除（仍有進行中連結時 412、需原因）；列表可搜尋與篩選 | MUST | Given 已有同名客群 When 建立或改名 Then 409 並回報既有 ID；Given 客群仍連結團主 When 封存 Then 412，結束連結後可封存，資料列仍在、可用同名重建，實體 DELETE 被資料庫擋下；價格下限高於上限 Then 422；可用 null／空字串清空欄位 | segments ›「更新、版本、稽核與軟刪除」›「重複名稱回報既有 ID（建立與改名皆然）；連結同一客群兩次 → 409」「封存是軟刪除：仍有連結 → 412；結束連結後可封存；資料列還在；之後可用同名重建」「可清空欄位（null 或空字串）；價格帶下限高於上限 → 422」；「權限與租戶隔離」›「列表篩選與搜尋」 | IMPLEMENTED | SEGMENT_FIT §3 | ✅ |
| FR-SEG-02 | 需求與偏好四類（購買動機、購買阻力、偏好品類、活躍通路），可複選，一列一值並各標事實／估計；活躍通路只接受平台代碼（LINE、FACEBOOK、INSTAGRAM、THREADS、YOUTUBE、OTHER、OFFLINE）；重複值去重；每類最多 12 項；沒有任何一列＝未知；更新時移除的偏好只軟刪除 | MUST | Given Owner 範例輪廓（團媽、育兒家庭 30–44 歲、每月、LINE、動機＝省時間＋品質安心、阻力＝陌生品牌＋怕踩雷、品類＝家庭清潔＋親子用品）When 建立 Then 讀回每一項，資料庫有 7 列偏好；通路填 WECHAT Then 422；「省時間」「 省時間 」只留一筆；移除的偏好 `deleted_at` 有值、列仍在 | segments ›「Owner 範例：團媽的客群分析一次建立並讀回」「一團主多客群、占比、多通路、複選需求」›「活躍通路只接受平台代碼；複選與重複值被去重」；「更新、版本、稽核與軟刪除」›「更新有前後值稽核；偏好增減同步；被移除的偏好只是軟刪除」 | IMPLEMENTED | SEGMENT_FIT §3 | ✅ |
| FR-SEG-03 | 團主↔客群多對多：一團主可有多個客群、同一客群可被多位團主連結；占比（選填，0–100，進行中連結合計 ≤100）、連結依據、主要所在社群（必須是該團主目前所屬社群）；結束連結＝寫 `ended_at`；同團主同客群只能有一筆進行中連結；團主彙整回報狀態（未建立／待補資料／完整）與缺漏清單；同一 Idempotency-Key 回放同一筆 | MUST | Given 團主已有 60% 與 40% 客群 When 再加 10% Then 422 且不留下半個客群（交易回滾）；社群不屬於該團主 Then 422；連結同一客群兩次 Then 409；只建名稱的客群 Then 狀態 PARTIAL 並列出缺漏（含觀察來源）；未建立任何客群 Then NOT_STARTED | segments ›「一團主多客群、占比、多通路、複選需求」›「第二個客群占 40%，其他已占 60% → 成功；再加 10% 超過 100% → 422」「社群必須是此團主目前所屬的社群」；「未知與缺漏要如實呈現，不能假裝是「無」」（2 項）；「更新、版本、稽核與軟刪除」›「調整連結占比與依據；占比總和仍受限；已結束的連結不可再改」「重複送出：同一個 Idempotency-Key 回放同一筆連結，不會產生第二筆」 | IMPLEMENTED | SEGMENT_FIT §3 | ✅ |
| FR-SEG-04 | 研究證據（觀察、訪談、問卷、訂單資料、平台統計、其他）：標為「事實」必須有來源說明或來源連結（API 與資料庫 CHECK 雙重把關）；來源連結只接受 http(s)；證據、客群名稱、說明、偏好項目、連結備註不得含手機號碼或 Email；偏好可引用證據；移除證據為軟刪除並清除偏好對它的引用 | MUST | Given 事實證據無來源 When 新增 Then 422，有來源說明或連結則成功，沒來源標估計則成功；繞過 API 直接 INSERT 無來源的 FACT Then 資料庫 CHECK 擋下；摘要含 `0912-345-678` 或 Email Then 422；移除證據後引用它的偏好 `evidenceId` 為 null | segments ›「事實／估計與研究證據」›「標為事實的證據必須有來源；有來源說明或連結就可以；沒來源請標估計」「資料庫層：FACT 沒來源會被 CHECK 擋下（繞過 API 也一樣）」「個資防護：證據、客群名稱、偏好項目不得含手機號碼或 Email」「偏好可引用證據；移除證據後引用被清掉（不指向已移除的來源）」 | IMPLEMENTED | SEGMENT_FIT §3 | ✅ |
| FR-SEG-05 | 版本與稽核：客群與連結有 `version` 樂觀鎖（舊版本更新 409）；每次寫入有稽核（前後值）；偏好異動寫 `segment.preferences`；只改偏好時客群版本也前進；詳情回傳變更歷史 | MUST | Given 客群版本 v1 When 以 v1 更新年齡層成功後再以 v1 更新 Then 409；歷史含 `segment.update`（前後值）與 `segment.preferences`（新增／移除項目） | segments ›「更新、版本、稽核與軟刪除」›「更新有前後值稽核；偏好增減同步；被移除的偏好只是軟刪除」「只改偏好時，客群版本也會前進；舊版本號更新 → 409」；「Owner 範例…」（稽核動作） | IMPLEMENTED | SEGMENT_FIT §3 | ✅ |
| FR-SEG-06 | 團主「合作對象類型」`hosts.partner_type`（團媽／社群主／網紅／其他；空＝未知）：可設定與清空；只有具 `segment.read` 的角色看得到；團主清單同時回傳客群數 | SHOULD | Given 團主 When 設為 ALIEN Then 422；設為社群主後營運小編讀得到、財務讀不到（欄位不存在）；清空後為 null；財務的團主清單沒有 `segmentCount`、`partnerType` | segments ›「團主「合作對象類型」」›「只接受定義的類型；可清空；財務與團主看不到」「團主清單：有 segment.read 的角色看到客群數；財務看不到這兩個欄位」 | IMPLEMENTED | SEGMENT_FIT §2 | ✅ |
| FR-SEG-07 | 權限與租戶隔離：`segment.read`／`segment.write` 只給系統管理者、營運主管、營運小編；團主、廠商、財務所有入口 403（含直接呼叫服務層）；他組織資料 404 | MUST | Given 團主／廠商／財務帳號 When 讀寫客群或讀取團主客群分析 Then 403；他組織管理者讀、改客群 Then 404，列表看不到 | segments ›「權限與租戶隔離」›「團主、廠商、財務沒有任何客群分析入口（403）」「營運小編可讀寫；營運主管可讀寫」「他組織的客群讀不到（404）；不存在的團主 404」；E2E「客群分析：非授權角色看不到」 | IMPLEMENTED | SEGMENT_FIT §6 | ✅ |
| FR-SEG-08 | 介面與流程提示：團主清單「客群分析」欄（N 個客群／未建立）；團主詳情「客群分析」區顯示基本輪廓、需求動機、購買阻力、偏好品類、消費週期、活躍通路、觀察來源，每項標示事實／估計／未知；空狀態引導；客群清單與詳情頁；導覽依權限顯示 | SHOULD | Given 新團主 When 開啟詳情 Then 顯示空狀態；用畫面建立客群後讀回輪廓與觀察來源，API 讀回與畫面一致；未提供的價格帶顯示「未知」 | 只有 E2E（`scripts/e2e-smoke.ts`「客群分析與商品適配（SOP 01）」區塊；不在 `npm test`／CI）；無元件層自動化測試 | PARTIAL | SEGMENT_FIT §5、§7 | ❌ |

### 4.17 FIT 商品適配評估（SOP 01）

模組：`fit.ts`、`lib/fit-score.ts`（評分純函式）、`lib/segment-vocab.ts`（詞彙與關鍵字別名）、`migrations/013`。**評分權重與門檻是待 Owner 確認的建議值（D-18）**，不是正式核准規則；本功能是 G1 選品的決策支援，**不改變 G1–G5 語意、不自動核准、不發任何通知**。測試檔 `fit` 即 `tests/fit.test.ts`，`unit/fit-score` 即 `tests/unit/fit-score.test.ts`。

| ID | 需求 | 優先 | 驗收條件（Given／When／Then） | 對應測試 | 狀態 | 來源 | 驗 |
|---|---|:-:|---|---|:-:|---|:-:|
| FR-FIT-01 | 評分設定可配置：五維度權重（需求 30、品類 20、價格 15、歷史績效 20、供應履約 15）為非負整數且合計必須 100；門檻（建議合作 80、需人工評估 65、最低完整度 0.5…）順序需合理；存於 `system_settings['fit.scoring']`；每次儲存版本 +1 並寫稽核；預設值標示「建議值，待 Owner 確認」（`approved:false`）；只有 `fit.config`（管理者、營運主管）能改，營運小編可讀 | MUST | Given 尚未儲存 When 讀設定 Then 內建 v1、`persisted:false`、`approved:false`；權重合計 ≠100 或門檻順序錯誤 Then 422；主管儲存後版本 2；以舊版本號再存 Then 409；營運小編存 Then 403；團主／廠商／財務讀 Then 403 | fit ›「評分設定：可配置、有版本、預設是「待確認」」（2 項）；「輸入或設定改變：產生新版本，舊版保留且不可改」›「改評分設定：新評估用新權重與新版本；舊評估的設定快照不變」；unit/fit-score ›「權重可設定」›「改權重會改變總分；合計不是 100 或有負數會被擋」「權重為 0 的維度不計入完整度與總分」 | IMPLEMENTED | SEGMENT_FIT §4.1、D-18 | ✅ |
| FR-FIT-02 | 五維度規則（1–5 分，資料不足＝未知）：品類（類別直接相符 5／別名或名稱命中 4／有偏好但無對應 1）、需求（動機與阻力涵蓋率 ≥75%／50%／25%／>0／0 → 5／4／3／2／1，一律標估計）、價格（價格帶內 5／超出 20% 內 3／更遠 1）、歷史績效（團主平均每檔淨銷售 ÷ 同範圍全體，切點 1.2／0.9／0.6／0.3；同類別檔期不足改用跨品類並標估計；退款率高 10 個百分點扣 1 分；沿用 `SALES_STATUSES` 口徑）、供應履約（出貨例外率與每百筆訂單案件率取較低者）；多客群依占比加權、占比缺漏時平均、未知客群不拉低分數 | MUST | Given 範例輪廓與「家庭除菌洗衣精」Then 品類 5、需求 5、價格未知；價格 400–600 對價格帶 300–700 Then 5；兩客群占比 75／25 分別 5 與 1 Then 4；退款率高 10pp 以上 Then 扣 1；出貨單少於 3 筆 Then 供應履約未知 | unit/fit-score ›「品類」（3 項）「需求」（3 項）「價格」（2 項）「多客群」（4 項）「歷史績效與供應履約」（3 項）；fit ›「商品 → 候選團主：評估與排名」›「三位團主各自得到評估；資料不足的不是 0 分，而是未知」 | IMPLEMENTED | SEGMENT_FIT §4.2 | ✅ |
| FR-FIT-03 | 未知資料不當 0 分：總分只用已知維度的權重重新正規化；資料完整度＝已知權重 ÷ 全部權重；信心：完整度 ≥0.85 且估計占比 ≤0.5 為高、≥0.6 為中、≥0.5 為低、其餘為不足；全部未知時總分為空；每個維度附依據（事實／估計）與理由，缺資料列入「缺資料」理由 | MUST | Given 只有需求與品類兩個已知維度且都滿分 Then 總分 100（若把未知當 0 分會是 50）、完整度 0.5、信心 LOW；全部未知 Then 總分 null、完整度 0；範例輪廓補上歷史與供應 Then 完整度 0.85、信心 MEDIUM（需求與品類是估計）；客群與偏好全標事實且有價格帶 Then 完整度 1、信心 HIGH | unit/fit-score ›「未知資料不當 0 分」（4 項）「完整度與信心」（2 項）；fit ›「商品 → 候選團主」›「三位團主各自得到評估；資料不足的不是 0 分，而是未知」 | IMPLEMENTED | SEGMENT_FIT §4.3 | ✅ |
| FR-FIT-04 | 硬性檢查（不得被總分抵銷）：合規（廠商黑名單或暫停＝FAIL；沒有登錄檢驗／認證／法規備註＝UNKNOWN；已登錄且廠商可合作＝PASS，內容仍須人工審查）、商品品質（審核被退回＝FAIL；尚未通過審核＝UNKNOWN；已通過＝PASS） | MUST | Given 其他維度全高分且商品審核被退回 Then 建議為 BLOCKED（總分仍高）；廠商黑名單或暫停 Then 合規 FAIL 且 BLOCKED；沒有合規備註或尚未審核 Then 高分也最多「需人工評估」 | unit/fit-score ›「硬性檢查：合規與品質不被總分抵銷」（6 項）；fit ›「硬性檢查：合規與品質不被高分抵銷」›「商品審核被退回 → BLOCKED（分數仍高）；沒有合規備註 → 最多「需人工評估」」「廠商被列為黑名單 → 合規 FAIL → BLOCKED」 | IMPLEMENTED | SEGMENT_FIT §4.4 | ✅ |
| FR-FIT-05 | 建議等級（依序）：任何硬性檢查 FAIL → BLOCKED；完整度 < 最低完整度 → INSUFFICIENT_DATA；總分 ≥ 建議門檻且信心不為 LOW 且硬性檢查全 PASS → RECOMMEND；總分 ≥ 需人工評估門檻（含被降級者）→ REVIEW；其餘 NOT_RECOMMENDED。資料不足或硬性未過者，分數標示「僅供參考」 | MUST | Given 範例輪廓＋歷史＋供應＋價格帶且硬性全過 Then RECOMMEND；分數達門檻但信心 LOW Then 降為 REVIEW；團主沒有客群分析 Then INSUFFICIENT_DATA 且排名在最後（BLOCKED 之前） | unit/fit-score ›「硬性檢查…」›「硬性檢查全過、分數高、信心不是低 → RECOMMEND」「分數達建議門檻但信心為 LOW → 降為 REVIEW」、「Owner 範例輪廓…」；fit ›「商品 → 候選團主」›「三位團主各自得到評估…」（排名為 RECOMMEND、NOT_RECOMMENDED、INSUFFICIENT_DATA） | IMPLEMENTED | SEGMENT_FIT §4.5 | ✅ |
| FR-FIT-06 | 評估保留版本、來源與理由：每筆保存設定快照（版本、權重、門檻、別名版本）、輸入雜湊、各維度分數與理由、硬性檢查、來源（用了哪些客群與連結、歷史樣本、供應樣本）、評估人與時間；輸入與設定完全相同再評估不新增列（unchanged）；輸入或設定改變則新增新版並將舊版標記被取代；同商品×團主×檔期只有一筆現行版（部分唯一索引）；改設定後舊評估的快照不變 | MUST | Given 評估已存在 When 以相同輸入再評估 Then 回報 unchanged、列數不變；商品賣點改變 Then 新增一版、舊版 `superseded_at`／`superseded_by` 有值、現行版唯一；改權重（v2）後重評 Then 新版 `config_version=2`，舊版快照仍是 v1 權重 | fit ›「商品 → 候選團主」›「每筆評估保留版本、來源與設定快照；寫入資料庫可讀回」「輸入完全相同再評估一次：不新增列（unchanged）」；「輸入或設定改變…」›「商品賣點改變 → 新版本；舊版標記被取代；現行版唯一」「改評分設定：新評估用新權重與新版本；舊評估的設定快照不變」；unit/fit-score ›「輸入雜湊」 | IMPLEMENTED | SEGMENT_FIT §4.6 | ✅ |
| FR-FIT-07 | 評估內容寫入後不可改（資料庫觸發器）：分數、維度、理由、來源、設定快照、輸入雜湊等欄位不可 UPDATE；只有覆核、被取代、成效回寫三組欄位可補寫；已被取代者不可還原；禁止實體 DELETE；覆核決定的資料庫 CHECK（不採用／需補資料需原因、覆核需有覆核人） | MUST | Given 現行評估 When 直接 `UPDATE total_score` 或 `reasons` Then 以「不可修改」擋下；`superseded_at` 設回 NULL Then 擋下；DELETE Then 擋下；REJECTED 無原因或覆核無覆核人 Then CHECK 擋下 | fit ›「輸入或設定改變…」›「資料庫層：評分內容寫入後不可改；已取代者不可還原；不可實體刪除」；「人工覆核」›「資料庫層：REJECTED 沒有原因、覆核沒有覆核人，都過不了 CHECK」 | IMPLEMENTED | SEGMENT_FIT §3.1 | ✅ |
| FR-FIT-08 | 人工覆核：決定為同意採用／不採用／需補資料，後兩者必填原因；意見不得含電話或 Email；只有 `fit.review`（管理者、營運主管）；可重新覆核（稽核保留前後值）；已被新版取代的評估不能覆核（409）；覆核只記錄意見，不改評分、不改任何檔期狀態 | MUST | Given 營運小編 When 覆核 Then 403；不採用未填原因 Then 422；覆核同意後稽核有 `fit.review` 前後值，詳情顯示覆核人與時間；對舊版覆核 Then 409 | fit ›「人工覆核」›「只有 fit.review（主管／管理者）能覆核；營運小編 403」「不採用／需補資料必須填原因；覆核寫入並留稽核（前後值）」「已被新版取代的評估不能覆核（409），要覆核最新版」「總覽：待覆核清單與尚無客群分析的團主」；E2E「覆核後出現在「已覆核」…」 | IMPLEMENTED | SEGMENT_FIT §4.5 | ✅ |
| FR-FIT-09 | 候選團主視圖：商品頁「候選團主適配」對所有合作中團主（上限 200，或指定清單）評估並依建議等級與總分排名，顯示總分、建議、信心、資料完整度、硬性檢查、覆核狀態、理由；缺客群分析的團主顯示「資料不足」；`fit.assess` 才可產生；總覽頁列出待覆核與尚未建立客群分析的團主 | MUST | Given 三位團主（完整、不相符、無客群）When 產生評估 Then 排名 RECOMMEND、NOT_RECOMMENDED、INSUFFICIENT_DATA；指定不存在的團主 Then 404；團主／廠商／財務所有適配端點 403（含服務層）；他組織 404 | fit ›「商品 → 候選團主」›「可指定團主清單；不存在的團主 404；只評估指定者」；「權限」›「團主、廠商、財務：商品／檔期／總覽的適配資料全部 403」「直接呼叫服務層同樣擋下（不是只擋 API）」「他組織的商品與評估讀不到」；E2E「商品頁有「候選團主適配」…」 | IMPLEMENTED | SEGMENT_FIT §5、§6 | ✅ |
| FR-FIT-10 | 檔期適配與資料範圍：檔期「客群適配」分頁對檔期內每個商品 × 每位未婉拒的團主評估；沒有商品或沒有團主 412；婉拒的團主不評估；檔期層級評估沿用 `campaignScope`：營運小編只看自己負責的檔期，他人的檔期評估、列表、覆核、回寫、詳情都 404；檔期脈絡的評估與商品層級的評估是獨立的現行版 | MUST | Given 小編負責的檔期 When 產生評估 Then 每個商品×團主一筆；團主婉拒後只評估其餘團主；小編對主管負責的檔期讀、評估、回寫、讀評估詳情 Then 404，且不出現在 `/fit` 列表；主管可見可覆核 | fit ›「檔期適配與結案成效回寫」›「檔期草稿：商品 × 已邀請團主逐一評估；沒有商品或團主 → 412」「婉拒的團主不評估；團主回覆後重評」「資料範圍：小編只能看自己負責的檔期；他人的檔期 404（評估、列表、回寫都一樣）」；E2E「檔期「客群適配」分頁…」 | IMPLEMENTED | SEGMENT_FIT §5、§6 | ✅ |
| FR-FIT-11 | G1–G5 語意不變：評估與覆核（含「不採用」）不改變 G1 檢查項清單與結果、核准者角色與狀態轉移；不新增任何 G1 檢查項；不自動核准開團；不寫入通知；G1 核准區只有唯讀提示（共幾筆、待覆核、硬性未過）。是否納入 G1 WARN／BLOCK 見 D-19 | MUST | Given 評估中檔期 When 產生評估並覆核「不採用」Then G1 檢查結果與覆核前逐項相同、狀態仍為 EVALUATING、核准申請與通知數不變；仍可申請 G1，小編不能核准、主管核准後進入 PREPARING；G1 檢查項鍵只有 `deps_done`、`has_confirmed_host`、`has_products`、`vendor_info`、`vendor_ok` | fit ›「G1–G5 語意不變：適配評估與覆核都不會改變關卡檢查、核准或檔期狀態」›「同一檔期：評估＋覆核「不採用」前後，G1 檢查完全相同；G1 仍可申請與核准」「G1 檢查項清單沒有新增任何與適配相關的項目」；lifecycle ›「完整生命週期：草稿 → 結案（含 G1–G5）」；E2E「G1 核准區有唯讀的適配評估提示」 | IMPLEMENTED | SEGMENT_FIT §5、D-19 | ✅ |
| FR-FIT-12 | 結案成效回寫：檔期 CLOSED／SETTLED 後可由 `fit.assess` 觸發，把每位團主的實際歸因淨銷售、訂單數、退款率、目標達成率與當時預測（分數、建議）寫到檔期層級評估的 `outcome`；未結案 412、沒有評估可回寫 412；重複回寫內容相同不重複寫入（冪等）；回寫不改評分；採人工按鈕，不自動觸發（D-20） | SHOULD | Given 已 CLOSED 的檔期有評估 When 回寫 Then 更新 2 筆，hA 淨銷售 100000、目標 120000 達成率 0.833；再回寫 Then updated 0、unchanged 2；未結案 Then 412；稽核有 `fit.outcome`；回寫後再評估內容不變 | fit ›「檔期適配與結案成效回寫」›「未結案不能回寫（412）；結案後回寫實際成效，重複回寫不變（冪等）」「回寫不影響評分：歷史績效維度本來就直接讀訂單，回寫後評估內容不變」 | IMPLEMENTED | SEGMENT_FIT §5、D-20 | ✅ |
| FR-FIT-13 | 資料已更新提示（stale）：評估後商品、規格、廠商、客群、偏好或連結有更新時，現行評估標示「資料已更新，建議重評」；重新評估後恢復；訂單與出貨資料的變動不計入 | SHOULD | Given 評估後更新客群價格帶 When 讀候選團主 Then 該團主 `stale=true`；重評後價格維度由未知變為已知（價格帶內 5）、完整度升為 1、`stale=false` | fit ›「輸入或設定改變…」›「客群資料更新後，既有評估被標示「資料已更新」（stale）」 | IMPLEMENTED | SEGMENT_FIT §4.6 | ✅ |
| FR-FIT-14 | 自動排程回寫成效、AI／外部資料來源（外部客群研究、社群 API）、關鍵字別名管理介面、把適配評估納入 G1 檢查 | COULD | （未實作；回寫為人工按鈕、別名在程式內、G1 僅查閱；見 D-19、D-20、D-22） | — | NOT_STARTED | SEGMENT_FIT §9 | — |

### 4.18 SEL 商品選品評估（SOP 02）

模組：`selection.ts`、`lib/selection-score.ts`（評分純函式）、`migrations/014`。設計見 [`docs/phase2/PRODUCT_SELECTION_TRIAL.md`](../phase2/PRODUCT_SELECTION_TRIAL.md)。**權重、門檻、有效期都是待 Owner 確認的建議值（D-25、D-27）**；評估是「商品本身」的通用人工評分，**不含客群適配**（那是 SOP 01，只唯讀引用）；**分數與評估只是決策建議，不會自動核准商品或 G1**。測試檔在 `tests/`，`selection` 即 `tests/selection.test.ts`，`unit/selection-score` 即 `tests/unit/selection-score.test.ts`。

| ID | 需求 | 優先 | 驗收條件（Given／When／Then） | 對應測試 | 狀態 | 來源 | 驗 |
|---|---|:-:|---|---|:-:|---|:-:|
| FR-SEL-01 | 選品設定可配置且有版本：六項權重（客群需求符合度 25、品質與安全性 25、利潤與價格競爭力 20、供應商履約能力 15、內容展示與說服力 10、複購潛力 5）為非負整數且合計必須 100；門檻（建議進入商務審查 80、補測／補件 65、最低完整度 0.5、高信心 0.85、中信心 0.6，需遞增）；合作資格審查有效天數 365、商品資格試用有效天數 180、證據即將到期提醒 30 天（1–3650 整數）；證據連結網域白名單（預設空＝不限制）；存於 `system_settings['selection.scoring']`，每次儲存版本 +1 並寫稽核；預設標示「建議值，待 Owner 確認」；只有 `selection.config`（管理者、營運主管）能改，其餘有 `selection.read` 者可讀 | MUST | Given 尚未儲存 When 讀設定 Then 內建 v1、`persisted:false`、`approved:false`；權重合計 ≠100 或門檻順序錯誤 Then 422；主管儲存後版本 2 並有稽核 `selection.config.update`；以舊版本號再存 Then 409；營運小編存 Then 403；團主／廠商讀 Then 403；白名單格式錯誤 Then 422 | selection ›「選品設定：版本、驗證、權限」（5 項）；unit/selection-score ›「SOP02 送出檢查與設定驗證」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §3.1、D-25 | ✅ |
| FR-SEL-02 | 六項評分 1–5 整數、每項已評分必填理由（≤500 字、不得含電話或 Email）；總分＝Σ（權重 × 分數 ÷ 5）；**未評分的項目是「未知」，不當 0 分**：總分只用已知項目的權重重新正規化，並回報資料完整度（已知權重 ÷ 全部權重）與信心（完整度 ≥0.85 高、≥0.6 中、≥最低完整度為低、其餘不足）；至少要有一項評分才能送出 | MUST | Given 六項全 4 分 Then 80.0 分、完整度 1；全 5 分 100、全 1 分 20；只評需求與重複各 5 分 Then 完整度 0.3、資料不足、信心不足；分數 6 或 3.5、已評分卻無理由、理由含電話 Then 422 | unit/selection-score ›「加權與門檻」「缺資料不當 0 分」（4 項含信心分級）；selection ›「選品評估：流程、版本、不可改」›「缺資料不當 0 分…」「送出檢查…」「分數超出 1–5…」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §3.1 | ✅ |
| FR-SEL-03 | 安全與合規是**獨立必要查核**（PASS／FAIL／UNKNOWN／NEEDS_LEGAL＋說明），不併入加權、不被總分抵銷；送出時必填，FAIL 與 NEEDS_LEGAL 必填說明；食品、保健食品、醫材、化妝品、兒童用品等只標示「需法務或合規審查」，不判斷是否合法 | MUST | Given 合規 FAIL 且 100 分 Then 建議 BLOCKED（總分僅供參考）；UNKNOWN／NEEDS_LEGAL 且 100 分 Then 最多 SUPPLEMENT；FAIL 未填說明送出 Then 422 | unit/selection-score ›「安全與合規是獨立的必要查核，不被總分抵銷」（3 項）；selection ›「…合規未通過：100 分也是 BLOCKED；需法務審查：最多 SUPPLEMENT」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §3.2 | ✅ |
| FR-SEL-04 | 建議等級（依序）：合規 FAIL → BLOCKED；完整度 < 最低完整度或無分數 → INSUFFICIENT_DATA；總分 ≥ 建議門檻且合規 PASS 且信心不為低且**品質與供應兩項（評了分的）都附有效證據** → PROCEED；總分 ≥ 補測門檻（含被降級者）→ SUPPLEMENT；其餘 HOLD。過期證據不算證據。回傳值沒有任何核准欄位 | MUST | Given 全 4 分、合規通過、品質與供應各附有效證據 Then 80 分 PROCEED；品質／供應沒附證據或證據已過期 Then SUPPLEMENT 並列出缺證據項目；79 分 Then SUPPLEMENT；60 分 Then HOLD；門檻改為 60 則 60 分 SUPPLEMENT | unit/selection-score ›「加權與門檻」「PROCEED 需證據」；selection ›「缺證據…」「過期證據不算證據…」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §3.3 | ✅ |
| FR-SEL-05 | 版本與不可變：同商品同時只有一份草稿（再建 409）；送出時保存分數、完整度、信心、建議、缺證據項目、設定版本與快照、評估人與評估日；已送出內容不可改（服務層 412、資料庫觸發器也擋）；重新評估＝新版本（版本號 +1），舊版標記被取代、歷史保留；禁止實體刪除 | MUST | Given 已送出評估 When 更新或再送出 Then 412；直接 UPDATE 分數或總分 Then 資料庫拒絕；DELETE 被擋；重評送出 Then `supersedes` 列出舊版，列表現行為 v2、v1 已被取代；引用別份評估的證據 Then 422 | selection ›「建立草稿 → 同商品第二份草稿被擋」「送出後內容不可改…」「重新評估＝新版本…」「引用別人的證據被拒」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §2.1、§3.5 | ✅ |
| FR-SEL-06 | 評估覆核：只有 `product.review`（管理者、營運主管）；決定為同意採用／不採用／需補資料，後兩者必填原因（不得含電話或 Email）；草稿不能覆核、已被新版取代的評估不能覆核（409）；**覆核只記錄意見，不改商品審核狀態、不核准 G1** | MUST | Given 已送出評估 When 營運小編覆核 Then 403；主管不採用未填原因 Then 422；主管需補資料後商品 `review_status` 不變；舊版覆核 Then 409；草稿覆核 Then 412 | selection ›「選品評估覆核：只記錄意見，不改商品審核狀態、不核准 G1」（2 項） | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §3.5 | ✅ |
| FR-SEL-07 | 與 SOP 01 不重複：評估頁以唯讀方式顯示該商品現行適配統計（各建議等級的團主數、最高分，需 `fit.read`）作為「客群需求符合度」的參考；不複製、不重算、不寫入 `product_fit_assessments`；評估人須自行填分數與理由 | MUST | Given 產生並讀取評估前後 Then `product_fit_assessments` 列數不變 | selection ›「權限與資料隔離」›「評估不寫入 SOP 01 的適配資料（唯讀引用）」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §3.4 | ✅ |
| FR-SEL-08 | 權限與租戶隔離：`selection.read`（管理者、營運主管、營運小編、財務）、`selection.write`（管理者、營運主管、營運小編）；團主、廠商所有入口 403；財務只讀；他組織的商品、評估、證據一律 404 | MUST | Given 團主／廠商 When 讀或建評估、讀總覽 Then 403；財務讀 200、建立 403；跨組織讀、改、覆核、掛證據 Then 404 | selection ›「權限與資料隔離」（4 項）；selection ›「選品設定」›「營運小編不能改設定（403）；團主與廠商連讀取也不行」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §9 | ✅ |
| FR-SEL-09 | 選品與試用總覽（`/selection`）：待覆核的評估、審查中的調查、待覆核的試用結論（檔期層級者沿用檔期資料範圍）、即將到期或已過期的證據（第 10 類分潤證據對無成本檢視權限者不列）、待回收的試用品筆數、目前設定與狀態 | SHOULD | Given 已送出未覆核的評估 When 小編讀總覽 Then 列在 `pendingEvaluations` 且只含本組織，`canReview`／`canConfig` 為 false | selection ›「總覽：待覆核清單只含本組織；小編可看不可設定」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §11 | ✅ |
| FR-SEL-10 | 把評估或調查納入 G1 檢查（WARN／BLOCK）、商品送審前必須有已送出的評估、AI 或外部資料來源 | COULD | （未實作；目前僅查閱，見 D-26、D-33；G1 與商品審核流程不變） | — | NOT_STARTED | PRODUCT_SELECTION_TRIAL §14 | — |
| FR-SEL-11 | 介面與流程提示：商品詳情「選品評估」（草稿編輯器含即時試算、現行評估、版本歷史、覆核）、導覽「選品與試用」、`/selection` 總覽與設定頁；每處明講「分數不會自動核准商品或 G1」「建議值，待 Owner 確認」；未評項目顯示「未知」；團主／廠商導覽沒有入口 | SHOULD | Given 主管開商品頁 Then 見現行評估分數、建議、合規、覆核；小編開設定頁 Then 只讀提示；團主／廠商開 `/selection` Then 「沒有權限」 | E2E（`scripts/e2e-smoke.ts` 選品與試用區塊）；無自動化單元／整合測試保護畫面 | PARTIAL | PRODUCT_SELECTION_TRIAL §11 | ❌ |

### 4.19 EVI 證據連結（SOP 02／03）

模組：`evidence.ts`、`lib/dd-catalog.ts`（`evidenceState`、`evidenceHostAllowed`）、`migrations/014`（`evidence_items`）。**只存連結與中繼資料，不存檔案本體**；檔案應放公司核准的雲端空間，不得放進 GitHub（D-32）。

| ID | 需求 | 優先 | 驗收條件（Given／When／Then） | 對應測試 | 狀態 | 來源 | 驗 |
|---|---|:-:|---|---|:-:|---|:-:|
| FR-EVI-01 | 新增證據連結的安全檢查：只接受 http(s)（javascript:、data:、ftp:、file: 被拒）、不得內嵌帳號密碼、長度 ≤2000；標題、來源說明、備註不得含電話或 Email；有效期限不得早於起始日；設定網域白名單後只接受名單內網域或其子網域（不以字尾比對，`evilcorp.example` 不通過 `corp.example`）；可改為引用既有 `product_assets`（沿用其連結，不複製；素材須屬同商品） | MUST | Given 各種 URL When 新增 Then 非 http(s) 與帶帳密者 422；白名單內外網域分別通過／422；標題含電話 422；引用別的商品的素材 422 | selection ›「證據連結：只存連結，安全檢查，軟刪除」（5 項）；unit/dd-catalog ›「證據連結網域白名單」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §10 | ✅ |
| FR-EVI-02 | 證據掛在調查項目、評估、試用、試用檢核項、可行性；含種類（證書、檢驗報告、合約、報價、照片、影片、授權、法務意見、其他）與有效期限，狀態為有效／即將到期／已過期／無期限；父層鎖定後不能增減（調查已核准、評估已送出、試用已結論或取消）；移除＝軟刪除（資料列保留）；資料庫禁止實體刪除；稽核留下新增與移除 | MUST | Given 已送出的評估 When 新增或移除證據 Then 412；移除後 `deleted_at` 有值、再移除 404；DELETE 被資料庫擋；已核准調查新增證據 412；已結論試用的檢核項證據 412 | selection ›「移除＝軟刪除…；評估送出後不能再增減證據」；diligence ›「…已核准的調查不能增減證據」；trials ›「結論或取消後，檢核項與證據都鎖定」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §2.1 | ✅ |
| FR-EVI-03 | 敏感證據沿用 `product.cost.read`：第 10 類（分潤）調查項目、試用「預估毛利」檢核項、可行性情境上的證據，沒有權限者不能新增或移除，讀取時只剩種類與有效狀態（標 `restricted`，不含標題、連結、備註）；稽核標題記為「[敏感]」 | MUST | Given 營運小編 When 在第 10 類或可行性新增證據 Then 403；讀取時 `url`、`title` 皆不存在；主管可新增並讀到連結 | diligence ›「敏感條款…」›「這一類的證據連結：小編看不到標題與連結，也不能新增；主管可以」；feasibility ›「可行性的證據連結（報價）屬敏感…」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §9 | ✅ |

### 4.20 DD 廠商合作資格審查（SOP 02）

模組：`diligence.ts`、`lib/dd-catalog.ts`（12 類目錄、結構化條款 schema、法務觸發、準備度）、`migrations/014`（`vendor_dd_records`、`vendor_dd_items`）。一份調查＝某廠商（可限定某商品）在某**合約版本**下的 12 類問題。**核准結果不阻擋也不放行 G1**，只在廠商頁與 G1 決策摘要顯示（D-26）。系統只管理「有沒有被審、誰審的」，**不判斷是否合法**。

| ID | 需求 | 優先 | 驗收條件（Given／When／Then） | 對應測試 | 狀態 | 來源 | 驗 |
|---|---|:-:|---|---|:-:|---|:-:|
| FR-DD-01 | 建立調查：合約版本必填（可附合約編號／文件位置文字、受規範品類、備註）；商品須屬該廠商；自動建立 12 類項目（待補件、責任方待確認）；同廠商＋同商品（或整個廠商）＋同合約版本不可重複（409），換合約版本或限定商品可並存；支援冪等鍵 | MUST | Given 新調查 Then 12 項、全部待補件；重複 409；商品屬別家廠商 422；同冪等鍵重送回同一筆 ID | diligence ›「盡職調查：建立與 12 類」（4 項）；unit/dd-catalog ›「12 類目錄」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §4.1 | ✅ |
| FR-DD-02 | 12 類為：來源／授權／品質檢驗、售價與團購價、MOQ、現貨或預購與交期、庫存與超賣機制、配送方式、收款／發票／售後責任方、退貨／瑕疵／運損／遺失／補寄責任、試用品與圖片影片授權、分潤基礎／比例／結算週期、競業／排他／轉售價格限制／素材條款、延遲／缺貨／停止供應應變；每類有**結構化條款欄位並嚴格驗證**（責任方、期限、金額、比例；多餘欄位被拒），另有狀態、責任方（品牌／公司／團主／共同／待確認）、負責人（必須是啟用中的內部使用者）、備註、更新者與時間；樂觀鎖（舊版本更新 409）；稽核留前後值 | MUST | Given 第 7 類填收款方 BRAND When 讀回 Then 條款、責任方、負責人一致；責任方填「廠商」或多餘欄位 422；負責人是團主帳號或不存在 422；舊版本更新 409；稽核有 `selection.dd.item.update` | diligence ›「盡職調查項目：結構化條款、負責人、責任方、證據」（5 項）；unit/dd-catalog ›「條款是結構化欄位並驗證」「畫面欄位定義與條款 schema 一致」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §4.1 | ✅ |
| FR-DD-03 | 狀態規則：已確認／待補件／不適用／有風險；「不適用」必填原因、「有風險」必填說明（API 與資料庫 CHECK）；標「已確認」前，必附證據的類別（1 來源授權、7 責任方、8 退換責任、9 試用品與素材授權、10 分潤、11 排他與價格限制）須至少一筆**未過期**證據（D-35） | MUST | Given 第 1 類沒有證據或只有已過期證據 When 標已確認 Then 422；附一筆有效證據後成功；不適用未填原因 422 | diligence ›「不適用必填原因、有風險必填說明」「需證據的類別：沒有證據、只有過期證據都不能標已確認…」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §4.2 | ✅ |
| FR-DD-04 | 法務／合規審查標示：第 11 類勾選轉售價格限制、調查選了受規範品類（食品、保健食品、醫療器材、化妝品、兒童用品、其他）或廠商／商品類別／名稱符合關鍵字（疑似），自動把對應項目標為「需法務／合規審查」；任何填報者可手動標示（說明必填）；「確認無虞」只有 `product.review` 可設，且須先附一筆**有效的「法務意見」類證據**與說明；「法務封鎖」代表不得合作；自動觸發條件仍成立時不能直接解除標示；未結案（需審或封鎖）擋住送審與核准 | MUST | Given 勾選轉售價格限制 Then 第 11 類 `legalStatus=REQUIRED`；小編確認無虞 403；無法務意見或只有過期的法務意見 422；有有效法務意見後 CLEARED 並記錄確認者；封鎖後送審 422；受規範品類仍成立時解除 412 | diligence ›「法務／合規審查標示：不自行假定合法」（5 項）；unit/dd-catalog ›「法務／合規審查標示（不自行假定合法）」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §4.3、D-29 | ✅ |
| FR-DD-05 | 第 10 類（分潤基礎、比例、結算週期、條款說明）屬敏感，沿用 `product.cost.read`：沒有權限的角色讀取時條款為空並標 `restricted`、備註不外露，寫入條款、狀態、備註 403，只能指派負責人與責任方；他們編輯其他欄位時不會清掉既有條款；稽核不記錄這一類的條款內容 | MUST | Given 主管填入比例 12 When 小編讀調查 Then `terms` 為空、`restricted:true`、原始回應不含 `"ratePercent":12`；小編寫條款／狀態／備註 403，指派負責人成功；財務（有成本檢視權限）讀得到；稽核資料不含 `ratePercent` | diligence ›「敏感條款：第 10 類分潤，沿用 product.cost.read」（5 項）；unit/dd-catalog ›「敏感條款（第 10 類分潤）」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §9 | ✅ |
| FR-DD-06 | 送審與核准：草稿／已退回可編輯，審查中與已核准唯讀；送審條件＝12 項皆為已確認或不適用、無「有風險」、無過期證據、無未結案的法務審查、12 項齊全；核准（`product.review`）重新檢查條件，有效期預設 `ddValidDays`（365）天，可指定較短但不可超過上限、不可早於今天；退回與撤銷已核准者需原因，之後回到可編輯；**到期或核准後證據過期自動視為失效（不改資料，顯示原因）**；資料庫保證核准必有有效期與審核者、禁止實體刪除 | MUST | Given 未備齊 When 送審 Then 422 說明原因；備齊送審後修改項目 412；小編核准 403；主管核准 `validUntil=今天+365`；指定 366 天或昨天 422；`valid_until` 改為昨天 Then `validity.valid=false` 且原因含「到期」；證據改為過期 Then 原因含「證據已過期」；送審後證據過期 Then 核准 422；退回→再送審→核准→撤銷，稽核依序有 create／submit／reject／approve／revoke | diligence ›「送審、核准、有效期、撤銷」（8 項） | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §4.2、D-27 | ✅ |
| FR-DD-07 | 權限與租戶隔離：`selection.write` 填報、`product.review` 核准／退回／確認無虞；財務只讀（寫 403）；團主、廠商 403；他組織 404；廠商詳情列表附準備度與有效性摘要 | MUST | Given 財務 When 讀調查 200、改調查與新增 403；團主讀廠商調查 403；跨組織讀、核准 404 | diligence ›「財務唯讀、列表」（2 項）；diligence ›「盡職調查：建立與 12 類」›「備註含電話被拒；團主沒有入口；跨組織 404」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §9 | ✅ |
| FR-DD-08 | 協議（`agreements`）CRUD 並與調查關聯、廠商入口對外回填、法務窗口與審查流程、有效期自動提醒通知 | COULD | （未實作；目前以合約版本與合約編號文字記錄；見 D-29、D-36、BLOCKED 的廠商入口） | — | NOT_STARTED | PRODUCT_SELECTION_TRIAL §14 | — |

### 4.21 TRL 商品試用（SOP 03）

模組：`trials.ts`、`lib/trial-catalog.ts`（四面向檢核目錄、建議結論、商品指紋、資格有效性）、`migrations/014`（`product_trials`、`trial_checks`）。**試用紀錄不是任務狀態機**：資料狀態只有進行中／已結論／已取消；寄樣、到貨、回饋與 G1 任務仍由既有任務模組管理。

| ID | 需求 | 優先 | 驗收條件（Given／When／Then） | 對應測試 | 狀態 | 來源 | 驗 |
|---|---|:-:|---|---|:-:|---|:-:|
| FR-TRL-01 | 建立試用：層級（商品資格驗證／團主・檔期適配）× 類型（內部／指定團主／小規模測試團）；團主適配不可為內部試用、指定團主須選團主、小規模測試團須選檔期；規格須屬該商品、團主須存在、試用人須為啟用中的內部使用者、檔期須在使用者資料範圍內且含此商品、寄樣批次須為「寄樣」類且在可見檔期內；自動建立檢核項；同一商品可有多次試用，**進行中的相同組合（商品＋規格＋團主＋檔期＋類型＋層級）只能一筆**（服務層 409、資料庫部分唯一索引雙重保證），已結論或取消後可再開；支援冪等鍵 | MUST | Given 同組合再建 Then 409，取消後可再建；直接 INSERT 重複進行中 Then 資料庫拒絕；類型規則違反 422；他人檔期 404；規格屬別的商品 422；同冪等鍵回同一筆 | trials ›「試用：建立、類型、重複、日期」（7 項）；trials ›「小規模測試團、檔期範圍、任務唯讀」›「寄樣批次…」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §5.1–5.2 | ✅ |
| FR-TRL-02 | 日期與物流：寄樣、到貨、開始試用、回饋、結案日期須依序不早於前者（服務層與資料庫 CHECK）；物流商、追蹤碼；試用品回收（需否回收、狀態待回收／已回收／免回收／遺失、日期、備註；標已回收須有日期）；結論後仍可補寫物流與回收（已取消不可） | MUST | Given 到貨早於寄樣 Then 422；需回收 Then 待回收；標已回收未填日期 422；結論後標已回收成功；不需回收則狀態重設為不需回收 | trials ›「日期先後…」；trials ›「試用：試用品回收」（2 項） | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §5.2 | ✅ |
| FR-TRL-03 | 四大面向檢核：商品本身（品質、規格符合、包裝完整、保存期限／效期、使用限制、安全標示）、顧客體驗（開箱、使用難易、效果、容易誤解之處、客服疑問）、內容素材（可示範性、素材品質、賣點差異）、商業效益（預估毛利、需求、退貨風險、供應風險），共 18 項；每項結果（未測／通過／有疑慮／不通過）、**客觀證據（通過必填）**、缺陷嚴重度（缺陷須說明）、風險說明（不通過須缺陷或風險說明）、驗證人與時間、證據連結；說明不得含電話或 Email；「預估毛利」的文字可能含成本，沒有成本檢視權限者不能填、也看不到（結果欄位仍可見），稽核不記其文字 | MUST | Given 通過但無客觀證據 Then 422（資料庫 CHECK 也擋）；缺陷未說明 422；不通過未說明 422；小編填毛利說明 403、讀到 null 並標 restricted；稽核不含該文字 | trials ›「試用：四面向檢核與客觀證據」（4 項）；unit/trial-catalog ›「試用：四大面向與檢核項」「檢核項規則與商品指紋」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §5.3 | ✅ |
| FR-TRL-04 | 系統建議結論：任何不通過或嚴重缺陷 → 不通過；仍有未測 → 需重測；有疑慮或重大缺陷 → 有條件通過；否則通過；沒有檢核項 → 需重測。最終建議（通過／有條件通過／不通過／需重測）**不得比系統建議更樂觀**：更樂觀時營運小編被拒（403），具 `product.review` 者須填覆寫原因（否則 422）；更保守不需要；結論說明必填 | MUST | Given 有不通過項 When 小編下「通過」Then 403；主管不填覆寫原因 422，填了成功且保存系統建議與覆寫原因；全通過時小編下「有條件通過」成功 | unit/trial-catalog ›「試用：系統建議結論」（6 項）；trials ›「試用結論：系統建議、覆寫、有效期、覆核」›「最終建議不得比系統建議更樂觀…」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §5.4 | ✅ |
| FR-TRL-05 | 結論、覆核與取消：結論後記錄結論人、時間、系統建議、覆寫原因；通過／有條件通過記錄有效期（預設 `trialValidDays`＝180 天，可更短、不可更長）與**商品指紋**；結論後結論、層級、類型、商品、團主、檔期、有效期、指紋等不可改（資料庫觸發器），檢核項與證據鎖定；禁止實體刪除；覆核（`product.review`）接受／不接受（不接受須原因），**只記錄意見，不改商品審核狀態**；未結論不能覆核；進行中的試用可取消（原因必填） | MUST | Given 全通過 When 下通過結論 Then `validUntil=今天+180`；指定 181 天 422；再結論 412；直接 UPDATE 結論或有效期 Then 資料庫拒絕；小編覆核 403；覆核後商品 `review_status` 不變；取消後檢核項無法修改 | trials ›「試用結論…」（4 項）、「試用：試用品回收」›「結論後不可改的欄位…」、「試用：四面向檢核與客觀證據」›「結論或取消後…鎖定」；trials ›「試用：權限與跨組織」›「稽核…」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §5.4 | ✅ |
| FR-TRL-06 | 商品資格沿用與失效：商品最近一次資格試用「已結論、通過或有條件通過、已被接受、未過期（到期日當天仍有效）、商品指紋未變」才可沿用；指紋＝名稱、類別、啟用規格編號、合規備註（與順序／大小寫／前後空白無關），**價格改變不使資格失效**；團主適配試用建立時自動沿用（可用 `reuseQualification=false` 取消），只補客戶、內容、商業三面向（12 項）；結論時若沿用的資格已失效 → 412；失效時顯示原因（過期、商品資料已變更、結論不是通過、尚未覆核、覆核未接受）；最近一次若不通過，以它為準 | MUST | Given 資格通過且已覆核 Then 團主適配試用 12 項並記錄 `qualificationTrialId`；未覆核或不通過或沒有資格 Then 不沿用；改合規備註 Then 失效且原因含「已變更」；改價格 Then 仍有效；過期 Then 失效；沿用中商品改名後結論 412 | unit/trial-catalog ›「商品指紋」「資格有效」「資格失效」；trials ›「商品資格的沿用與失效」（7 項） | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §5.4 | ✅ |
| FR-TRL-07 | 不新增任務狀態機、檔期資料範圍：檔期關聯的試用只有該檔的負責人／可見者看得到（他人 404，列表也不含）；檔期試用頁唯讀顯示該檔 `SAMPLE_SHIP`、`TRIAL_ARRIVAL`、`TRIAL_FEEDBACK`、`LAUNCH_APPROVAL` 任務現況；建立與結論試用不新增、不修改任何任務 | MUST | Given 小編 A 看小編 B 負責檔期的試用 Then 404（讀、改、取消、檔期試用頁皆然），商品試用列表不含；建立試用前後該檔 `tasks` 的 ID 與狀態完全相同 | trials ›「小規模測試團、檔期範圍、任務唯讀」（4 項） | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §5.6 | ✅ |
| FR-TRL-08 | 權限與租戶隔離：`selection.write` 建立／填檢核／結論／取消、`product.review` 覆核與覆寫；財務只讀；團主、廠商所有入口 403；他組織 404 | MUST | Given 團主／廠商 When 讀或建試用、改檢核項 Then 403；財務讀 200、取消 403；跨組織讀、結論、改檢核項 404 | trials ›「試用：權限與跨組織」（3 項） | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §9 | ✅ |
| FR-TRL-09 | 新商品一律須做商品資格試用（強制）、試用品回收逾期的自動提醒或例外、試用結果的 AI／外部資料 | COULD | （未實作；目前不強制、回收只記錄不追蹤，見 D-28、D-34） | — | NOT_STARTED | PRODUCT_SELECTION_TRIAL §14 | — |

### 4.22 FEA 商業可行性試算（SOP 03）

模組：`feasibility.ts`、`lib/feasibility-calc.ts`（試算純函式與遮罩）、`migrations/014`（`feasibility_scenarios`）。**口徑沿用 `docs/biz-model/04-FINANCE_AND_COMMISSION.md` 的提案，口徑待 Owner 確認（D-31）**；只支援單一費率＋固定費；本文件沒有新增任何分潤順序。

| ID | 需求 | 優先 | 驗收條件（Given／When／Then） | 對應測試 | 狀態 | 來源 | 驗 |
|---|---|:-:|---|---|:-:|---|:-:|
| FR-FEA-01 | 輸入、假設來源與版本：預估訂單數、團購價、退款率、單位商品成本、運費／單、平台費（比例或每單）、其他變動成本／單、固定費用、品牌端服務費（比例與固定額）、團主分潤比例、分潤基礎（NSV／GMV）、團主分潤付款方（公司／品牌）、收款模式（品牌自收／團主代收／公司代收居中）、各成本負擔方（品牌／公司／團主）；欄位嚴格驗證（比例 0–100、金額非負整數、多餘欄位被拒）；**每個填入的輸入都必須註明假設來源**（廠商報價、試用／小團實際、歷史資料、合約、人工估計）否則 422 並列出缺哪些；每次儲存＝新版本（在上一版基礎上套用本次提供的欄位，沒提供的沿用）；可關聯檔期、團主、試用（須同商品） | MUST | Given 儲存完整情境 Then v1、讀回輸入／來源／結果一致；再存 `expectedOrders:200` Then v2，其餘欄位沿用、v1 不變；少填來源 422；比例 120、金額 -5、小數訂單數、未知欄位皆 422；關聯不存在的試用 404 | feasibility ›「可行性：版本、假設來源、不捏造」（前 4 項）；unit/feasibility-calc ›「輸入檢查：嚴格欄位…」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §6.1 | ✅ |
| FR-FEA-02 | 公式與不捏造：GMV＝訂單 × 團購價；退款＝GMV × 退款率；有效淨銷售額 NSV＝GMV − 退款；商品成本＝單位成本 × 預估訂單；公司營業收入（品牌端服務費）＝比例 × 分潤基礎 ＋ 固定額；團主分潤＝比例 × 分潤基礎；公司貢獻利潤＝公司營業收入 −（付款方為公司時的團主分潤）− 公司負擔的成本；品牌利潤＝NSV − 商品成本 − 公司營業收入 −（付款方為品牌時的團主分潤）− 品牌負擔的成本；團主收入＝團主分潤 − 團主負擔的成本；金額四捨五入到整數元（half-up，費率以千分位整數運算）；**GMV、NSV、品牌利潤、公司營業收入是四個不同的數字，GMV 與代收款不是公司收入**；公司代收居中時另列「應付品牌貨款」＝NSV − 公司營業收入（負債）；**任何必要輸入缺少，對應結果為 null（未知）並列出缺哪些輸入**，明確填 0 與沒填不同；有金額的成本沒指定負擔方、沒指定付款方 → 利潤未知 | MUST | Given 100 單×1,000、退款 10%、單位成本 500、運費 60、平台費 3%、固定費 2,000、服務費 10%、分潤 5%（NSV 基礎，公司付）、運費與平台費由品牌扛 Then GMV 100,000、NSV 90,000、公司營業收入 9,000、團主分潤 4,500、公司貢獻 2,500、品牌利潤 22,000；沒填退款率 Then NSV 與利潤為 null；服務費 0% Then 公司營業收入 0（不是未知）；金額 0 的成本不需負擔方 | unit/feasibility-calc ›「可行性試算：口徑與手算對照」（9 項）「缺資料不捏造」（8 項）；feasibility ›「缺少資料就是未知…」「GMV 不等於公司營業收入…」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §6.2、biz-model 04 | ✅ |
| FR-FEA-03 | 敏感欄位沿用 `product.cost.read`：成本、運費、平台費、其他變動成本、固定費用、品牌端服務費、團主分潤比例與基礎、付款方、各負擔方，以及由它們算出的成本、公司營業收入、分潤、利潤、抽成率、應付品牌貨款；沒有權限者**寫入 403（含「清空」、含來源說明）**、讀取時為 null 並標 `restricted`（GMV、退款、NSV 與非敏感輸入可見，缺漏與備註不外露）；營運小編新增新版本時上一版的敏感欄位原樣沿用（不被清掉），結果仍以完整輸入計算；商品主檔的團購價範圍可參考，成本範圍只給有權限者；稽核不記敏感數值（只記個數） | MUST | Given 小編填 `unitCost` 或 `hostCommissionPct` Then 403；小編讀情境 Then 敏感輸入與利潤 null、`restricted:true`、原始回應不含成本數字；小編改預估訂單存新版後，主管讀到的成本仍在且 `productCost` 以新訂單數計算；稽核不含成本數字 | feasibility ›「可行性：成本與分潤是敏感資料」（7 項）；unit/feasibility-calc ›「可行性：敏感欄位遮罩」（4 項） | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §9 | ✅ |
| FR-FEA-04 | 不可變與小規模測試團實際回寫：情境的輸入、來源、結果、商品、檔期、團主、版本號建立後不可改（資料庫觸發器），禁止實體刪除，只可補寫實際回寫欄位；回寫（`selection.write`）從該檔期訂單（排除取消）、售後案件、出貨單讀取實際有效訂單、GMV、退款、NSV、客單價、退款率、客訴／退款／換貨件數、出貨例外率，與預測並列差異；指定團主時只算歸因給該團主的訂單（客訴與出貨例外為檔期層級）；**不回寫利潤**；可重複回寫（以最新為準，稽核保留前後值）；沒有關聯檔期的情境不能回寫（412）；別人負責的檔期 404 | MUST | Given 3 筆有效訂單（800 元）、1 筆部分退款 200、1 筆取消 Then orders 3、GMV 2,400、refund 200、NSV 2,200、客單價 800、客訴 1、退款件數 1，訂單差異 predicted 5／actual 3／−40%；指定團主甲 Then 2 單 1,600；回寫兩次 Then 稽核 2 筆且第二筆有前值；直接 UPDATE inputs 或 results Then 資料庫拒絕 | feasibility ›「可行性：版本、假設來源、不捏造」›「試算假設與結果不可修改…」；feasibility ›「小規模測試團：實際回寫」（5 項） | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §6.3 | ✅ |
| FR-FEA-05 | 階梯費率、保底（抵佣／加佣）、費用規則更正與重算、依收款模式的完整分潤流程、與結算模組串接 | COULD | （未實作；只支援單一費率＋固定費，屬 biz-model 的費用規則提案，見 D-31；本功能不改分潤、財務、發票模組） | — | NOT_STARTED | PRODUCT_SELECTION_TRIAL §6.2、§15 | — |

### 4.23 G1S G1 統一決策摘要（SOP 02／03）

模組：`decision-summary.ts`、`lib/decision-risk.ts`（風險規則純函式）。**唯讀**：不改 `gates.ts`、`state.ts`、`products.ts` 審核流程、`tasks.ts`。

| ID | 需求 | 優先 | 驗收條件（Given／When／Then） | 對應測試 | 狀態 | 來源 | 驗 |
|---|---|:-:|---|---|:-:|---|:-:|
| FR-G1S-01 | `GET /campaigns/:id/g1-summary`：對檔期內每個商品彙整現行選品評估（分數、建議、合規、覆核、設定版本）、廠商合作資格審查（商品專屬優先，其次整個廠商；狀態、有效性、準備度）、商品資格與本檔試用（最新一次）、最新商業可行性（本檔優先，其次商品層級）、SOP 01 客群適配統計（需 `fit.read`）與風險清單、總燈號；摘要附說明「不是 G1 的檢查項」及評分設定狀態；檔期頁新增「選品與試用」分頁，G1 核准區顯示簡短提示並連過去；**摘要不寫任何資料** | MUST | Given 全部齊備 Then 綠燈且彙整分數 80、PROCEED、調查已核准且有效、資格仍有效、可行性結果；商品沒有專屬調查但廠商有 Then 採廠商層級；呼叫摘要前後各表列數不變 | selection-g1 ›「G1 統一決策摘要」（`全部齊備 → 綠燈`、`廠商層級的調查也算`、`SOP 01 客群適配統計以唯讀方式併入`）；selection-g1 ›「G1–G5 與商品審核語意不變」›「唯讀摘要不寫入任何資料」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §8 | ✅ |
| FR-G1S-02 | 風險規則與燈號（`buildRisks`、`lightOf`）：🔴阻礙＝商品審核被退回、合規未過、評估被退回、調查被退回或撤銷、法務封鎖、核准後證據過期致調查失效、商品資格或本檔試用不通過、試用結論被覆核退回；🟡缺口＝商品尚未核准、尚無評估／調查／試用／可行性、合規未查核或需法務、評估未覆核或要求補資料或建議暫緩／補測／資料不足、調查未核准或只是到期、法務未結案、有風險項、資格已失效、試用進行中／需重測／有條件通過／結論未覆核、可行性不完整或品牌利潤／公司貢獻為負；試用每組（層級×類型×團主）只看最新一次，取消的不算；有任何阻礙為紅燈，否則有缺口為黃燈，否則綠燈；沒有商品的檔期為黃燈 | MUST | Given 什麼都沒做 Then 全為缺口（黃燈）、領域涵蓋評估／調查／試用／可行性；各阻礙情境 Then 紅燈；試用失敗後重測通過 Then 紅燈解除；商品資料改變使資格失效 Then 缺口並說明原因；只是調查到期（證據未過期）Then 黃燈 | unit/decision-risk ›「G1 決策摘要風險規則」（6 項）；selection-g1 ›「G1 統一決策摘要」（`什麼都沒做`、`阻礙性風險（紅燈）`、`試用只看最新一次`、`商品資料改變使資格失效`） | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §8 | ✅ |
| FR-G1S-03 | G1–G5 與商品審核語意不變（回歸）：摘要的 `gateImpact` 恆為 `NONE`；有無評估／調查／試用／可行性（含紅燈）G1 檢查項清單與結果完全相同、不新增任何 G1 檢查項、不新增核准列、通知與任務、不改檔期狀態；紅燈時 G1 仍可申請並由核准者核准（營運小編仍不能核准）；商品審核 DRAFT→PENDING_REVIEW→APPROVED／REJECTED 與權限照舊，評估被退回不影響商品狀態 | MUST | Given 同一檔期建立並覆核全部資料 Then 前後 G1 檢查一致、核准／通知／任務列數與狀態不變；G1 檢查項鍵仍為 `deps_done`、`has_confirmed_host`、`has_products`、`vendor_info`、`vendor_ok`；紅燈下申請 G1 成功、小編核准被拒、主管核准後進入 PREPARING | selection-g1 ›「G1–G5 與商品審核語意不變（回歸）」（4 項）；selection-g1 ›「gateImpact 恆為 NONE…」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §8、D-26 | ✅ |
| FR-G1S-04 | 權限與敏感資料：需 `selection.read` 且檔期在資料範圍內（他人負責的檔期 404；團主、廠商 403；財務可讀）；沒有成本檢視權限者摘要的可行性只有 GMV／NSV、利潤與成本為 null，風險訊息也不洩漏利潤正負，原始回應不含成本數字 | MUST | Given 虧損的可行性情境 When 主管讀摘要 Then 風險含「品牌利潤為負」；小編讀 Then 風險不含「為負」、`canSeeMoney:false`、回應不含成本數字；小編 B 讀小編 A 的檔期 404 | selection-g1 ›「G1 統一決策摘要」›「敏感資料…」「檔期資料範圍…」；unit/decision-risk ›「可行性：沒有成本權限時，不會透過風險訊息洩漏利潤正負」 | IMPLEMENTED | PRODUCT_SELECTION_TRIAL §9 | ✅ |

---

## 5 非功能需求

「驗證」欄：**已測**＝有自動化測試斷言；**未測**＝已實作但沒有自動化測試；**未做**＝尚未實作。藍圖 §8.4 的初版目標是方向性描述，沒有量化數字，因此效能與可用性沒有可驗收的門檻值。

| ID | 類別 | 需求 | 現況 | 驗證 |
|---|---|---|---|---|
| NFR-SEC-01 | 安全 | 密碼以 scrypt 雜湊、每次加鹽，強度至少 10 字元且含英數 | 已實作 | 已測（unit/misc） |
| NFR-SEC-02 | 安全 | Session token 只在資料庫存 sha256，cookie `HttpOnly`、`SameSite=Lax`；production 加 `Secure` | 已實作（`auth.ts`、`routes.ts`） | HttpOnly／SameSite 已測（rbac）；sha256 雜湊與 `Secure` 未測 |
| NFR-SEC-03 | 安全 | 寫入類請求檢查 Origin 與 Content-Type；請求上限 4 MB | 已實作 | 已測（rbac、unit/misc、scenarios） |
| NFR-SEC-04 | 安全 | 後端強制資料範圍；外部角色範圍外一律 404；欄位投影 | 已實作 | 已測（rbac、各模組測試） |
| NFR-SEC-05 | 安全 | 輸入驗證（zod）；URL 欄位只接受 http(s)；列表查詢參數化 | 已實作 | 已測（scenarios：驗證、http(s)）；參數化未獨立測 |
| NFR-SEC-06 | 安全 | 登入鎖定（5 次／15 分鐘）與限流（IP 30／分、帳號 10／分，單機記憶體） | 已實作 | 鎖定已測；限流函式已測，路由套用未測；多實例不共用（KNOWN_ISSUES K3） |
| NFR-SEC-07 | 安全 | SSO／OAuth、管理者 MFA、密碼重設、靜態加密、Row-Level Security | **未做** | 未做（BP §8.3；KNOWN_ISSUES K1、K2） |
| NFR-SEC-08 | 安全 | 相依套件弱點：zod 3.x（high，需升 zod 4）、next 15 經 postcss | 已知，以 4 MB 請求上限與 `.max()` 降低風險 | 未解決（KNOWN_ISSUES T3） |
| NFR-SEC-09 | 安全 | 機密不進 repo；`.env.example` 為佔位字；production 必須設定 ≥32 字元 `SESSION_SECRET` | ✅ 整合時已修正：`SESSION_SECRET` 從未被任何簽章使用，已連同無呼叫端的 `sessionSecret()` 一併移除（KNOWN_ISSUES K4；落差 G-09） | 未測 |
| NFR-AUD-01 | 稽核 | 稽核 append-only、記錄操作者／角色／來源／request id／前後值／原因 | 已實作 | 已測（database、unit/misc） |
| NFR-AUD-02 | 稽核 | 所有業務表禁止實體 DELETE；API 無 DELETE | 已實作 | 已測（database、scenarios） |
| NFR-AUD-03 | 稽核 | 每個寫入動作都有稽核 | 各模組已實作 | 各模組有斷言；全系統通用測試不存在（FR-AUD-04） |
| NFR-REL-01 | 一致性 | 財務與狀態轉移採交易；併發安全（鎖列、唯一索引、advisory lock） | 已實作 | 已測（併發建立、併發退款、併發完成退款、匯入鎖） |
| NFR-REL-02 | 可靠度 | 冪等：`Idempotency-Key`＋請求雜湊、自然鍵、自動化 (工作, 鍵) 唯一、匯入 checksum | 已實作 | 已測 |
| NFR-REL-03 | 可靠度 | 自動化失敗可查、可重試（上限 3 次）；通知失敗不影響主流程 | 已實作 | 已測（automation） |
| NFR-REL-04 | 可靠度 | 備份排程、還原演練、RPO／RTO、事故回報流程 | **未做** | 未做（KNOWN_ISSUES K2；BP §8.3） |
| NFR-OBS-01 | 可觀測性 | 每個回應帶 requestId 並寫入稽核；`GET /api/health` 含資料庫連線檢查 | 已實作 | health 公開性已測；連線檢查由 E2E 覆蓋；`requestId` 欄位未獨立斷言 |
| NFR-OBS-02 | 可觀測性 | 監控、告警（失敗佇列、同步延遲、錯誤率） | **未做**；僅有 `automation_runs` 與 DEAD 通知 | 未做（KNOWN_ISSUES K5） |
| NFR-PERF-01 | 效能 | 列表分頁上限 200 筆／頁；匯入上限 2 MB／20,000 列 | 已實作 | 上限常數未被測試斷言；**沒有負載或壓力測試**（KNOWN_ISSUES T3） |
| NFR-PERF-02 | 效能 | Dashboard 為即時查詢（無快取、無快照）；財務總覽逐檔期計算（最多 100 檔期） | 已實作 | 資料量大時需優化（KNOWN_ISSUES K20）；無效能測試 |
| NFR-DATA-01 | 資料保存 | 資料保存期限、封存與清理政策 | **未定義**；`idempotency_keys`、`sessions` 不會自動清理（KNOWN_ISSUES K6） | 未做 |
| NFR-DATA-02 | 資料保護 | 訂單與售後只存去識別化 `buyer_ref`，不存買家姓名／電話／地址；售後文字欄位盡力擋手機號碼與 Email | 已實作（盡力而為，非完整個資偵測） | 售後已測；訂單匯入不驗證代號內容（KNOWN_ISSUES K15） |
| NFR-COMP-01 | 相容性 | 日期以台北日曆日、`YYYY-MM-DD` 字串處理；時間戳 `timestamptz`；組織時區 `Asia/Taipei` | 已實作 | 已測（unit/misc 日期工具） |
| NFR-COMP-02 | 相容性 | 瀏覽器：現代桌面瀏覽器；手機基本可用 | E2E 僅在 Chromium 驗證 | 未做跨瀏覽器（KNOWN_ISSUES T2） |
| NFR-COMP-03 | 相容性 | 與 Google Sheets／Apps Script 的過渡：目前只提供 CSV 匯入 | 相容層為 PROPOSED | 未做 |
| NFR-USE-01 | 可用性（易用） | 繁體中文介面；錯誤訊息為繁中並可直接顯示；無障礙審查 | 繁中已做；a11y 未做 | E2E 覆蓋主要流程；a11y 未做（KNOWN_ISSUES K22） |
| NFR-MNT-01 | 可維護性 | 手寫 SQL migration（checksum，已套用檔被改會被偵測）、模組化單體、單一路由表、口徑單一來源（`kpi.ts`、`commission-calc.ts`） | 已實作 | 已測（database：冪等、checksum） |
| NFR-MNT-02 | 可維護性 | 測試策略：真實 PostgreSQL、一檔一組織、純函式單元測試；typecheck／lint／build 納入 CI | 已實作（CI 不含 E2E） | 已測 |

---

## 6 資料需求與資料品質規則

### 6.1 資料實體（65 張表，由 migrations 001–011、013、014 建立）

| 領域 | 資料表 | migration |
|---|---|---|
| 基礎 | `organizations`、`roles`、`users`、`user_scopes`、`sessions`、`id_counters`、`audit_logs`、`idempotency_keys`、`system_settings`、`events` | 001 |
| 主檔 | `vendors`、`vendor_contacts`、`hosts`、`host_availability`、`communities`、`host_communities`、`products`、`product_assets`、`skus`、`agreements`（僅 Schema） | 002 |
| 檔期 | `campaigns`、`campaign_products`、`campaign_hosts`、`campaign_placements`、`approvals`、`exceptions` | 003 |
| 流程 | `workflow_templates`、`workflow_template_steps`、`tasks`、`task_dependencies` | 004 |
| 訂單與佣金 | `import_batches`、`import_errors`、`orders`、`order_items`、`attributions`、`commission_rules`、`settlements`、`settlement_items` | 005 |
| 自動化 | `automation_settings`、`automation_runs`、`notifications`、`vendor_intake_submissions`、`daily_summaries` | 006 |
| 履約 | `fulfillment_batches`、`shipments`、`inventory_movements` | 009 |
| 售後 | `service_cases`、`case_events`、`refund_requests` | 010 |
| 財務 | `settlement_adjustments`、`payments`、`invoices`、`expenses` | 011 |
| 客群分析與適配（SOP 01） | `customer_segments`、`segment_preferences`、`partner_segment_links`、`segment_evidence`、`product_fit_assessments`；另 `hosts` 新增可空欄位 `partner_type`；評分設定存於 `system_settings['fit.scoring']`（無新表） | 013 |
| 選品、合作資格審查、試用與可行性（SOP 02／03） | `evidence_items`、`vendor_dd_records`、`vendor_dd_items`、`product_evaluations`、`product_trials`、`trial_checks`、`feasibility_scenarios`；評分與有效期設定存於 `system_settings['selection.scoring']`（無新表）；既有表不改 | 014 |

（007 角色種子、008 冪等雜湊欄位無新表。）欄位級定義見 `docs/generated/DATA_DICTIONARY.md`；業務欄位定義（藍圖 §3.5 要求的五個核心字典）仍是 PROPOSED。

### 6.2 識別碼
業務 ID 即主鍵，由資料庫計數器原子遞增產生，不依名稱或列號（ADR-014）：`VEN`、`OWN`（團主）、`GRP`（社群）、`PRD`、`SKU`、`CMP-YYYYMM-NNNN`、`TSK-YYYYMMDD-NNNN`、`ORD`、`IMP-YYYYMMDD-NNNN`、`CMR`、`APR`、`EXC`、`FBT`、`SHP`、`CAS`、`RFD`、`SET-YYYYMMDD-NNNN`、`SIT`、`ADJ`、`PAY`、`EXP`，以及 SOP 01 的 `SEG`（客群）、`SPF`（偏好）、`LNK`（團主↔客群連結）、`EVD`（證據）、`FIT`（適配評估）；SOP 02／03 的 `EVI`（證據連結，與 SOP 01 的 `EVD` 不同）、`VDD`（調查）、`VDI`（調查項目）、`SEL`（選品評估）、`TRL`（試用）、`TCK`（試用檢核項）、`FSB`（可行性情境）等。**注意**：發票使用 `INV-`；庫存異動於整合時改用 `STK-`（012 之前建立的紀錄沿用 `INV-`，見落差 G-06）。

### 6.3 資料品質規則

| 規則 | 說明 | 對應 FR |
|---|---|---|
| DQ-01 唯一性 | 同組織同名（正規化）廠商、同商品同規格編號、同檔期同團主、同來源同訂單編號、同物流商同追蹤碼（未取消）、同發票號碼（未作廢）皆唯一 | FR-MD-04、FR-ORD-03、FR-FUL-03、FR-FIN-06 |
| DQ-02 金額與數量 | 金額為 TWD 整數；不得為負；退款不得大於訂單金額；數量為正整數 | FR-ORD-04、FR-AFT-05 |
| DQ-03 日期 | 開團日不晚於結團日；Live Talk 在區間內；送達日不早於出貨日；出貨日不是未來 | FR-CMP-01、FR-FUL-01 |
| DQ-04 資料來源標示 | 訂單 `data_origin` 為 IMPORT／DEMO／MANUAL；DEMO 只能由種子寫入，Dashboard 明確標示 | FR-DSH-07、FR-ORD-06 |
| DQ-05 不猜測 | 缺錨點日期不排程、無費率不估佣金、無目標不顯示達成率、無訂單不顯示業績（顯示「—」而非 0） | FR-WF-03、FR-COM-02、FR-DSH-02、FR-DSH-03 |
| DQ-06 資料新鮮度 | 最近一次匯入資料截至超過 3 天、有未處理匯入錯誤時，Dashboard 警告 | FR-DSH-06 |
| DQ-07 去識別化 | 買家只存 `buyer_ref`；案件文字擋手機號碼與 Email | FR-ORD-09、FR-AFT-01 |
| DQ-08 完整性 | ACTIVE 廠商缺公司全名／統編／類別／主要聯絡人時列為待補 | FR-MD-03 |
| DQ-09 可追溯 | 訂單可追到匯入批次；KPI 帶來源與公式；結算確認保存規則版本快照與資料基準 | FR-ORD-01、FR-DSH-10、FR-FIN-03 |
| DQ-10 不可變 | 稽核、庫存異動、案件處理紀錄、結算調整項、已確認結算只增不改（資料庫層強制） | FR-AUD-01、FR-FUL-07、FR-AFT-09、FR-FIN-02、FR-FIN-03 |
| DQ-11 未知不當零分 | 客群欄位空值＝未知（不是「無」）；適配評分的資料不足維度標示未知、不計分（總分只用已知維度重新正規化），並如實回報資料完整度與信心 | FR-SEG-02、FR-FIT-03 |
| DQ-12 事實需來源 | 標為「事實」的研究證據必須有來源說明或連結（API 與資料庫 CHECK）；客群文字不得含個人資料 | FR-SEG-04 |
| DQ-13 證據需有效 | 證據過期就不算證據：品質／供應評分、調查項目「已確認」、法務「確認無虞」都只認未過期的證據；核准後證據過期使調查自動失效；證據只存連結，拒絕 javascript:／data:／帶帳密的連結，文字不含個人資料 | FR-SEL-04、FR-DD-03、FR-DD-04、FR-DD-06、FR-EVI-01 |
| DQ-14 缺資料不捏造（試算） | 可行性輸入缺少時，對應結果為 null（未知）並列出缺哪些輸入；明確填 0 與沒填不同；每個輸入須註明假設來源；GMV、NSV、品牌利潤、公司營業收入分開呈現 | FR-FEA-01、FR-FEA-02 |
| DQ-15 敏感欄位 | 成本、費用、分潤與利潤沿用 `product.cost.read`：無權限者寫入 403、讀取為 null 並標 `restricted`，稽核與風險訊息不洩漏數值 | FR-DD-05、FR-FEA-03、FR-EVI-03、FR-G1S-04 |

---

## 7 限制與假設

### 7.1 假設
1. 所有現有畫面與數字只在本機與隔離環境驗證，沒有部署、沒有真實資料、沒有真實通知（CLAUDE.md 鐵律 1）。
2. 組織時區固定 `Asia/Taipei`；「今天」一律以台北日曆日。
3. 一人一個角色；一個團主／廠商帳號可綁定多位團主／廠商，Dashboard 預設顯示第一位（可用 `hostId` 切換）。
4. 訂單進入系統的唯一路徑是 CSV；「即時」＝最近一次匯入的資料截至時間，不宣稱秒級即時（DASHBOARD_SPEC §1）。
5. 小團隊可能一人兼任申請與核准，因此「申請人≠核准人」預設關閉。

### 7.2 限制
1. HOST／VENDOR 任務是「一檔一個」，不是「每位團主一個」；一檔多團主時任一位團主帳號都能完成共用的團主任務（KNOWN_ISSUES K8）。
2. 手動鎖定單一任務日期後，下游任務不會立即連動，需再走一次影響預覽（K9）。
3. 團主同時進行檔期的衝突上限固定為 2（K11）。
4. 預估佣金＝單一費率 × 歸因淨銷售；不含階梯、扣項、含稅／未稅差異（K13）。
5. 目標達成率以「與本期重疊的檔期」累計淨銷售計算，跨月檔期可能與直覺不同，期間定義待 Owner 確認（K16）。
6. 搜尋使用 `ILIKE`（無全文檢索）；列表最多 200 筆／頁（K19）。
7. 履約：庫存不隨出貨自動扣除；沒有訂單層級出貨對應；`DELIVERED` 後不可退回（FULFILLMENT.md）。
8. 售後：退款寫回訂單後，重新匯入較舊的 CSV 會覆蓋 `refund_amount`（KNOWN_ISSUES P2-3）。
9. 結算：以「檔期」為單位；試算以目前訂單為基準（不分期間）；一筆入帳最多關聯一個檔期與一個結算項目（FINANCE.md §8）。
10. 選品／試用：「疑似受規範品類」是關鍵字比對，會漏判也會誤判，只作提醒；系統不判斷任何法規是否合法（PRODUCT_SELECTION_TRIAL §15）。
11. 可行性試算只支援單一費率＋固定費；商品成本以預估訂單（出貨量）計算、不扣退貨回收；平台費比例以 GMV 為基礎；階梯、保底、更正等進階口徑未納入，口徑待 Owner 確認（D-31）。
12. 證據只存連結，連結失效不會被偵測；檔案本體不在系統內（D-32）。
13. 商品指紋不含價格：價格變動不使商品資格失效；名稱、類別、啟用規格編號、合規備註變動才會。
14. 試用結果與評分由人工填寫，沒有 AI 或外部資料來源；試用品回收逾期只記錄、不追蹤（D-34）。

---

## 8 範圍外與 BLOCKED 項目

| 項目 | 狀態 | 原因／解除條件 |
|---|---|---|
| 電商訂單 API／Webhook | BLOCKED | 尚未決定平台，沒有憑證（待決策 #3） |
| 真實 LINE／Email 發送 | BLOCKED | 沒有憑證，且需 Owner 授權；`NOTIFY_ADAPTER` 設成其他值會拋 BLOCKED |
| Google Sheets／Apps Script 相容層、Google 日曆同步 | PROPOSED／BLOCKED | 需 Google 授權；目前以 CSV 與應用內行事曆替代（ADR-019） |
| 廠商入口（對外回填、專屬連結） | BLOCKED | 涉及對外存取，Owner 尚未解凍（CLAUDE.md 鐵律 3；KNOWN_ISSUES K7） |
| 歷史資料遷移、與 Sheets 雙軌對帳、與一檔歷史結案數字對帳 | BLOCKED | 沒有真實資料；待決策 #5、#6 |
| SSO／MFA、密碼重設 | NOT_STARTED | 登入方式待決策 #7 |
| 備份還原演練、監控告警、RLS、靜態加密、Production 部署 | NOT_STARTED | 需 Owner 授權與維運責任人 |
| 真實金流、銀行對賬單匯入、電子發票 | BLOCKED | 缺外部服務；金流模式待決策 #4 |
| 階梯費率、扣項、分潤比例與順序等結算公式 | BLOCKED | 金額公式屬 Owner 決策（待決策 #5） |
| 客服／履約、稽核唯讀角色；匯出個資 | NOT_STARTED | 藍圖有、任務未列 |
| 合作協議（agreements）、素材檔案上傳 | NOT_STARTED | 僅 Schema／連結 |
| 工作流程步驟編輯器、模板發佈介面 | NOT_STARTED | 現況只能呼叫服務函式（FR-WF-11） |
| 選品／試用：把評估或調查納入 G1 檢查（WARN／BLOCK）、商品送審前強制要有評估、強制商品資格試用、協議（`agreements`）CRUD 與調查關聯、試用品回收逾期自動化、可行性的階梯／保底／更正等進階費用規則、AI 或外部資料來源 | NOT_STARTED | 見 D-26、D-28、D-31、D-33、D-34、D-36；目前只查閱，不自動核准、不發通知、不改 G1–G5 與商品審核流程 |
| 客群適配：AI／外部客群研究與社群 API 資料來源、結案成效回寫的自動排程（目前為人工按鈕）、關鍵字別名管理介面、把適配納入 G1 檢查 | NOT_STARTED | 見 D-19、D-20、D-22；所有判斷只用系統內資料，且不自動核准、不發通知 |

---

## 9 待 Owner 決策清單

以下每項列出選項與影響；**本文件不替 Owner 決定**。「目前實作」是程式現況（多為 ADR 的 PROPOSED 預設），若 Owner 選了不同的選項，影響範圍如右欄。

| # | 決策 | 選項 | 目前實作 | 影響範圍 |
|---|---|---|---|---|
| D-01 | 首個試點群組與角色名單（BP §9.4 #1） | A) 指定 1～2 位團主、1 位廠商試跑　B) 全面導入 | 尚未指定；使用 DEMO 資料 | 決定要不要建真實帳號；手工對帳的案例選擇 |
| D-02 | 團主可見範圍（BP §9.4 #2；ADR-005） | A) 只看自己的目標、業績、預估佣金（不含成本與淨利）　B) 另可看毛利／成本　C) 可看同群組其他團主排名 | A | 欄位投影與 Dashboard；`FR-RBAC-03`、`FR-DSH-05` 與對應測試 |
| D-03 | 訂單來源與同步頻率（待決策 #3；ADR-011） | A) 維持 CSV 定期匯入　B) 指定電商平台 API／Webhook　C) 兩者並存 | A（僅 CSV） | `FR-ORD-10` 解除 BLOCKED；需憑證與去重鍵設計 |
| D-04 | 金流模式與發票／退款責任（待決策 #4） | A) 平台代收、公司結算給廠商與團主　B) 廠商自收、公司只收佣　C) 混合 | 未實作；財務模組僅做紀錄 | 入帳、發票、退款流程與 `FR-FIN-*`、`FR-AFT-*` 的權限分工 |
| D-05 | KPI 口徑（ADR-010） | 計入狀態（是否含 PENDING／全額退款）、期間（下單時間 vs 付款時間）、跨月檔期的達成率計法 | 計入 PAID／PARTIAL_REFUND／REFUNDED；以下單時間台北日曆月；與本期重疊檔期累計 | `FR-DSH-01～09`、`kpi.ts`、對應單元測試 |
| D-06 | 團主佣金基礎與結算口徑（ADR-013；FINANCE.md §8） | 基礎：淨銷售／含稅／扣費用後；四捨五入規則；是否有階梯、運費與平台費扣項、退款扣回時點；分潤比例與順序；是否需雙人覆核 | 單一費率 × 歸因淨銷售，四捨五入到整數元；其餘靠覆寫與調整項 | `FR-COM-*`、`FR-FIN-*`；**碰金額公式，需 Owner 明確定義後才能實作** |
| D-07 | 結算確認是否自動推進 G4／檔期狀態 | A) 維持人工（現況）　B) 結算確認後自動可申請 G4　C) 結算確認即視同 G4 | A | `FR-GATE-08`、`FR-FIN-10`；需改 `gates.ts` |
| D-08 | 團主可否看到草稿試算 | A) 只看已確認（現況）　B) 也看草稿 | A | `FR-FIN-08` |
| D-09 | 退款核准者可否為申請者本人 | A) 不限制（現況）　B) 一律不可　C) 金額超過門檻才限制 | A（組織設定 `approval.require_distinct_actor` 只管關卡核准，不管退款） | `FR-AFT-06`、`FR-GATE-06` |
| D-10 | 售後：是否保留「等待廠商」狀態；是否保留獨立的 `refund.complete` 權限（財務完成、主管不能完成） | 保留／移除 | 兩者皆保留 | `FR-AFT-02`、`FR-AFT-04` |
| D-11 | 與 Google Sheets／Apps Script 的過渡期主從（待決策 #6；ADR-019） | A) 新系統為主　B) Sheets 為主、新系統只讀對照　C) 分階段接管 | 不連線、不遷移 | 雙軌對帳範圍與 `FR-` 的 BLOCKED 項 |
| D-12 | 技術棧、登入方式、部署環境、備份與資安責任人（待決策 #7） | 登入：A) 帳密＋MFA　B) SSO（Google Workspace 等）；部署：自管／雲端 | Email＋密碼；本機與 DEMO | `FR-AUTH-10`、`NFR-SEC-07`、`NFR-REL-04`；上線前必須處理（KNOWN_ISSUES K1、K2） |
| D-13 | 「八階段」生命週期定義（ADR-004） | 接受現行 8 階段／15 任務，或提供正式定義 | 現行定義（PROPOSED） | 流程模板資料；成本低（模板是資料） |
| D-14 | 何時解凍廠商入口，及其授權方式（BP §2.4：帳號登入 vs 一次性安全連結） | 解凍／不解凍；帳號登入／安全連結 | 未解凍；廠商只讀 | `FR-RBAC-10`、`FR-FUL-10`、`FR-AFT-11` |
| D-15 | 團主可否自行建立／申請檔期（BP §2.4） | 可／不可／僅申請 | 不可（只能回覆邀請） | `FR-CMP-11` |
| D-16 | 組織設定（如「申請人≠核准人」）與流程模板發佈要不要有管理介面 | 要／不要 | 無介面，只能改資料庫或呼叫服務函式 | `FR-GATE-06`、`FR-WF-08`、`FR-WF-11` |
| D-17 | 資料保存期限與清理政策（NFR-DATA-01） | 各類資料的保存年限、是否定期清理暫存表 | 未定義 | 稽核與訂單的長期容量、`idempotency_keys` 清理 |
| D-18 | 適配評分的權重（30／20／15／20／15）與門檻（建議合作 80、需人工評估 65）是否採用（SEGMENT_FIT §9） | A) 採用　B) 調整數值　C) 改維度 | 暫用建議值（`approved:false`），可在介面調整，版本與設定快照留存 | `FR-FIT-01`、`FR-FIT-05`；改數值不需改程式 |
| D-19 | 適配評估是否納入 G1 檢查 | A) 僅查閱　B) 以 WARN 提醒　C) 以 BLOCK 要求已覆核 | A（G1 語意不變） | `FR-FIT-11`；B／C 需改 `gates.ts` 與 G1 測試 |
| D-20 | 結案成效回寫是否排進自動化（預設停用）或維持人工按鈕 | A) 人工　B) 自動化工作 | A 人工按鈕 | `FR-FIT-12`、`FR-AUT-*`（自動化工作數 8→9） |
| D-21 | 客群價格帶的定義與維護者 | A) 單品團購價區間　B) 客單價區間 | A | `FR-FIT-02` 價格維度 |
| D-22 | 關鍵字別名表（需求、品類比對）由誰維護 | A) 程式　B) 管理介面 | A 程式內（記錄 `lexiconVersion`） | `FR-FIT-02`、`FR-FIT-14` |
| D-23 | 供應履約的例外率（2／5／10／20%）與案件率（每百筆訂單 1／3／6／10 件）切點是否合理 | 沿用／調整 | 暫用建議切點 | `FR-FIT-02` |
| D-24 | 客群「事實」的認定標準 | A) 單一來源說明即可　B) 需雙來源 | A（填寫者負責） | `FR-SEG-04` |
| D-25 | 選品評分權重（25／25／20／15／10／5）與門檻（建議進入商務審查 80、補測／補件 65）是否採用（PRODUCT_SELECTION_TRIAL §14） | A) 採用　B) 調整數值 | 暫用建議值（`approved:false`），可在 `/selection` 設定，版本化 | `FR-SEL-01`、`FR-SEL-04` |
| D-26 | 商品評估、廠商合作資格審查是否納入 G1 檢查 | A) 僅查閱　B) 以 WARN 提醒　C) 以 BLOCK 要求 | A（`gateImpact` 恆為 NONE，G1 語意不變） | `FR-G1S-03`、`FR-DD-06`；B／C 需改 `gates.ts` 與 G1 測試 |
| D-27 | 合作資格審查與商品資格試用的有效期 | A) 365／180 天　B) 其他天數 | 365／180 天，可在設定調整 | `FR-DD-06`、`FR-TRL-05`、`FR-TRL-06` |
| D-28 | 新商品是否一律要做商品資格試用 | A) 必要　B) 建議　C) 不強制 | C（不強制，不動既有流程） | `FR-TRL-09` |
| D-29 | 受規範品類清單與法務／合規審查的負責人與流程 | 指定窗口與清單 | 只標示「需法務／合規審查」，不判斷合法；`product.review` 角色可確認無虞（須附法務意見證據） | `FR-DD-04`、`FR-DD-08` |
| D-30 | 敏感欄位的可見範圍（營運小編是否可見成本與分潤） | A) 維持不可見　B) 開放 | A（沿用 `product.cost.read`） | `FR-DD-05`、`FR-FEA-03`、`FR-EVI-03` |
| D-31 | 可行性試算口徑（公司營業收入、分潤基礎、付款方；同 biz-model B-01、B-08、B-09） | 待確認 | 單一費率＋固定費，結果標「試算」 | `FR-FEA-02`、`FR-FEA-05` |
| D-32 | 附件存放位置與網域白名單 | 指定雲端與網域 | 只存連結，白名單預設空（不限制） | `FR-EVI-01` |
| D-33 | 商品送審前是否必須有已送出的評估 | A) 必須　B) 不必須 | B（不動商品審核流程） | `FR-SEL-10`、`FR-G1S-03` |
| D-34 | 試用品回收逾期的處理與責任 | A) 人工追蹤　B) 例外／自動化 | A（只記錄，不追蹤逾期） | `FR-TRL-02`、`FR-TRL-09` |
| D-35 | 哪些調查類別須附證據才能標「已確認」 | 目前為第 1、7、8、9、10、11 類 | 如左，程式內定（`lib/dd-catalog.ts`） | `FR-DD-03` |
| D-36 | 是否建立協議（`agreements`）CRUD 並與調查關聯 | A) 做　B) 維持文字版本 | B（以合約版本與合約編號文字記錄） | `FR-DD-01`、`FR-DD-08` |

---

## 10 追溯矩陣（FR → 實作模組 → 測試檔 → 狀態）

模組路徑省略 `src/server/` 前綴。測試檔欄位只列「對應測試」欄位中引用到的檔案（細項見第 4 節）；`E2E` 指 `scripts/e2e-smoke.ts`，不在 `npm test`。

| FR | 實作模組 | 測試檔 | 狀態 | 驗 |
|---|---|---|---|---|
| FR-AUTH-01 | auth.ts, routes.ts | rbac | IMPLEMENTED | ✅ |
| FR-AUTH-02 | auth.ts | rbac | IMPLEMENTED | ✅ |
| FR-AUTH-03 | auth.ts | rbac | IMPLEMENTED | ✅ |
| FR-AUTH-04 | auth.ts, lib/config.ts | rbac | IMPLEMENTED | ✅ |
| FR-AUTH-05 | api/router.ts | unit/misc、rbac | IMPLEMENTED | ✅ |
| FR-AUTH-06 | auth.ts, lib/permissions.ts | rbac、database | IMPLEMENTED | 📄 |
| FR-AUTH-07 | lib/password.ts | unit/misc | IMPLEMENTED | 📄 |
| FR-AUTH-08 | lib/rate-limit.ts, routes.ts | unit/misc | PARTIAL | 📄 |
| FR-AUTH-09 | api/router.ts, routes.ts | rbac | IMPLEMENTED | 📄 |
| FR-AUTH-10 | — | — | NOT_STARTED | — |
| FR-RBAC-01 | lib/permissions.ts | unit/misc | IMPLEMENTED | ✅ |
| FR-RBAC-02 | lib/scope.ts | unit/misc、rbac | IMPLEMENTED | ✅ |
| FR-RBAC-03 | campaigns.ts, lib/scope.ts | rbac | IMPLEMENTED | ✅ |
| FR-RBAC-04 | products.ts | rbac | IMPLEMENTED | 📄 |
| FR-RBAC-05 | lib/scope.ts | rbac | IMPLEMENTED | 📄 |
| FR-RBAC-06 | lib/scope.ts, 全部模組 | rbac | IMPLEMENTED | 📄 |
| FR-RBAC-07 | audit-read.ts | rbac | IMPLEMENTED | 📄 |
| FR-RBAC-08 | tasks.ts, campaigns.ts, gates.ts | rbac | IMPLEMENTED | 📄 |
| FR-RBAC-09 | — | — | NOT_STARTED | — |
| FR-RBAC-10 | — | — | BLOCKED | — |
| FR-MD-01 | vendors.ts | scenarios | IMPLEMENTED | 📄 |
| FR-MD-02 | vendors.ts | — | PARTIAL | ❌ |
| FR-MD-03 | vendors.ts | scenarios | IMPLEMENTED | ✅ |
| FR-MD-04 | lib/text.ts, 各主檔模組 | unit/misc、scenarios、database | IMPLEMENTED | 📄 |
| FR-MD-05 | vendors.ts, hosts.ts | scenarios | IMPLEMENTED | ✅ |
| FR-MD-06 | campaigns.ts | scenarios | IMPLEMENTED | 📄 |
| FR-MD-07 | hosts.ts, conflicts.ts | scenarios | IMPLEMENTED | 📄 |
| FR-MD-08 | hosts.ts | scenarios | IMPLEMENTED | 📄 |
| FR-MD-09 | hosts.ts | — | PARTIAL | — |
| FR-MD-10 | products.ts | scenarios、database | IMPLEMENTED | 📄 |
| FR-MD-11 | products.ts | rbac、scenarios | IMPLEMENTED | 📄 |
| FR-MD-12 | lib/text.ts | scenarios | IMPLEMENTED | 📄 |
| FR-MD-13 | — | — | NOT_STARTED | — |
| FR-MD-14 | migrations/002 | database | NOT_STARTED | — |
| FR-CMP-01 | campaigns.ts, lib/ids.ts | scenarios、database、campaign-basic | IMPLEMENTED | 📄 |
| FR-CMP-02 | campaigns.ts | scenarios | IMPLEMENTED | 📄 |
| FR-CMP-03 | campaigns.ts | lifecycle、scenarios | IMPLEMENTED | ✅ |
| FR-CMP-04 | conflicts.ts | scenarios | IMPLEMENTED | ✅ |
| FR-CMP-05 | campaigns.ts | lifecycle | IMPLEMENTED | ✅ |
| FR-CMP-06 | campaigns.ts, workflow/state.ts | unit/misc、lifecycle | IMPLEMENTED | 📄 |
| FR-CMP-07 | lib/idempotency.ts, api/router.ts | scenarios | IMPLEMENTED | 📄 |
| FR-CMP-08 | api/router.ts, lib/repo.ts | scenarios | IMPLEMENTED | 📄 |
| FR-CMP-09 | campaigns.ts, vendors.ts, hosts.ts | E2E | PARTIAL | ❌ |
| FR-CMP-10 | audit-read.ts | rbac | PARTIAL | 📄 |
| FR-CMP-11 | — | — | NOT_STARTED | — |
| FR-WF-01 | workflow/template-default.ts, tasks.ts | unit/schedule、campaign-basic | IMPLEMENTED | ✅ |
| FR-WF-02 | workflow/schedule.ts | unit/schedule | IMPLEMENTED | ✅ |
| FR-WF-03 | workflow/schedule.ts | unit/schedule | IMPLEMENTED | 📄 |
| FR-WF-04 | workflow/schedule.ts, campaigns.ts | unit/schedule、reschedule | IMPLEMENTED | 📄 |
| FR-WF-05 | campaigns.ts, workflow/schedule.ts | reschedule | IMPLEMENTED | ✅ |
| FR-WF-06 | campaigns.ts | reschedule | IMPLEMENTED | ✅ |
| FR-WF-07 | workflow/schedule.ts, tasks.ts | unit/schedule、reschedule | IMPLEMENTED | 📄 |
| FR-WF-08 | workflow/templates.ts | reschedule | PARTIAL | ✅ |
| FR-WF-09 | tasks.ts | rbac、lifecycle、scenarios | IMPLEMENTED | ✅ |
| FR-WF-10 | tasks.ts, automation.ts | automation | IMPLEMENTED | 📄 |
| FR-WF-11 | workflow/templates.ts | — | NOT_STARTED | — |
| FR-GATE-01 | workflow/state.ts, gates.ts | unit/misc、lifecycle | IMPLEMENTED | 📄 |
| FR-GATE-02 | gates.ts | lifecycle | IMPLEMENTED | ✅ |
| FR-GATE-03 | lib/permissions.ts, gates.ts | unit/misc、lifecycle | IMPLEMENTED | ✅ |
| FR-GATE-04 | gates.ts | lifecycle | IMPLEMENTED | 📄 |
| FR-GATE-05 | gates.ts | scenarios | IMPLEMENTED | ✅ |
| FR-GATE-06 | gates.ts | lifecycle | PARTIAL | ✅ |
| FR-GATE-07 | campaigns.ts | lifecycle | IMPLEMENTED | ✅ |
| FR-GATE-08 | gates.ts | lifecycle | PARTIAL | ✅ |
| FR-GATE-09 | gates.ts | lifecycle | PARTIAL | 📄 |
| FR-ORD-01 | orders.ts | orders-dashboard | IMPLEMENTED | ✅ |
| FR-ORD-02 | orders.ts | orders-dashboard | IMPLEMENTED | ✅ |
| FR-ORD-03 | orders.ts | orders-dashboard | IMPLEMENTED | ✅ |
| FR-ORD-04 | orders.ts | orders-dashboard | IMPLEMENTED | ✅ |
| FR-ORD-05 | orders.ts, lib/csv.ts | orders-dashboard | IMPLEMENTED | ✅ |
| FR-ORD-06 | orders.ts | orders-dashboard | IMPLEMENTED | ✅ |
| FR-ORD-07 | orders.ts | orders-dashboard | IMPLEMENTED | ✅ |
| FR-ORD-08 | orders.ts | — | PARTIAL | ❌ |
| FR-ORD-09 | orders.ts, migrations/005 | — | PARTIAL | 📄 |
| FR-ORD-10 | — | — | BLOCKED | — |
| FR-ORD-11 | — | — | NOT_STARTED | — |
| FR-DSH-01 | dashboard.ts, lib/kpi.ts | unit/kpi、orders-dashboard | IMPLEMENTED | 📄 |
| FR-DSH-02 | dashboard.ts | unit/kpi、orders-dashboard | IMPLEMENTED | 📄 |
| FR-DSH-03 | dashboard.ts | orders-dashboard | IMPLEMENTED | ✅ |
| FR-DSH-04 | dashboard.ts | orders-dashboard | IMPLEMENTED | 📄 |
| FR-DSH-05 | dashboard.ts | rbac、orders-dashboard | IMPLEMENTED | ✅ |
| FR-DSH-06 | dashboard.ts | orders-dashboard | IMPLEMENTED | ✅ |
| FR-DSH-07 | dashboard.ts | orders-dashboard | IMPLEMENTED | ✅ |
| FR-DSH-08 | dashboard.ts | orders-dashboard | IMPLEMENTED | ✅ |
| FR-DSH-09 | dashboard.ts | orders-dashboard | IMPLEMENTED | ✅ |
| FR-DSH-10 | dashboard.ts, lib/kpi.ts | — | PARTIAL | ❌ |
| FR-DSH-11 | — | — | NOT_STARTED | — |
| FR-DSH-12 | — | — | BLOCKED | — |
| FR-COM-01 | commission.ts | rbac、scenarios | IMPLEMENTED | 📄 |
| FR-COM-02 | lib/commission-calc.ts, lib/kpi.ts | unit/kpi、orders-dashboard | IMPLEMENTED | 📄 |
| FR-COM-03 | — | — | BLOCKED | — |
| FR-AUT-01 | automation.ts | automation | IMPLEMENTED | 📄 |
| FR-AUT-02 | automation.ts | unit/misc、automation | IMPLEMENTED | 📄 |
| FR-AUT-03 | automation.ts | automation | IMPLEMENTED | 📄 |
| FR-AUT-04 | automation.ts | automation | IMPLEMENTED | 📄 |
| FR-AUT-05 | automation.ts | automation | IMPLEMENTED | ✅ |
| FR-AUT-06 | automation.ts | automation | IMPLEMENTED | 📄 |
| FR-AUT-07 | notifications.ts | automation | IMPLEMENTED | 📄 |
| FR-AUT-08 | intake.ts | automation | IMPLEMENTED | 📄 |
| FR-AUT-09 | automation.ts | — | PARTIAL | ❌ |
| FR-AUT-10 | notifications.ts | — | PARTIAL | ❌ |
| FR-AUT-11 | — | — | BLOCKED | — |
| FR-FUL-01 | fulfillment.ts | fulfillment | IMPLEMENTED | 📄 |
| FR-FUL-02 | fulfillment.ts | fulfillment | IMPLEMENTED | 📄 |
| FR-FUL-03 | fulfillment.ts | fulfillment | IMPLEMENTED | 📄 |
| FR-FUL-04 | fulfillment.ts | fulfillment | IMPLEMENTED | 📄 |
| FR-FUL-05 | fulfillment.ts | fulfillment | IMPLEMENTED | 📄 |
| FR-FUL-06 | fulfillment.ts | fulfillment | IMPLEMENTED | 📄 |
| FR-FUL-07 | fulfillment.ts, migrations/009 | fulfillment | IMPLEMENTED | 📄 |
| FR-FUL-08 | fulfillment.ts | fulfillment | IMPLEMENTED | 📄 |
| FR-FUL-09 | fulfillment.ts | fulfillment | IMPLEMENTED | 📄 |
| FR-FUL-10 | — | — | NOT_STARTED | — |
| FR-AFT-01 | aftersales.ts | aftersales | IMPLEMENTED | 📄 |
| FR-AFT-02 | aftersales.ts | aftersales | IMPLEMENTED | 📄 |
| FR-AFT-03 | aftersales.ts | aftersales | IMPLEMENTED | ✅ |
| FR-AFT-04 | aftersales.ts, lib/permissions.ts | aftersales | IMPLEMENTED | 📄 |
| FR-AFT-05 | aftersales.ts | aftersales | IMPLEMENTED | 📄 |
| FR-AFT-06 | aftersales.ts | aftersales | IMPLEMENTED | 📄 |
| FR-AFT-07 | aftersales.ts | aftersales | IMPLEMENTED | 📄 |
| FR-AFT-08 | aftersales.ts | aftersales | IMPLEMENTED | 📄 |
| FR-AFT-09 | migrations/010 | aftersales | IMPLEMENTED | 📄 |
| FR-AFT-10 | aftersales.ts | aftersales | IMPLEMENTED | 📄 |
| FR-AFT-11 | — | — | NOT_STARTED | — |
| FR-AFT-12 | — | — | BLOCKED | — |
| FR-FIN-01 | settlements.ts, lib/commission-calc.ts | finance | IMPLEMENTED | 📄 |
| FR-FIN-02 | settlements.ts, migrations/011 | finance | IMPLEMENTED | 📄 |
| FR-FIN-03 | settlements.ts, migrations/011 | finance | IMPLEMENTED | ✅ |
| FR-FIN-04 | settlements.ts | finance | IMPLEMENTED | ✅ |
| FR-FIN-05 | finance.ts, migrations/011 | finance | IMPLEMENTED | 📄 |
| FR-FIN-06 | finance.ts | finance | IMPLEMENTED | 📄 |
| FR-FIN-07 | finance.ts | finance | IMPLEMENTED | 📄 |
| FR-FIN-08 | settlements.ts, finance.ts | finance | IMPLEMENTED | 📄 |
| FR-FIN-09 | finance.ts, settlements.ts | finance | IMPLEMENTED | 📄 |
| FR-FIN-10 | — | — | NOT_STARTED | — |
| FR-FIN-11 | — | — | BLOCKED | — |
| FR-AUD-01 | lib/audit.ts, migrations/001 | unit/misc、database | IMPLEMENTED | 📄 |
| FR-AUD-02 | migrations/* | scenarios、database | IMPLEMENTED | 📄 |
| FR-AUD-03 | gates.ts, campaigns.ts | lifecycle、reschedule | IMPLEMENTED | ✅ |
| FR-AUD-04 | 各模組 | fulfillment、finance | PARTIAL | 📄 |
| FR-AUD-05 | — | — | NOT_STARTED | — |
| FR-UI-01 | src/app, src/ui | E2E | PARTIAL | ❌ |
| FR-UI-02 | — | — | NOT_STARTED | — |
| FR-SEG-01 | segments.ts, migrations/013 | segments | IMPLEMENTED | ✅ |
| FR-SEG-02 | segments.ts, lib/segment-vocab.ts | segments | IMPLEMENTED | ✅ |
| FR-SEG-03 | segments.ts | segments | IMPLEMENTED | ✅ |
| FR-SEG-04 | segments.ts, migrations/013 | segments | IMPLEMENTED | ✅ |
| FR-SEG-05 | segments.ts, lib/repo.ts | segments | IMPLEMENTED | ✅ |
| FR-SEG-06 | hosts.ts, migrations/013 | segments | IMPLEMENTED | ✅ |
| FR-SEG-07 | lib/permissions.ts, segments.ts | segments、E2E | IMPLEMENTED | ✅ |
| FR-SEG-08 | src/app, src/ui | E2E | PARTIAL | ❌ |
| FR-FIT-01 | fit.ts, lib/fit-score.ts | fit、unit/fit-score | IMPLEMENTED | ✅ |
| FR-FIT-02 | lib/fit-score.ts, lib/segment-vocab.ts, fit.ts | unit/fit-score、fit | IMPLEMENTED | ✅ |
| FR-FIT-03 | lib/fit-score.ts | unit/fit-score、fit | IMPLEMENTED | ✅ |
| FR-FIT-04 | lib/fit-score.ts | unit/fit-score、fit | IMPLEMENTED | ✅ |
| FR-FIT-05 | lib/fit-score.ts | unit/fit-score、fit | IMPLEMENTED | ✅ |
| FR-FIT-06 | fit.ts, lib/fit-score.ts, migrations/013 | fit、unit/fit-score | IMPLEMENTED | ✅ |
| FR-FIT-07 | migrations/013 | fit | IMPLEMENTED | ✅ |
| FR-FIT-08 | fit.ts | fit、E2E | IMPLEMENTED | ✅ |
| FR-FIT-09 | fit.ts | fit、E2E | IMPLEMENTED | ✅ |
| FR-FIT-10 | fit.ts, lib/scope.ts | fit、E2E | IMPLEMENTED | ✅ |
| FR-FIT-11 | fit.ts, gates.ts（未修改） | fit、lifecycle、E2E | IMPLEMENTED | ✅ |
| FR-FIT-12 | fit.ts | fit | IMPLEMENTED | ✅ |
| FR-FIT-13 | fit.ts | fit | IMPLEMENTED | ✅ |
| FR-FIT-14 | — | — | NOT_STARTED | — |
| FR-SEL-01 | selection.ts, lib/selection-score.ts | selection、unit/selection-score | IMPLEMENTED | ✅ |
| FR-SEL-02 | lib/selection-score.ts, selection.ts | unit/selection-score、selection | IMPLEMENTED | ✅ |
| FR-SEL-03 | lib/selection-score.ts | unit/selection-score、selection | IMPLEMENTED | ✅ |
| FR-SEL-04 | lib/selection-score.ts | unit/selection-score、selection | IMPLEMENTED | ✅ |
| FR-SEL-05 | selection.ts, migrations/014 | selection | IMPLEMENTED | ✅ |
| FR-SEL-06 | selection.ts | selection | IMPLEMENTED | ✅ |
| FR-SEL-07 | selection.ts | selection | IMPLEMENTED | ✅ |
| FR-SEL-08 | lib/permissions.ts, selection.ts | selection | IMPLEMENTED | ✅ |
| FR-SEL-09 | selection.ts | selection | IMPLEMENTED | ✅ |
| FR-SEL-10 | — | — | NOT_STARTED | — |
| FR-SEL-11 | src/app, src/ui | E2E | PARTIAL | ❌ |
| FR-EVI-01 | evidence.ts, lib/dd-catalog.ts | selection、unit/dd-catalog | IMPLEMENTED | ✅ |
| FR-EVI-02 | evidence.ts, migrations/014 | selection、diligence、trials | IMPLEMENTED | ✅ |
| FR-EVI-03 | evidence.ts | diligence、feasibility | IMPLEMENTED | ✅ |
| FR-DD-01 | diligence.ts, migrations/014 | diligence、unit/dd-catalog | IMPLEMENTED | ✅ |
| FR-DD-02 | diligence.ts, lib/dd-catalog.ts | diligence、unit/dd-catalog | IMPLEMENTED | ✅ |
| FR-DD-03 | diligence.ts | diligence | IMPLEMENTED | ✅ |
| FR-DD-04 | diligence.ts, lib/dd-catalog.ts | diligence、unit/dd-catalog | IMPLEMENTED | ✅ |
| FR-DD-05 | diligence.ts, lib/dd-catalog.ts | diligence、unit/dd-catalog | IMPLEMENTED | ✅ |
| FR-DD-06 | diligence.ts, lib/dd-catalog.ts, migrations/014 | diligence | IMPLEMENTED | ✅ |
| FR-DD-07 | lib/permissions.ts, diligence.ts | diligence | IMPLEMENTED | ✅ |
| FR-DD-08 | — | — | NOT_STARTED | — |
| FR-TRL-01 | trials.ts, migrations/014 | trials | IMPLEMENTED | ✅ |
| FR-TRL-02 | trials.ts, migrations/014 | trials | IMPLEMENTED | ✅ |
| FR-TRL-03 | trials.ts, lib/trial-catalog.ts | trials、unit/trial-catalog | IMPLEMENTED | ✅ |
| FR-TRL-04 | trials.ts, lib/trial-catalog.ts | trials、unit/trial-catalog | IMPLEMENTED | ✅ |
| FR-TRL-05 | trials.ts, migrations/014 | trials | IMPLEMENTED | ✅ |
| FR-TRL-06 | trials.ts, lib/trial-catalog.ts | trials、unit/trial-catalog | IMPLEMENTED | ✅ |
| FR-TRL-07 | trials.ts, lib/scope.ts | trials | IMPLEMENTED | ✅ |
| FR-TRL-08 | lib/permissions.ts, trials.ts | trials | IMPLEMENTED | ✅ |
| FR-TRL-09 | — | — | NOT_STARTED | — |
| FR-FEA-01 | feasibility.ts, lib/feasibility-calc.ts | feasibility、unit/feasibility-calc | IMPLEMENTED | ✅ |
| FR-FEA-02 | lib/feasibility-calc.ts | unit/feasibility-calc、feasibility | IMPLEMENTED | ✅ |
| FR-FEA-03 | feasibility.ts, lib/feasibility-calc.ts | feasibility、unit/feasibility-calc | IMPLEMENTED | ✅ |
| FR-FEA-04 | feasibility.ts, migrations/014 | feasibility | IMPLEMENTED | ✅ |
| FR-FEA-05 | — | — | NOT_STARTED | — |
| FR-G1S-01 | decision-summary.ts | selection-g1 | IMPLEMENTED | ✅ |
| FR-G1S-02 | lib/decision-risk.ts, decision-summary.ts | unit/decision-risk、selection-g1 | IMPLEMENTED | ✅ |
| FR-G1S-03 | decision-summary.ts, gates.ts（未修改）, products.ts（未修改） | selection-g1 | IMPLEMENTED | ✅ |
| FR-G1S-04 | decision-summary.ts, lib/scope.ts | selection-g1、unit/decision-risk | IMPLEMENTED | ✅ |


---

## 11 附錄：驗證方法、抽樣結果與落差

### 11.1 驗證方法
1. 逐條 FR 回頭對照程式（`src/server/**`、`migrations/**`），確認實作存在。
2. 對照 `tests/**`：列出每個 FR 的測試檔與測試標題。
3. **抽樣讀測試內容**：對 43 條 FR（驗欄標 ✅）實際讀了測試的程式碼，確認斷言涵蓋驗收條件；其餘（📄）只核對標題與被測函式存在。
4. **重跑測試**：在獨立資料庫（`erp_srs_test`，不影響其他工作）重跑 `npx vitest run`，結果見 11.2。
5. 驗欄 ❌ 的 7 條：程式存在，但找不到任何自動化測試保護；已標 PARTIAL，不當成已驗證。

### 11.2 測試重跑結果
`npx vitest run`（真實 PostgreSQL 16）：本文件初版基準為 14 個測試檔 245 項；SOP 01 整合後為 20 個測試檔、405 項；SOP 02／03 整合後再新增 10 個測試檔、187 項（`unit/selection-score` 14、`unit/dd-catalog` 13、`unit/trial-catalog` 12、`unit/decision-risk` 6、`unit/feasibility-calc` 21、`selection` 27、`diligence` 30、`trials` 31、`feasibility` 18、`selection-g1` 15），合計 **30 個測試檔、592 項**（以 `grep` 統計 `it(` 得出；全部通過的結果見 `docs/TEST_REPORT.md`，既有 405 項不變）；E2E 煙霧測試：原 49 項＋SOP 01 新增 37 項＝86 項，SOP 02／03 另新增「選品與試用」主管、營運小編與非授權角色區塊（最終項數見 `docs/uat/e2e-results.json`）。這只證明「已寫的測試通過」，不代表所有需求都有測試——沒有測試保護的需求見 11.3 的 T 系列。

### 11.3 規格與程式的落差（需 Owner 決定改程式或改規格）

| # | 類型 | 落差 | 證據 | 建議處理（供 Owner 決定） |
|---|---|---|---|---|
| G-01 | 程式文字過時 | G4 關卡檢查仍恆顯示一條 WARN「結算試算（Phase 2 尚未實作）」，但結算模組已實作 | `gates.ts` G4 區塊 `settlement_module` 項 `ok: false` 寫死 | ✅ 文字已於整合時改為「結算試算與確認（需人工確認）」；若要改為實際檢查「該檔期有已確認的結算」屬行為變更，需 D-07 決定 |
| G-02 | 功能未串接 | 結算確認不會推進 G4 或檔期狀態；G4 只檢查請款任務，不檢查結算是否已確認 | `gates.ts`；FINANCE.md §2 | 見 D-07 |
| G-03 | 功能無操作入口 | 「發佈新版流程模板」只有服務函式 `publishTemplateVersion`，`src/`、`scripts/` 沒有呼叫端；使用者無法調整預設天數 | `grep` 結果；只有 `tests/reschedule.test.ts` 呼叫 | 補 API／介面，或把「修改預設天數」改寫為工程操作（FR-WF-08、FR-WF-11） |
| G-04 | 功能無操作入口 | 組織設定 `approval.require_distinct_actor` 沒有任何 API／介面／種子可設定，只能直接寫 `system_settings` | `grep system_settings`：僅 `gates.ts` 讀取；測試以 SQL 寫入 | 補設定介面，或在文件中標為工程設定（FR-GATE-06） |
| G-05 | 文件過時 | `RTM` 仍寫結算／履約／售後 NOT_STARTED；`DASHBOARD_SPEC` §4、§5 仍寫「結算進度／財務模組屬 Phase 2」；`FEATURE_STATUS` #12 限制欄仍寫 G4 僅人工；`phase2/FULFILLMENT.md` 的「尚未接進 bootstrap-demo」「檔期詳情頁尚未加履約分頁」已不符現況（已串接；檔期頁有相關作業連結，無分頁） | 各文件原文 vs `scripts/bootstrap-demo.ts`、`campaigns/[id]/page.tsx` | 以本 SRS 第 4 節狀態為準，逐檔更新舊文件 |
| G-06 | 識別碼 | 發票（`ids.invoice`）與庫存異動（`ids.inventoryMovement`）都產生 `INV-NNNNNN`，且共用計數器 `INV`；編號不重複但無法由前綴判斷是發票還是庫存異動 | `lib/ids.ts` | ✅ 整合時已讓庫存異動對新資料改用 `STK-`（既有紀錄不變） |
| G-07 | 藍圖 vs 實作 | 藍圖要求廠商可回填供貨／出貨／請款、團主可申請檔期、客服／稽核角色、匯出個資需額外權限 | BP §2.2、§2.4 vs `permissions.ts` | 見 D-14、D-15；其餘列為後續範圍 |
| G-08 | 實作 vs 驗收條件 | 售後卡片元件 `OverviewCards` 與 `GET /aftersales/overview` 已備妥，但未嵌入 Dashboard | `docs/phase2/AFTERSALES.md` 限制 | 由 Owner 決定放哪裡 |
| G-09 | 防呆未生效 | 「production 必須設定 ≥32 字元 SESSION_SECRET」的檢查寫在 `sessionSecret()`，但沒有任何呼叫端，等於沒有防呆 | `git grep sessionSecret`：僅定義處 | ✅ 整合時已採「移除」（K4） |

**測試缺口（已實作但沒有自動化測試保護，已在對應 FR 標 PARTIAL／❌）**

| # | 缺口 | 對應 FR |
|---|---|---|
| T-01 | 廠商聯絡人新增／封存（`POST /vendors/:id/contacts`、`/vendor-contacts/:id/archive`） | FR-MD-02 |
| T-02 | 檔期／團主列表的搜尋、狀態篩選與排程日曆（僅 E2E 覆蓋，E2E 不在 `npm test`／CI） | FR-CMP-09 |
| T-03 | 匯入錯誤的處理流程（`POST /import-errors/:id/resolve`） | FR-ORD-08 |
| T-04 | 例外的人工認領／結案（`POST /exceptions/:id/status`） | FR-AUT-09 |
| T-05 | 站內通知列表與標示已讀 | FR-AUT-10 |
| T-06 | 登入限流是否真的套用在 `/auth/login` 路由（測試輔助程式每次請求前會重設限流） | FR-AUTH-08 |
| T-07 | `kpiDefinitions`／KPI 的來源與公式欄位 | FR-DSH-10 |
| T-08 | 內部角色讀取檔期稽核的 API 層斷言；G5 與 G1 部分檢查項的個別斷言 | FR-CMP-10、FR-GATE-09 |
| T-09 | 鎖定帳號 15 分鐘後自動解鎖、session 12 小時的常數值 | FR-AUTH-02、FR-AUTH-04 |
| T-10 | E2E 煙霧測試（含 SOP 01、SOP 02／03 的區塊）不在 CI；客群分析／適配與選品／試用／可行性的畫面只有 E2E 覆蓋 | FR-UI-01、FR-SEG-08、FR-SEL-11 |

### 11.4 本文件的限制
- 需求描述是從程式與既有文件推導；沒有與真實使用者訪談或實際營運流程核對。
- 「驗」欄為 📄 的 FR 只核對測試標題，若測試標題與內容不符，可能高估覆蓋；已抽樣讀過內容的 FR 標 ✅。
- 非功能需求沒有量化門檻（藍圖未訂），因此「通過」只代表有實作，不代表達標。
