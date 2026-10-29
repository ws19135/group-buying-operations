# 資料字典（由資料庫實際結構產生）

> 由 `npm run docs:gen` 自動產生，請勿手動編輯。欄位的業務定義見 [DASHBOARD_SPEC.md](../DASHBOARD_SPEC.md) 與 [ARCHITECTURE.md](../ARCHITECTURE.md)。

## `agreements`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| vendor_id | text | 否 |  | vendors.id |
| title | text | 否 |  |  |
| terms | text | 是 |  |  |
| commission_note | text | 是 |  |  |
| effective_from | date | 是 |  |  |
| effective_to | date | 是 |  |  |
| status | text | 否 | `'DRAFT'::text` |  |
| document_url | text | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |
| deleted_at | timestamp with time zone | 是 |  |  |

索引：`agreements_pkey`（唯一）

## `approvals`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| campaign_id | text | 否 |  | campaigns.id |
| gate_key | text | 否 |  |  |
| status | text | 否 | `'PENDING'::text` |  |
| requested_by | text | 是 |  |  |
| requested_at | timestamp with time zone | 否 | `now()` |  |
| request_note | text | 是 |  |  |
| decided_by | text | 是 |  |  |
| decided_at | timestamp with time zone | 是 |  |  |
| decision_note | text | 是 |  |  |
| check_snapshot | jsonb | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| version | integer | 否 | `1` |  |

索引：`approvals_campaign_idx`、`approvals_pending_uq`（唯一）、`approvals_pkey`（唯一）

## `attributions`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| order_id | text | 否 |  | orders.id |
| host_id | text | 否 |  | hosts.id |
| community_id | text | 是 |  | communities.id |
| organization_id | text | 否 |  | organizations.id |
| share_percent | numeric | 否 | `100` |  |
| method | text | 否 | `'MANUAL'::text` |  |
| created_at | timestamp with time zone | 否 | `now()` |  |

索引：`attributions_host_idx`、`attributions_pkey`（唯一）

## `audit_logs`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | bigint | 否 | `nextval('audit_logs_id_seq'::regclass)` |  |
| occurred_at | timestamp with time zone | 否 | `now()` |  |
| organization_id | text | 是 |  |  |
| actor_user_id | text | 是 |  |  |
| actor_role | text | 是 |  |  |
| actor_type | text | 否 | `'USER'::text` |  |
| action | text | 否 |  |  |
| entity_type | text | 否 |  |  |
| entity_id | text | 否 |  |  |
| campaign_id | text | 是 |  |  |
| before_data | jsonb | 是 |  |  |
| after_data | jsonb | 是 |  |  |
| reason | text | 是 |  |  |
| request_id | text | 是 |  |  |
| source | text | 否 | `'WEB'::text` |  |
| ip | text | 是 |  |  |

索引：`audit_campaign_idx`、`audit_entity_idx`、`audit_logs_pkey`（唯一）、`audit_time_idx`

## `automation_runs`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| job_key | text | 否 |  |  |
| idempotency_key | text | 否 |  |  |
| trigger | text | 否 |  |  |
| status | text | 否 |  |  |
| attempts | integer | 否 | `1` |  |
| started_at | timestamp with time zone | 否 | `now()` |  |
| finished_at | timestamp with time zone | 是 |  |  |
| error | text | 是 |  |  |
| stats | jsonb | 否 | `'{}'::jsonb` |  |

索引：`automation_runs_job_idx`、`automation_runs_organization_id_job_key_idempotency_key_key`（唯一）、`automation_runs_pkey`（唯一）

## `automation_settings`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| organization_id | text | 否 |  | organizations.id |
| job_key | text | 否 |  |  |
| enabled | boolean | 否 | `false` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| updated_by | text | 是 |  |  |

索引：`automation_settings_pkey`（唯一）

## `campaign_hosts`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| campaign_id | text | 否 |  | campaigns.id |
| host_id | text | 否 |  | hosts.id |
| role | text | 否 | `'PRIMARY'::text` |  |
| status | text | 否 | `'INVITED'::text` |  |
| invited_at | timestamp with time zone | 否 | `now()` |  |
| responded_at | timestamp with time zone | 是 |  |  |
| target_revenue | bigint | 是 |  |  |
| commission_rule_id | text | 是 |  |  |
| note | text | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |
| deleted_at | timestamp with time zone | 是 |  |  |

索引：`campaign_hosts_host_idx`、`campaign_hosts_pkey`（唯一）、`campaign_hosts_uq`（唯一）

## `campaign_placements`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| campaign_id | text | 否 |  | campaigns.id |
| host_id | text | 否 |  | hosts.id |
| community_id | text | 否 |  | communities.id |
| placement_type | text | 否 |  |  |
| scheduled_on | date | 否 |  |  |
| scheduled_time | time without time zone | 是 |  |  |
| status | text | 否 | `'PLANNED'::text` |  |
| actual_at | timestamp with time zone | 是 |  |  |
| content_ref | text | 是 |  |  |
| note | text | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |
| deleted_at | timestamp with time zone | 是 |  |  |

索引：`campaign_placements_comm_idx`、`campaign_placements_pkey`（唯一）、`campaign_placements_uq`（唯一）

