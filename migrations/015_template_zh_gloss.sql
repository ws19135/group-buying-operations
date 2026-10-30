-- 015 流程模板說明文字：英文縮寫保留，旁邊補中文（例如「SOP（標準作業流程）步驟 1」）
-- 只改說明文字（description），不改步驟代碼、名稱、相依與天數；可重跑（新文字不再符合舊文字，所以不會重複替換）。
UPDATE workflow_template_steps
   SET description = replace(replace(description, 'SOP 步驟', 'SOP（標準作業流程）步驟'), '分潤屬 Phase 2）', '分潤屬第二階段（Phase 2））')
 WHERE description LIKE '%SOP 步驟%' OR description LIKE '%分潤屬 Phase 2）%';

UPDATE workflow_templates
   SET description = '由 groupbuy-flow-sop（團購標準作業流程）11 步作業與 G1–G5 Gate（核准關卡）轉換而成（ADR-004，架構決策紀錄）'
 WHERE description = '由 groupbuy-flow-sop 11 步作業與 G1–G5 Gate 轉換而成（ADR-004）';