## `campaign_products`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| campaign_id | text | 否 |  | campaigns.id |
| product_id | text | 否 |  | products.id |
| sku_id | text | 是 |  | skus.id |
| campaign_price | bigint | 是 |  |  |
| limit_qty | integer | 是 |  |  |
| note | text | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |
| deleted_at | timestamp with time zone | 是 |  |  |

索引：`campaign_products_pkey`（唯一）、`campaign_products_product_idx`、`campaign_products_uq`（唯一）

## `campaigns`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| title | text | 否 |  |  |
| normalized_title | text | 否 |  |  |
| status | text | 否 | `'DRAFT'::text` |  |
| status_reason | text | 是 |  |  |
| previous_status | text | 是 |  |  |
| vendor_id | text | 否 |  | vendors.id |
| owner_user_id | text | 是 |  | users.id |
| campaign_type | text | 否 | `'STANDARD'::text` |  |
| description | text | 是 |  |  |
| open_date | date | 是 |  |  |
| close_date | date | 是 |  |  |
| sample_ready_date | date | 是 |  |  |
| needs_sample_recovery | boolean | 否 | `false` |  |
| live_talk_date | date | 是 |  |  |
| target_revenue | bigint | 是 |  |  |
| internal_note | text | 是 |  |  |
| workflow_template_id | text | 是 |  |  |
| workflow_template_version | integer | 是 |  |  |
| workflow_params | jsonb | 否 | `'{}'::jsonb` |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |
| deleted_at | timestamp with time zone | 是 |  |  |

索引：`campaigns_dates_idx`、`campaigns_natural_uq`（唯一）、`campaigns_org_status_idx`、`campaigns_pkey`（唯一）、`campaigns_vendor_idx`

## `case_events`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | bigint | 否 | `nextval('case_events_id_seq'::regclass)` |  |
| organization_id | text | 否 |  | organizations.id |
| case_id | text | 否 |  | service_cases.id |
| event_type | text | 否 |  |  |
| from_status | text | 是 |  |  |
| to_status | text | 是 |  |  |
| note | text | 是 |  |  |
| is_internal | boolean | 否 | `false` |  |
| actor_user_id | text | 是 |  |  |
| actor_role | text | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |

索引：`case_events_case_idx`、`case_events_pkey`（唯一）

## `commission_rules`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| scope_type | text | 否 |  |  |
| host_id | text | 否 |  | hosts.id |
| campaign_id | text | 是 |  | campaigns.id |
| rate_percent | numeric | 否 |  |  |
| basis | text | 否 | `'NET_SALES'::text` |  |
| rule_version | integer | 否 | `1` |  |
| effective_from | date | 否 |  |  |
| effective_to | date | 是 |  |  |
| status | text | 否 | `'ACTIVE'::text` |  |
| note | text | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |

索引：`commission_rules_host_idx`、`commission_rules_pkey`（唯一）

## `communities`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| platform | text | 否 |  |  |
| name | text | 否 |  |  |
| normalized_name | text | 否 |  |  |
| url | text | 是 |  |  |
| member_count | integer | 是 |  |  |
| status | text | 否 | `'ACTIVE'::text` |  |
| note | text | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |
| deleted_at | timestamp with time zone | 是 |  |  |

索引：`communities_name_uq`（唯一）、`communities_pkey`（唯一）

## `customer_segments`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| name | text | 否 |  |  |
| normalized_name | text | 否 |  |  |
| description | text | 是 |  |  |
| age_band | text | 是 |  |  |
| family_type | text | 是 |  |  |
| cycle | text | 是 |  |  |
| price_min | bigint | 是 |  |  |
| price_max | bigint | 是 |  |  |
| basis | text | 否 | `'ESTIMATE'::text` |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |
| deleted_at | timestamp with time zone | 是 |  |  |

索引：`customer_segments_name_uq`（唯一）、`customer_segments_pkey`（唯一）

## `daily_summaries`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| organization_id | text | 否 |  | organizations.id |
| summary_date | date | 否 |  |  |
| metrics | jsonb | 否 |  |  |
| generated_at | timestamp with time zone | 否 | `now()` |  |

索引：`daily_summaries_pkey`（唯一）

## `events`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | bigint | 否 | `nextval('events_id_seq'::regclass)` |  |
| organization_id | text | 否 |  |  |
| type | text | 否 |  |  |
| entity_type | text | 否 |  |  |
| entity_id | text | 否 |  |  |
| payload | jsonb | 否 | `'{}'::jsonb` |  |
| dedupe_key | text | 是 |  |  |
| occurred_at | timestamp with time zone | 否 | `now()` |  |
| processed_at | timestamp with time zone | 是 |  |  |
| attempts | integer | 否 | `0` |  |
| last_error | text | 是 |  |  |

索引：`events_dedupe_uq`（唯一）、`events_pending_idx`、`events_pkey`（唯一）

## `evidence_items`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| subject_type | text | 否 |  |  |
| subject_id | text | 否 |  |  |
| vendor_id | text | 是 |  | vendors.id |
| product_id | text | 是 |  | products.id |
| kind | text | 否 |  |  |
| title | text | 否 |  |  |
| url | text | 否 |  |  |
| source_label | text | 是 |  |  |
| valid_from | date | 是 |  |  |
| valid_until | date | 是 |  |  |
| note | text | 是 |  |  |
| asset_id | text | 是 |  | product_assets.id |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |
| deleted_at | timestamp with time zone | 是 |  |  |

索引：`evidence_items_expiry_idx`、`evidence_items_pkey`（唯一）、`evidence_items_subject_idx`

## `exceptions`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| type | text | 否 |  |  |
| severity | text | 否 | `'MEDIUM'::text` |  |
| entity_type | text | 否 |  |  |
| entity_id | text | 否 |  |  |
| campaign_id | text | 是 |  | campaigns.id |
| title | text | 否 |  |  |
| detail | text | 是 |  |  |
| status | text | 否 | `'OPEN'::text` |  |
| owner_user_id | text | 是 |  | users.id |
| dedupe_key | text | 是 |  |  |
| detected_at | timestamp with time zone | 否 | `now()` |  |
| resolved_at | timestamp with time zone | 是 |  |  |
| resolved_by | text | 是 |  |  |
| resolution_note | text | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| version | integer | 否 | `1` |  |

索引：`exceptions_campaign_idx`、`exceptions_open_uq`（唯一）、`exceptions_org_status_idx`、`exceptions_pkey`（唯一）

## `expenses`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| campaign_id | text | 是 |  | campaigns.id |
| category | text | 否 |  |  |
| amount | bigint | 否 |  |  |
| incurred_on | date | 否 |  |  |
| note | text | 是 |  |  |
| status | text | 否 | `'RECORDED'::text` |  |
| void_reason | text | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |

索引：`expenses_campaign_idx`、`expenses_org_idx`、`expenses_pkey`（唯一）

## `feasibility_scenarios`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| product_id | text | 否 |  | products.id |
| campaign_id | text | 是 |  | campaigns.id |
| host_id | text | 是 |  | hosts.id |
| trial_id | text | 是 |  | product_trials.id |
| version_no | integer | 否 |  |  |
| label | text | 是 |  |  |
| inputs | jsonb | 否 | `'{}'::jsonb` |  |
| sources | jsonb | 否 | `'{}'::jsonb` |  |
| results | jsonb | 否 | `'{}'::jsonb` |  |
| actuals | jsonb | 是 |  |  |
| actuals_at | timestamp with time zone | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |

索引：`feasibility_scenarios_pkey`（唯一）、`feasibility_scenarios_product_idx`、`feasibility_scenarios_uq`（唯一）

## `fulfillment_batches`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| campaign_id | text | 否 |  | campaigns.id |
| kind | text | 否 | `'ORDER'::text` |  |
| label | text | 否 |  |  |
| status | text | 否 | `'PENDING'::text` |  |
| planned_ship_date | date | 是 |  |  |
| note | text | 是 |  |  |
| cancel_reason | text | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |

索引：`fulfillment_batches_campaign_idx`、`fulfillment_batches_pkey`（唯一）

## `host_availability`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| host_id | text | 否 |  | hosts.id |
| start_date | date | 否 |  |  |
| end_date | date | 否 |  |  |
| kind | text | 否 |  |  |
| note | text | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |
| deleted_at | timestamp with time zone | 是 |  |  |

索引：`host_avail_idx`、`host_availability_pkey`（唯一）

## `host_communities`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| organization_id | text | 否 |  | organizations.id |
| host_id | text | 否 |  | hosts.id |
| community_id | text | 否 |  | communities.id |
| role | text | 否 | `'OWNER'::text` |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| ended_at | timestamp with time zone | 是 |  |  |

索引：`host_comm_comm_idx`、`host_communities_pkey`（唯一）

## `hosts`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| display_name | text | 否 |  |  |
| normalized_name | text | 否 |  |  |
| legal_name | text | 是 |  |  |
| contact_email | text | 是 |  |  |
| contact_phone | text | 是 |  |  |
| line_id | text | 是 |  |  |
| status | text | 否 | `'ACTIVE'::text` |  |
| audience_note | text | 是 |  |  |
| cooperation_terms | text | 是 |  |  |
| internal_note | text | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |
| deleted_at | timestamp with time zone | 是 |  |  |
| partner_type | text | 是 |  |  |

索引：`hosts_name_uq`（唯一）、`hosts_pkey`（唯一）

## `id_counters`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| key | text | 否 |  |  |
| period | text | 否 | `''::text` |  |
| n | bigint | 否 | `0` |  |

索引：`id_counters_pkey`（唯一）

## `idempotency_keys`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| scope | text | 否 |  |  |
| key | text | 否 |  |  |
| organization_id | text | 否 |  |  |
| response | jsonb | 是 |  |  |
| status_code | integer | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| request_hash | text | 是 |  |  |

索引：`idempotency_keys_pkey`（唯一）

## `import_batches`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| source_system | text | 否 |  |  |
| data_origin | text | 否 |  |  |
| file_name | text | 是 |  |  |
| checksum | text | 否 |  |  |
| status | text | 否 | `'PROCESSING'::text` |  |
| total_rows | integer | 否 | `0` |  |
| inserted_rows | integer | 否 | `0` |  |
| updated_rows | integer | 否 | `0` |  |
| duplicate_rows | integer | 否 | `0` |  |
| error_rows | integer | 否 | `0` |  |
| data_as_of | timestamp with time zone | 是 |  |  |
| started_at | timestamp with time zone | 否 | `now()` |  |
| finished_at | timestamp with time zone | 是 |  |  |
| created_by | text | 是 |  |  |

索引：`import_batches_organization_id_checksum_key`（唯一）、`import_batches_pkey`（唯一）

## `import_errors`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | bigint | 否 | `nextval('import_errors_id_seq'::regclass)` |  |
| organization_id | text | 否 |  |  |
| batch_id | text | 否 |  | import_batches.id |
| line_no | integer | 否 |  |  |
| code | text | 否 |  |  |
| message | text | 否 |  |  |
| raw_row | jsonb | 是 |  |  |
| status | text | 否 | `'OPEN'::text` |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| resolved_at | timestamp with time zone | 是 |  |  |
| resolved_by | text | 是 |  |  |

索引：`import_errors_batch_idx`、`import_errors_pkey`（唯一）

## `inventory_movements`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| sku_id | text | 否 |  | skus.id |
| campaign_id | text | 是 |  | campaigns.id |
| shipment_id | text | 是 |  | shipments.id |
| delta | integer | 否 |  |  |
| reason_code | text | 否 |  |  |
| reason | text | 否 |  |  |
| reverses_id | text | 是 |  | inventory_movements.id |
| created_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |

索引：`inventory_movements_pkey`（唯一）、`inventory_reverses_uq`（唯一）、`inventory_sku_idx`

## `invoices`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| invoice_no | text | 否 |  |  |
| invoice_date | date | 否 |  |  |
| amount | bigint | 否 |  |  |
| title_text | text | 是 |  |  |
| tax_id_text | text | 是 |  |  |
| campaign_id | text | 是 |  | campaigns.id |
| note | text | 是 |  |  |
| status | text | 否 | `'DRAFT'::text` |  |
| issued_at | timestamp with time zone | 是 |  |  |
| voided_at | timestamp with time zone | 是 |  |  |
| void_reason | text | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |

索引：`invoices_no_live_uq`（唯一）、`invoices_org_idx`、`invoices_pkey`（唯一）

## `notifications`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| channel | text | 否 |  |  |
| recipient_user_id | text | 是 |  | users.id |
| subject | text | 否 |  |  |
| body | text | 否 |  |  |
| entity_type | text | 是 |  |  |
| entity_id | text | 是 |  |  |
| dedupe_key | text | 是 |  |  |
| status | text | 否 | `'QUEUED'::text` |  |
| attempts | integer | 否 | `0` |  |
| last_error | text | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| sent_at | timestamp with time zone | 是 |  |  |
| read_at | timestamp with time zone | 是 |  |  |

索引：`notifications_dedupe_uq`（唯一）、`notifications_pkey`（唯一）、`notifications_queue_idx`、`notifications_recipient_idx`

## `order_items`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| order_id | text | 否 |  | orders.id |
| sku_id | text | 是 |  | skus.id |
| sku_code_raw | text | 是 |  |  |
| quantity | integer | 否 |  |  |
| unit_price | bigint | 否 |  |  |
| line_amount | bigint | 否 |  |  |

索引：`order_items_order_idx`、`order_items_pkey`（唯一）

## `orders`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| campaign_id | text | 否 |  | campaigns.id |
| source_system | text | 否 |  |  |
| source_order_id | text | 否 |  |  |
| ordered_at | timestamp with time zone | 否 |  |  |
| status | text | 否 |  |  |
| gross_amount | bigint | 否 |  |  |
| refund_amount | bigint | 否 | `0` |  |
| buyer_ref | text | 是 |  |  |
| data_origin | text | 否 |  |  |
| import_batch_id | text | 是 |  | import_batches.id |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| version | integer | 否 | `1` |  |

索引：`orders_campaign_idx`、`orders_organization_id_source_system_source_order_id_key`（唯一）、`orders_pkey`（唯一）、`orders_time_idx`

## `organizations`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| name | text | 否 |  |  |
| timezone | text | 否 | `'Asia/Taipei'::text` |  |
| currency | text | 否 | `'TWD'::text` |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| version | integer | 否 | `1` |  |

索引：`organizations_pkey`（唯一）

## `partner_segment_links`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| host_id | text | 否 |  | hosts.id |
| segment_id | text | 否 |  | customer_segments.id |
| community_id | text | 是 |  | communities.id |
| share_percent | numeric | 是 |  |  |
| basis | text | 否 | `'ESTIMATE'::text` |  |
| note | text | 是 |  |  |
| ended_at | timestamp with time zone | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |

索引：`partner_segment_links_pkey`（唯一）、`partner_segment_links_segment_idx`、`partner_segment_links_uq`（唯一）

## `payments`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| direction | text | 否 |  |  |
| counterparty_type | text | 否 |  |  |
| counterparty_id | text | 是 |  |  |
| amount | bigint | 否 |  |  |
| paid_on | date | 否 |  |  |
| reference_no | text | 是 |  |  |
| note | text | 是 |  |  |
| campaign_id | text | 是 |  | campaigns.id |
| settlement_item_id | text | 是 |  | settlement_items.id |
| match_status | text | 否 | `'UNMATCHED'::text` |  |
| matched_at | timestamp with time zone | 是 |  |  |
| matched_by | text | 是 |  |  |
| status | text | 否 | `'ACTIVE'::text` |  |
| void_reason | text | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |

索引：`payments_campaign_idx`、`payments_org_idx`、`payments_pkey`（唯一）

## `product_assets`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| product_id | text | 否 |  | products.id |
| kind | text | 否 |  |  |
| title | text | 否 |  |  |
| url | text | 否 |  |  |
| status | text | 否 | `'SUBMITTED'::text` |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |
| deleted_at | timestamp with time zone | 是 |  |  |

索引：`product_assets_idx`、`product_assets_pkey`（唯一）

## `product_evaluations`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| product_id | text | 否 |  | products.id |
| version_no | integer | 否 |  |  |
| status | text | 否 | `'DRAFT'::text` |  |
| scores | jsonb | 否 | `'{}'::jsonb` |  |
| compliance | jsonb | 否 | `'{}'::jsonb` |  |
| config_version | integer | 是 |  |  |
| config_snapshot | jsonb | 是 |  |  |
| total_score | numeric | 是 |  |  |
| completeness | numeric | 是 |  |  |
| confidence | text | 是 |  |  |
| recommendation | text | 是 |  |  |
| evidence_gaps | jsonb | 是 |  |  |
| evaluator_id | text | 是 |  |  |
| evaluated_on | date | 是 |  |  |
| submitted_at | timestamp with time zone | 是 |  |  |
| review_decision | text | 是 |  |  |
| review_note | text | 是 |  |  |
| reviewed_by | text | 是 |  |  |
| reviewed_at | timestamp with time zone | 是 |  |  |
| superseded_at | timestamp with time zone | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |

索引：`product_evaluations_draft_uq`（唯一）、`product_evaluations_pkey`（唯一）、`product_evaluations_product_id_version_no_key`（唯一）、`product_evaluations_product_idx`

## `product_fit_assessments`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| product_id | text | 否 |  | products.id |
| host_id | text | 否 |  | hosts.id |
| campaign_id | text | 是 |  | campaigns.id |
| config_version | integer | 否 |  |  |
| config_snapshot | jsonb | 否 |  |  |
| input_hash | text | 否 |  |  |
| total_score | numeric | 是 |  |  |
| completeness | numeric | 否 |  |  |
| confidence | text | 否 |  |  |
| recommendation | text | 否 |  |  |
| dimensions | jsonb | 否 |  |  |
| hard_checks | jsonb | 否 |  |  |
| reasons | jsonb | 否 |  |  |
| sources | jsonb | 否 |  |  |
| assessed_by | text | 是 |  |  |
| assessed_at | timestamp with time zone | 否 | `now()` |  |
| review_decision | text | 是 |  |  |
| review_note | text | 是 |  |  |
| reviewed_by | text | 是 |  |  |
| reviewed_at | timestamp with time zone | 是 |  |  |
| superseded_at | timestamp with time zone | 是 |  |  |
| superseded_by | text | 是 |  |  |
| outcome | jsonb | 是 |  |  |
| outcome_at | timestamp with time zone | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| version | integer | 否 | `1` |  |

索引：`product_fit_assessments_pkey`（唯一）、`product_fit_campaign_idx`、`product_fit_current_uq`（唯一）、`product_fit_host_idx`、`product_fit_product_idx`、`product_fit_review_idx`

## `product_trials`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| product_id | text | 否 |  | products.id |
| sku_id | text | 是 |  | skus.id |
| vendor_id | text | 否 |  | vendors.id |
| level | text | 否 |  |  |
| trial_type | text | 否 |  |  |
| host_id | text | 是 |  | hosts.id |
| campaign_id | text | 是 |  | campaigns.id |
| tester_user_id | text | 是 |  | users.id |
| tester_note | text | 是 |  |  |
| qualification_trial_id | text | 是 |  | product_trials.id |
| sample_batch_id | text | 是 |  | fulfillment_batches.id |
| ship_date | date | 是 |  |  |
| arrival_date | date | 是 |  |  |
| start_date | date | 是 |  |  |
| feedback_date | date | 是 |  |  |
| closed_date | date | 是 |  |  |
| carrier | text | 是 |  |  |
| tracking_no | text | 是 |  |  |
| recovery_required | boolean | 否 | `false` |  |
| recovery_status | text | 否 | `'NOT_REQUIRED'::text` |  |
| recovery_date | date | 是 |  |  |
| recovery_note | text | 是 |  |  |
| status | text | 否 | `'OPEN'::text` |  |
| cancel_reason | text | 是 |  |  |
| conclusion | text | 是 |  |  |
| suggested_conclusion | text | 是 |  |  |
| conclusion_note | text | 是 |  |  |
| override_reason | text | 是 |  |  |
| concluded_by | text | 是 |  |  |
| concluded_at | timestamp with time zone | 是 |  |  |
| valid_until | date | 是 |  |  |
| basis_fingerprint | text | 是 |  |  |
| review_decision | text | 是 |  |  |
| review_note | text | 是 |  |  |
| reviewed_by | text | 是 |  |  |
| reviewed_at | timestamp with time zone | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |

索引：`product_trials_campaign_idx`、`product_trials_open_uq`（唯一）、`product_trials_pkey`（唯一）、`product_trials_product_idx`

## `products`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| vendor_id | text | 否 |  | vendors.id |
| name | text | 否 |  |  |
| normalized_name | text | 否 |  |  |
| category | text | 是 |  |  |
| description | text | 是 |  |  |
| listing_url | text | 是 |  |  |
| selling_points | text | 是 |  |  |
| compliance_note | text | 是 |  |  |
| review_status | text | 否 | `'DRAFT'::text` |  |
| review_note | text | 是 |  |  |
| reviewed_by | text | 是 |  |  |
| reviewed_at | timestamp with time zone | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |
| deleted_at | timestamp with time zone | 是 |  |  |

索引：`products_name_uq`（唯一）、`products_pkey`（唯一）、`products_vendor_idx`

## `refund_requests`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| case_id | text | 否 |  | service_cases.id |
| campaign_id | text | 否 |  | campaigns.id |
| order_id | text | 是 |  | orders.id |
| amount | bigint | 否 |  |  |
| reason | text | 否 |  |  |
| status | text | 否 | `'REQUESTED'::text` |  |
| requested_by | text | 是 |  |  |
| decided_by | text | 是 |  |  |
| decided_at | timestamp with time zone | 是 |  |  |
| decision_note | text | 是 |  |  |
| completed_by | text | 是 |  |  |
| completed_at | timestamp with time zone | 是 |  |  |
| completion_note | text | 是 |  |  |
| writeback_applied | boolean | 否 | `false` |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| version | integer | 否 | `1` |  |

索引：`refund_requests_case_idx`、`refund_requests_order_idx`、`refund_requests_pkey`（唯一）、`refund_requests_status_idx`

## `roles`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| key | text | 否 |  |  |
| name_zh | text | 否 |  |  |
| description | text | 否 | `''::text` |  |
| is_internal | boolean | 否 | `true` |  |

索引：`roles_pkey`（唯一）

## `segment_evidence`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| segment_id | text | 否 |  | customer_segments.id |
| host_id | text | 是 |  | hosts.id |
| kind | text | 否 |  |  |
| basis | text | 否 | `'ESTIMATE'::text` |  |
| summary | text | 否 |  |  |
| source_label | text | 是 |  |  |
| source_url | text | 是 |  |  |
| observed_on | date | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |
| deleted_at | timestamp with time zone | 是 |  |  |

索引：`segment_evidence_idx`、`segment_evidence_pkey`（唯一）

## `segment_preferences`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| segment_id | text | 否 |  | customer_segments.id |
| kind | text | 否 |  |  |
| value | text | 否 |  |  |
| normalized_value | text | 否 |  |  |
| basis | text | 否 | `'ESTIMATE'::text` |  |
| evidence_id | text | 是 |  | segment_evidence.id |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |
| deleted_at | timestamp with time zone | 是 |  |  |

索引：`segment_preferences_idx`、`segment_preferences_pkey`（唯一）、`segment_preferences_uq`（唯一）

## `service_cases`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| campaign_id | text | 否 |  | campaigns.id |
| order_id | text | 是 |  | orders.id |
| case_type | text | 否 |  |  |
| status | text | 否 | `'OPEN'::text` |  |
| priority | text | 否 | `'MEDIUM'::text` |  |
| title | text | 否 |  |  |
| description | text | 是 |  |  |
| buyer_ref | text | 是 |  |  |
| assignee_user_id | text | 是 |  | users.id |
| due_date | date | 是 |  |  |
| resolution | text | 是 |  |  |
| internal_note | text | 是 |  |  |
| resolved_at | timestamp with time zone | 是 |  |  |
| closed_at | timestamp with time zone | 是 |  |  |
| cancelled_at | timestamp with time zone | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |

索引：`service_cases_assignee_idx`、`service_cases_campaign_idx`、`service_cases_order_idx`、`service_cases_pkey`（唯一）、`service_cases_status_idx`

## `sessions`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| token_hash | text | 否 |  |  |
| user_id | text | 否 |  | users.id |
| created_at | timestamp with time zone | 否 | `now()` |  |
| expires_at | timestamp with time zone | 否 |  |  |
| revoked_at | timestamp with time zone | 是 |  |  |
| ip | text | 是 |  |  |
| user_agent | text | 是 |  |  |

索引：`sessions_pkey`（唯一）、`sessions_user_idx`

## `settlement_adjustments`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| settlement_id | text | 否 |  | settlements.id |
| item_id | text | 否 |  | settlement_items.id |
| amount | bigint | 否 |  |  |
| reason | text | 否 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |

索引：`settlement_adjustments_idx`、`settlement_adjustments_pkey`（唯一）

## `settlement_items`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| settlement_id | text | 否 |  | settlements.id |
| campaign_id | text | 否 |  | campaigns.id |
| host_id | text | 是 |  | hosts.id |
| net_sales | bigint | 是 |  |  |
| commission_auto | bigint | 是 |  |  |
| commission_override | bigint | 是 |  |  |
| override_reason | text | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| rate_percent | numeric | 是 |  |  |
| rule_id | text | 是 |  |  |
| rule_version | integer | 是 |  |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| updated_by | text | 是 |  |  |

索引：`settlement_items_host_idx`、`settlement_items_pkey`（唯一）、`settlement_items_uq`（唯一）

## `settlements`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| status | text | 否 | `'DRAFT'::text` |  |
| period_start | date | 是 |  |  |
| period_end | date | 是 |  |  |
| rule_version_note | text | 是 |  |  |
| note | text | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| confirmed_at | timestamp with time zone | 是 |  |  |
| confirmed_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| campaign_id | text | 是 |  | campaigns.id |
| data_as_of | timestamp with time zone | 是 |  |  |
| data_status | text | 是 |  |  |
| voided_at | timestamp with time zone | 是 |  |  |
| voided_by | text | 是 |  |  |
| void_reason | text | 是 |  |  |

索引：`settlements_campaign_live_uq`（唯一）、`settlements_org_idx`、`settlements_pkey`（唯一）

## `shipments`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| campaign_id | text | 否 |  | campaigns.id |
| batch_id | text | 否 |  | fulfillment_batches.id |
| sku_id | text | 是 |  | skus.id |
| quantity | integer | 否 |  |  |
| carrier | text | 是 |  |  |
| tracking_no | text | 是 |  |  |
| status | text | 否 | `'PENDING'::text` |  |
| planned_date | date | 是 |  |  |
| shipped_date | date | 是 |  |  |
| delivered_date | date | 是 |  |  |
| exception_reason | text | 是 |  |  |
| cancel_reason | text | 是 |  |  |
| receipt_confirmed_at | timestamp with time zone | 是 |  |  |
| receipt_confirmed_by | text | 是 |  |  |
| receipt_signer | text | 是 |  |  |
| receipt_note | text | 是 |  |  |
| note | text | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |

索引：`shipments_batch_idx`、`shipments_campaign_idx`、`shipments_pkey`（唯一）、`shipments_tracking_uq`（唯一）

## `skus`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| product_id | text | 否 |  | products.id |
| sku_code | text | 否 |  |  |
| name | text | 否 |  |  |
| list_price | bigint | 是 |  |  |
| group_price | bigint | 是 |  |  |
| cost_price | bigint | 是 |  |  |
| status | text | 否 | `'ACTIVE'::text` |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |
| deleted_at | timestamp with time zone | 是 |  |  |

索引：`skus_code_uq`（唯一）、`skus_org_idx`、`skus_pkey`（唯一）

## `system_settings`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| organization_id | text | 否 |  | organizations.id |
| key | text | 否 |  |  |
| value | jsonb | 否 |  |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| updated_by | text | 是 |  |  |

索引：`system_settings_pkey`（唯一）

## `task_dependencies`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| task_id | text | 否 |  | tasks.id |
| depends_on_task_id | text | 否 |  | tasks.id |

索引：`task_dependencies_pkey`（唯一）

## `tasks`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| campaign_id | text | 否 |  | campaigns.id |
| step_key | text | 否 |  |  |
| name | text | 否 |  |  |
| phase | integer | 否 |  |  |
| seq | integer | 否 |  |  |
| owner_role | text | 否 |  | roles.key |
| assignee_user_id | text | 是 |  | users.id |
| kind | text | 否 | `'TASK'::text` |  |
| gate_key | text | 是 |  |  |
| status | text | 否 | `'TODO'::text` |  |
| planned_start | date | 是 |  |  |
| planned_end | date | 是 |  |  |
| actual_start | date | 是 |  |  |
| completed_at | timestamp with time zone | 是 |  |  |
| completed_by | text | 是 |  |  |
| date_locked | boolean | 否 | `false` |  |
| date_lock_reason | text | 是 |  |  |
| optional | boolean | 否 | `false` |  |
| skip_reason | text | 是 |  |  |
| blocker_reason | text | 是 |  |  |
| evidence_url | text | 是 |  |  |
| evidence_note | text | 是 |  |  |
| schedule_issue | text | 是 |  |  |
| overdue_flagged_at | timestamp with time zone | 是 |  |  |
| template_version | integer | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |

索引：`tasks_assignee_idx`、`tasks_campaign_id_step_key_key`（唯一）、`tasks_campaign_idx`、`tasks_org_status_idx`、`tasks_pkey`（唯一）

## `trial_checks`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| trial_id | text | 否 |  | product_trials.id |
| dimension | text | 否 |  |  |
| item_key | text | 否 |  |  |
| item_label | text | 否 |  |  |
| result | text | 否 | `'NOT_TESTED'::text` |  |
| evidence_text | text | 是 |  |  |
| defect_severity | text | 否 | `'NONE'::text` |  |
| defect_note | text | 是 |  |  |
| risk_note | text | 是 |  |  |
| verified_by | text | 是 |  |  |
| verified_at | timestamp with time zone | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |

索引：`trial_checks_pkey`（唯一）、`trial_checks_trial_id_item_key_key`（唯一）、`trial_checks_trial_idx`

## `user_scopes`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| user_id | text | 否 |  | users.id |
| scope_type | text | 否 |  |  |
| scope_id | text | 否 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| revoked_at | timestamp with time zone | 是 |  |  |

索引：`user_scopes_pkey`（唯一）、`user_scopes_scope_idx`

## `users`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| email | text | 否 |  |  |
| name | text | 否 |  |  |
| role_key | text | 否 |  | roles.key |
| password_hash | text | 否 |  |  |
| status | text | 否 | `'ACTIVE'::text` |  |
| failed_login_count | integer | 否 | `0` |  |
| locked_until | timestamp with time zone | 是 |  |  |
| last_login_at | timestamp with time zone | 是 |  |  |
| must_change_password | boolean | 否 | `false` |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |
| deleted_at | timestamp with time zone | 是 |  |  |

索引：`users_email_uq`（唯一）、`users_org_idx`、`users_pkey`（唯一）

## `vendor_contacts`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| vendor_id | text | 否 |  | vendors.id |
| name | text | 否 |  |  |
| title | text | 是 |  |  |
| email | text | 是 |  |  |
| phone | text | 是 |  |  |
| line_id | text | 是 |  |  |
| is_primary | boolean | 否 | `false` |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |
| deleted_at | timestamp with time zone | 是 |  |  |

索引：`vendor_contacts_idx`、`vendor_contacts_pkey`（唯一）、`vendor_contacts_primary_uq`（唯一）

## `vendor_dd_items`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| record_id | text | 否 |  | vendor_dd_records.id |
| category_key | text | 否 |  |  |
| status | text | 否 | `'PENDING_DOCS'::text` |  |
| responsible_party | text | 否 | `'TBD'::text` |  |
| owner_user_id | text | 是 |  | users.id |
| terms | jsonb | 否 | `'{}'::jsonb` |  |
| note | text | 是 |  |  |
| na_reason | text | 是 |  |  |
| risk_note | text | 是 |  |  |
| legal_status | text | 否 | `'NOT_REQUIRED'::text` |  |
| legal_reason | text | 是 |  |  |
| legal_note | text | 是 |  |  |
| legal_cleared_by | text | 是 |  |  |
| legal_cleared_at | timestamp with time zone | 是 |  |  |
| confirmed_by | text | 是 |  |  |
| confirmed_at | timestamp with time zone | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |

索引：`vendor_dd_items_pkey`（唯一）、`vendor_dd_items_record_id_category_key_key`（唯一）、`vendor_dd_items_record_idx`

## `vendor_dd_records`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| vendor_id | text | 否 |  | vendors.id |
| product_id | text | 是 |  | products.id |
| contract_version | text | 否 |  |  |
| contract_ref | text | 是 |  |  |
| regulated_category | text | 是 |  |  |
| status | text | 否 | `'DRAFT'::text` |  |
| prepared_by | text | 是 |  |  |
| submitted_at | timestamp with time zone | 是 |  |  |
| reviewed_by | text | 是 |  |  |
| reviewed_at | timestamp with time zone | 是 |  |  |
| review_note | text | 是 |  |  |
| valid_until | date | 是 |  |  |
| note | text | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |
| deleted_at | timestamp with time zone | 是 |  |  |

索引：`vendor_dd_records_pkey`（唯一）、`vendor_dd_records_uq`（唯一）、`vendor_dd_records_vendor_idx`

## `vendor_intake_submissions`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| external_submission_id | text | 否 |  |  |
| payload | jsonb | 否 |  |  |
| status | text | 否 | `'NEW'::text` |  |
| vendor_id | text | 是 |  | vendors.id |
| campaign_id | text | 是 |  | campaigns.id |
| note | text | 是 |  |  |
| received_at | timestamp with time zone | 否 | `now()` |  |
| processed_at | timestamp with time zone | 是 |  |  |
| received_by | text | 是 |  |  |

索引：`vendor_intake_submissions_organization_id_external_submissi_key`（唯一）、`vendor_intake_submissions_pkey`（唯一）

## `vendors`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| name | text | 否 |  |  |
| normalized_name | text | 否 |  |  |
| company_name | text | 是 |  |  |
| tax_id | text | 是 |  |  |
| category | text | 是 |  |  |
| website | text | 是 |  |  |
| status | text | 否 | `'PROSPECT'::text` |  |
| cooperation_note | text | 是 |  |  |
| internal_note | text | 是 |  |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| updated_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |
| updated_by | text | 是 |  |  |
| version | integer | 否 | `1` |  |
| deleted_at | timestamp with time zone | 是 |  |  |

索引：`vendors_name_uq`（唯一）、`vendors_pkey`（唯一）、`vendors_tax_uq`（唯一）

## `workflow_template_steps`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| template_id | text | 否 |  | workflow_templates.id |
| step_key | text | 否 |  |  |
| seq | integer | 否 |  |  |
| name | text | 否 |  |  |
| phase | integer | 否 |  |  |
| owner_role | text | 否 |  | roles.key |
| kind | text | 否 | `'TASK'::text` |  |
| gate_key | text | 是 |  |  |
| start_rule | jsonb | 否 |  |  |
| duration | jsonb | 否 |  |  |
| depends_on | ARRAY | 否 | `'{}'::text[]` |  |
| optional | boolean | 否 | `false` |  |
| condition_key | text | 是 |  |  |
| description | text | 是 |  |  |

索引：`workflow_template_steps_pkey`（唯一）

## `workflow_templates`

| 欄位 | 型別 | 可空 | 預設 | 參照 |
|---|---|:-:|---|---|
| id | text | 否 |  |  |
| organization_id | text | 否 |  | organizations.id |
| key | text | 否 |  |  |
| version | integer | 否 |  |  |
| name | text | 否 |  |  |
| description | text | 是 |  |  |
| status | text | 否 | `'ACTIVE'::text` |  |
| params | jsonb | 否 | `'{}'::jsonb` |  |
| created_at | timestamp with time zone | 否 | `now()` |  |
| created_by | text | 是 |  |  |

索引：`workflow_templates_organization_id_key_version_key`（唯一）、`workflow_templates_pkey`（唯一）

