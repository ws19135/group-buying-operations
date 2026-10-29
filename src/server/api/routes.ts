import { z } from 'zod';
import { pool, query } from '../lib/db';
import { SESSION_COOKIE, SESSION_TTL_HOURS, appEnv } from '../lib/config';
import { AppError, validation } from '../lib/errors';
import { rateLimit } from '../lib/rate-limit';
import { can, isInternal, requirePerm, ROLE_LABEL, ROLE_PERMISSIONS } from '../lib/permissions';
import { camelize } from '../lib/case';
import { login, logout, createUser, listUsers, setUserStatus, parseCookie } from '../modules/auth';
import * as vendors from '../modules/vendors';
import * as hosts from '../modules/hosts';
import * as products from '../modules/products';
import * as campaigns from '../modules/campaigns';
import * as gates from '../modules/gates';
import * as tasks from '../modules/tasks';
import * as orders from '../modules/orders';
import * as commission from '../modules/commission';
import * as settlements from '../modules/settlements';
import * as finance from '../modules/finance';
import * as dash from '../modules/dashboard';
import * as automation from '../modules/automation';
import * as intake from '../modules/intake';
import * as notif from '../modules/notifications';
import * as fulfillment from '../modules/fulfillment';
import * as aftersales from '../modules/aftersales';
import * as segments from '../modules/segments';
import * as fit from '../modules/fit';
import { listAudit, listCampaignAudit } from '../modules/audit-read';
import { loadActiveTemplate } from '../workflow/templates';
import { PHASES } from '../workflow/template-default';
import { setRoutes, type RouteDef, type Handler, type PublicHandler } from './router';

const body = <T extends z.ZodTypeAny>(c: { body: unknown }, schema: T): z.infer<T> => schema.parse(c.body ?? {});
const R = (method: string, path: string, handler: Handler): RouteDef => ({ method, path, handler });
const P = (method: string, path: string, handler: PublicHandler): RouteDef => ({ method, path, handler, public: true });
const created = (data: unknown) => ({ status: 201, data });

const cookieHeader = (token: string, maxAgeSec: number) =>
  `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${appEnv() === 'production' ? '; Secure' : ''}`;

export const routes: RouteDef[] = [
  // ---------- 健康檢查（公開，不含任何資料） ----------
  P('GET', '/health', async () => {
    const t0 = Date.now();
    await query('SELECT 1');
    return { ok: true, db: 'up', latencyMs: Date.now() - t0, env: appEnv(), time: new Date().toISOString() };
  }),

  // ---------- 認證 ----------
  P('POST', '/auth/login', async (c) => {
    const b = body(c, z.object({ email: z.string().min(1), password: z.string().min(1) }));
    const ip = (c.req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'local';
    if (!rateLimit(`login:ip:${ip}`, 30, 60_000) || !rateLimit(`login:acct:${b.email.toLowerCase()}`, 10, 60_000)) throw new AppError('RATE_LIMITED', '嘗試次數過多，請稍後再試');
    const r = await login(b.email, b.password, { ip, userAgent: c.req.headers.get('user-agent'), requestId: c.requestId });
    return { data: { user: { id: r.actor.userId, name: r.actor.name, role: r.actor.role, roleLabel: ROLE_LABEL[r.actor.role] } },
      headers: { 'set-cookie': cookieHeader(r.token, SESSION_TTL_HOURS * 3600) } };
  }),
  P('POST', '/auth/logout', async (c) => {
    const token = parseCookie(c.req.headers.get('cookie'), SESSION_COOKIE);
    if (token) await logout(token);
    return { data: { ok: true }, headers: { 'set-cookie': cookieHeader('', 0) } };
  }),
  R('GET', '/auth/me', async (c) => ({
    id: c.actor.userId, name: c.actor.name, role: c.actor.role, roleLabel: ROLE_LABEL[c.actor.role],
    permissions: ROLE_PERMISSIONS[c.actor.role], hostIds: c.actor.hostIds, vendorIds: c.actor.vendorIds,
  })),

  // ---------- 使用者 ----------
  R('GET', '/users', async (c) => listUsers(c.actor)),
  R('POST', '/users', async (c) => created(await createUser(c.actor, c.body as never))),
  R('POST', '/users/:id/status', async (c) => setUserStatus(c.actor, c.params.id, body(c, z.object({ status: z.enum(['ACTIVE', 'DISABLED']) })).status)),

  // ---------- 廠商 ----------
  R('GET', '/vendors', async (c) => vendors.listVendors(c.actor, c.query)),
  R('POST', '/vendors', async (c) => created(await vendors.createVendor(c.actor, c.body as never, c.idemKey))),
  R('GET', '/vendors/:id', async (c) => vendors.getVendor(c.actor, c.params.id)),
  R('PATCH', '/vendors/:id', async (c) => vendors.updateVendor(c.actor, c.params.id, c.body as never)),
  R('POST', '/vendors/:id/archive', async (c) => vendors.archiveVendor(c.actor, c.params.id, body(c, z.object({ reason: z.string() })).reason)),
  R('POST', '/vendors/:id/contacts', async (c) => created(await vendors.addVendorContact(c.actor, c.params.id, c.body as never))),
  R('POST', '/vendor-contacts/:id/archive', async (c) => vendors.archiveVendorContact(c.actor, c.params.id)),

  // ---------- 團主／社群 ----------
  R('GET', '/hosts', async (c) => hosts.listHosts(c.actor, c.query)),
  R('POST', '/hosts', async (c) => created(await hosts.createHost(c.actor, c.body as never, c.idemKey))),
  R('GET', '/hosts/:id', async (c) => hosts.getHost(c.actor, c.params.id)),
  R('PATCH', '/hosts/:id', async (c) => hosts.updateHost(c.actor, c.params.id, c.body as never)),
  R('POST', '/hosts/:id/archive', async (c) => hosts.archiveHost(c.actor, c.params.id, body(c, z.object({ reason: z.string() })).reason)),
  R('POST', '/hosts/:id/availability', async (c) => created(await hosts.addAvailability(c.actor, c.params.id, c.body as never))),
  R('POST', '/availability/:id/remove', async (c) => hosts.removeAvailability(c.actor, c.params.id)),
  R('POST', '/hosts/:id/communities', async (c) => { const b = body(c, z.object({ communityId: z.string(), role: z.enum(['OWNER', 'ADMIN', 'MEMBER']).optional() })); return created(await hosts.linkHostCommunity(c.actor, c.params.id, b.communityId, b.role)); }),
  R('POST', '/hosts/:id/communities/:cid/unlink', async (c) => hosts.unlinkHostCommunity(c.actor, c.params.id, c.params.cid)),
  R('GET', '/communities', async (c) => hosts.listCommunities(c.actor, c.query)),
  R('POST', '/communities', async (c) => {
    const b = body(c, z.object({ hostIds: z.array(z.string()).optional() }).passthrough());
    const { hostIds, ...rest } = b as { hostIds?: string[] } & Record<string, unknown>;
    return created(await hosts.createCommunity(c.actor, rest as never, hostIds ?? [], c.idemKey));
  }),
  R('GET', '/communities/:id', async (c) => hosts.getCommunity(c.actor, c.params.id)),
  R('PATCH', '/communities/:id', async (c) => hosts.updateCommunity(c.actor, c.params.id, c.body as never)),

  // ---------- 客群分析與商品適配（SOP 01；設計見 docs/phase2/SEGMENT_FIT.md） ----------
  R('GET', '/segments', async (c) => segments.listSegments(c.actor, c.query)),
  R('POST', '/segments', async (c) => created(await segments.createSegment(c.actor, c.body as never, c.idemKey))),
  R('GET', '/segments/:id', async (c) => segments.getSegment(c.actor, c.params.id)),
  R('PATCH', '/segments/:id', async (c) => segments.updateSegment(c.actor, c.params.id, c.body as never)),
  R('POST', '/segments/:id/archive', async (c) => segments.archiveSegment(c.actor, c.params.id, body(c, z.object({ reason: z.string() })).reason)),
  R('POST', '/segments/:id/evidence', async (c) => created(await segments.addEvidence(c.actor, c.params.id, c.body as never))),
  R('POST', '/segment-evidence/:id/remove', async (c) => segments.removeEvidence(c.actor, c.params.id)),
  R('GET', '/hosts/:id/segments', async (c) => segments.getHostSegments(c.actor, c.params.id)),
  R('POST', '/hosts/:id/segments', async (c) => created(await segments.linkHostSegment(c.actor, c.params.id, c.body as never, c.idemKey))),
  R('PATCH', '/segment-links/:id', async (c) => segments.updateSegmentLink(c.actor, c.params.id, c.body as never)),
  R('POST', '/segment-links/:id/end', async (c) => segments.endSegmentLink(c.actor, c.params.id, body(c, z.object({ reason: z.string().optional() })).reason)),
  R('GET', '/fit/config', async (c) => fit.getFitConfig(c.actor)),
  R('PUT', '/fit/config', async (c) => fit.putFitConfig(c.actor, c.body as never)),
  R('GET', '/fit/overview', async (c) => fit.fitOverview(c.actor)),
  R('GET', '/fit', async (c) => fit.listFit(c.actor, c.query)),
  R('GET', '/fit/:id', async (c) => fit.getFit(c.actor, c.params.id)),
  R('POST', '/fit/:id/review', async (c) => fit.reviewFit(c.actor, c.params.id, c.body as never)),
  R('GET', '/products/:id/fit', async (c) => fit.listProductFit(c.actor, c.params.id)),
  R('POST', '/products/:id/fit', async (c) => fit.assessProduct(c.actor, c.params.id, c.body as never)),
  R('GET', '/campaigns/:id/fit', async (c) => fit.listCampaignFit(c.actor, c.params.id)),
  R('POST', '/campaigns/:id/fit', async (c) => fit.assessCampaign(c.actor, c.params.id)),
  R('POST', '/campaigns/:id/fit/outcome', async (c) => fit.recordCampaignOutcome(c.actor, c.params.id)),

  // ---------- 商品 ----------
  R('GET', '/products', async (c) => products.listProducts(c.actor, c.query)),
  R('POST', '/products', async (c) => created(await products.createProduct(c.actor, c.body as never, c.idemKey))),
  R('GET', '/products/:id', async (c) => products.getProduct(c.actor, c.params.id)),
  R('PATCH', '/products/:id', async (c) => products.updateProduct(c.actor, c.params.id, c.body as never)),
  R('POST', '/products/:id/skus', async (c) => created(await products.addSku(c.actor, c.params.id, c.body as never))),
  R('PATCH', '/skus/:id', async (c) => products.updateSku(c.actor, c.params.id, c.body as never)),
  R('POST', '/products/:id/review', async (c) => { const b = body(c, z.object({ to: z.string(), note: z.string().optional() })); return products.setProductReview(c.actor, c.params.id, b.to, b.note); }),
  R('POST', '/products/:id/assets', async (c) => created(await products.addAsset(c.actor, c.params.id, c.body as never))),

  // ---------- 檔期 ----------
  R('GET', '/campaigns', async (c) => campaigns.listCampaigns(c.actor, c.query)),
  R('POST', '/campaigns', async (c) => created(await campaigns.createCampaign(c.actor, c.body as never, c.idemKey))),
  R('GET', '/campaigns/:id', async (c) => campaigns.getCampaign(c.actor, c.params.id)),
  R('PATCH', '/campaigns/:id', async (c) => campaigns.updateCampaign(c.actor, c.params.id, c.body as never)),
  R('POST', '/campaigns/:id/reschedule', async (c) => {
    const b = body(c, z.object({ confirm: z.boolean().optional(), token: z.string().optional(), changes: z.record(z.unknown()) }));
    return b.confirm ? campaigns.applyCampaignReschedule(c.actor, c.params.id, b.changes as never, b.token ?? '') : campaigns.previewCampaignReschedule(c.actor, c.params.id, b.changes as never);
  }),
  R('POST', '/campaigns/:id/products', async (c) => created(await campaigns.addCampaignProduct(c.actor, c.params.id, c.body as never))),
  R('PATCH', '/campaigns/:id/products/:cpId', async (c) => campaigns.updateCampaignProduct(c.actor, c.params.id, c.params.cpId, c.body as never)),
  R('POST', '/campaigns/:id/products/:cpId/remove', async (c) => campaigns.removeCampaignProduct(c.actor, c.params.id, c.params.cpId)),
  R('POST', '/campaigns/:id/hosts', async (c) => created(await campaigns.addCampaignHost(c.actor, c.params.id, c.body as never))),
  R('POST', '/campaigns/:id/hosts/:hostId/respond', async (c) => {
    const b = body(c, z.object({ status: z.enum(['CONFIRMED', 'DECLINED', 'NO_RESPONSE']), note: z.string().optional() }));
    return campaigns.setCampaignHostStatus(c.actor, c.params.id, c.params.hostId, b.status, b.note);
  }),
  R('POST', '/campaigns/:id/hosts/:hostId/remove', async (c) => campaigns.removeCampaignHost(c.actor, c.params.id, c.params.hostId, body(c, z.object({ reason: z.string() })).reason)),
  R('POST', '/campaigns/:id/placements', async (c) => created(await campaigns.addPlacement(c.actor, c.params.id, c.body as never))),
  R('POST', '/campaigns/:id/placements/:pid/status', async (c) => {
    const b = body(c, z.object({ status: z.enum(['PLANNED', 'DONE', 'MISSED', 'CANCELLED']), note: z.string().optional() }));
    return campaigns.setPlacementStatus(c.actor, c.params.id, c.params.pid, b.status, b.note);
  }),
  R('POST', '/campaigns/:id/status', async (c) => {
    const b = body(c, z.object({ action: z.enum(['transition', 'cancel', 'hold', 'resume']), to: z.string().optional(), reason: z.string().optional(), force: z.boolean().optional() }));
    if (b.action === 'cancel') return gates.cancelCampaign(c.actor, c.params.id, b.reason ?? '');
    if (b.action === 'hold') return gates.holdCampaign(c.actor, c.params.id, b.reason ?? '');
    if (b.action === 'resume') return gates.resumeCampaign(c.actor, c.params.id, b.reason ?? '');
    if (!b.to) throw validation('請指定目標狀態 to');
    return gates.transitionCampaign(c.actor, c.params.id, b.to as never, { reason: b.reason, force: b.force });
  }),
  R('GET', '/campaigns/:id/gates/:gate', async (c) => gates.gateCheck(c.actor, c.params.id, c.params.gate)),
  R('POST', '/campaigns/:id/gates/:gate/request', async (c) => created(await gates.requestApproval(c.actor, c.params.id, c.params.gate, body(c, z.object({ note: z.string().optional() })).note))),
  R('GET', '/campaigns/:id/audit', async (c) => listCampaignAudit(c.actor, c.params.id)),

  // ---------- 核准 ----------
  R('GET', '/approvals', async (c) => gates.listApprovals(c.actor, c.query)),
  R('POST', '/approvals/:id/decision', async (c) => {
    const b = body(c, z.object({ decision: z.enum(['APPROVED', 'REJECTED']), note: z.string().optional(), acknowledge: z.string().optional() }));
    return gates.decideApproval(c.actor, c.params.id, b.decision, b.note, b.acknowledge);
  }),

  // ---------- 任務 ----------
  R('GET', '/tasks', async (c) => tasks.listTasks(c.actor, c.query)),
  R('GET', '/tasks/:id', async (c) => tasks.getTask(c.actor, c.params.id)),
  R('PATCH', '/tasks/:id', async (c) => tasks.updateTask(c.actor, c.params.id, c.body as never)),
  R('POST', '/tasks/:id/status', async (c) => tasks.setTaskStatus(c.actor, c.params.id, c.body as never)),
  R('GET', '/workflow/template', async (c) => {
    requirePerm(c.actor, 'task.read');
    const t = await loadActiveTemplate(pool(), c.actor.orgId);
    return { id: t.id, key: t.key, version: t.version, name: t.name, params: t.params, phases: PHASES, steps: t.steps };
  }),

  // ---------- 訂單匯入／佣金 ----------
  R('GET', '/orders', async (c) => orders.listOrders(c.actor, c.query)),
  R('GET', '/imports', async (c) => orders.listImportBatches(c.actor, c.query)),
  R('POST', '/imports', async (c) => created(await orders.importOrders(c.actor, c.body as never))),
  R('GET', '/imports/:id/errors', async (c) => orders.listImportErrors(c.actor, c.params.id)),
  R('POST', '/import-errors/:id/resolve', async (c) => { const b = body(c, z.object({ status: z.enum(['RESOLVED', 'IGNORED']), note: z.string() })); return orders.resolveImportError(c.actor, Number(c.params.id), b.status, b.note); }),
  R('GET', '/commission-rules', async (c) => commission.listCommissionRules(c.actor, c.query)),
  R('POST', '/commission-rules', async (c) => created(await commission.createCommissionRule(c.actor, c.body as never))),

  // ---------- 履約與出貨（Phase 2） ----------
  R('GET', '/fulfillment/batches', async (c) => fulfillment.listBatches(c.actor, c.query)),
  R('POST', '/fulfillment/batches', async (c) => { const { campaignId, ...rest } = body(c, z.object({ campaignId: z.string().min(1, '請選擇檔期') }).passthrough()); return created(await fulfillment.createBatch(c.actor, campaignId, rest as never, c.idemKey)); }),
  R('GET', '/fulfillment/batches/:id', async (c) => fulfillment.getBatch(c.actor, c.params.id)),
  R('PATCH', '/fulfillment/batches/:id', async (c) => fulfillment.updateBatch(c.actor, c.params.id, c.body as never)),
  R('POST', '/fulfillment/batches/:id/cancel', async (c) => fulfillment.cancelBatch(c.actor, c.params.id, body(c, z.object({ reason: z.string() })).reason)),
  R('POST', '/fulfillment/batches/:id/shipments', async (c) => created(await fulfillment.addShipment(c.actor, c.params.id, c.body as never, c.idemKey))),
  R('GET', '/campaigns/:id/fulfillment', async (c) => fulfillment.getCampaignFulfillment(c.actor, c.params.id)),
  R('POST', '/campaigns/:id/fulfillment/batches', async (c) => created(await fulfillment.createBatch(c.actor, c.params.id, c.body as never, c.idemKey))),
  R('PATCH', '/fulfillment/shipments/:id', async (c) => fulfillment.updateShipment(c.actor, c.params.id, c.body as never)),
  R('POST', '/fulfillment/shipments/:id/status', async (c) => fulfillment.setShipmentStatus(c.actor, c.params.id, c.body as never)),
  R('POST', '/fulfillment/shipments/:id/receipt', async (c) => fulfillment.confirmReceipt(c.actor, c.params.id, c.body as never)),
  R('GET', '/inventory/stock', async (c) => fulfillment.listStock(c.actor, c.query)),
  R('GET', '/inventory/movements', async (c) => fulfillment.listMovements(c.actor, c.query)),
  R('POST', '/inventory/movements', async (c) => created(await fulfillment.adjustStock(c.actor, c.body as never, c.idemKey))),
  R('POST', '/inventory/movements/:id/correct', async (c) => created(await fulfillment.reverseMovement(c.actor, c.params.id, body(c, z.object({ reason: z.string() })).reason))),

  // ---------- 財務（Phase 2）：結算試算／入帳／發票／費用（全部是紀錄，不接任何外部金流） ----------
  R('GET', '/finance/overview', async (c) => finance.financeOverview(c.actor)),
  R('GET', '/settlements', async (c) => settlements.listSettlements(c.actor, c.query)),
  R('POST', '/settlements', async (c) => created(await settlements.createSettlement(c.actor, c.body as never, c.idemKey))),
  R('GET', '/settlements/mine', async (c) => settlements.mySettlementItems(c.actor)),
  R('GET', '/settlements/:id', async (c) => settlements.getSettlement(c.actor, c.params.id)),
  R('POST', '/settlements/:id/recalculate', async (c) => settlements.recalculateSettlement(c.actor, c.params.id)),
  R('POST', '/settlements/:id/adjustments', async (c) => created(await settlements.addAdjustment(c.actor, c.params.id, c.body as never))),
  R('POST', '/settlements/:id/confirm', async (c) => settlements.confirmSettlement(c.actor, c.params.id, c.body as never)),
  R('POST', '/settlements/:id/void', async (c) => settlements.voidSettlement(c.actor, c.params.id, body(c, z.object({ reason: z.string() })).reason)),
  R('POST', '/settlement-items/:id/override', async (c) => settlements.setItemOverride(c.actor, c.params.id, c.body as never)),
  R('GET', '/payments', async (c) => finance.listPayments(c.actor, c.query)),
  R('POST', '/payments', async (c) => created(await finance.createPayment(c.actor, c.body as never, c.idemKey))),
  R('PATCH', '/payments/:id', async (c) => finance.updatePayment(c.actor, c.params.id, c.body)),
  R('POST', '/payments/:id/match', async (c) => finance.matchPayment(c.actor, c.params.id, c.body as never)),
  R('POST', '/payments/:id/unmatch', async (c) => finance.unmatchPayment(c.actor, c.params.id, body(c, z.object({ reason: z.string() })).reason)),
  R('POST', '/payments/:id/void', async (c) => finance.voidPayment(c.actor, c.params.id, body(c, z.object({ reason: z.string() })).reason)),
  R('GET', '/invoices', async (c) => finance.listInvoices(c.actor, c.query)),
  R('POST', '/invoices', async (c) => created(await finance.createInvoice(c.actor, c.body as never, c.idemKey))),
  R('PATCH', '/invoices/:id', async (c) => finance.updateInvoice(c.actor, c.params.id, c.body)),
  R('POST', '/invoices/:id/issue', async (c) => finance.issueInvoice(c.actor, c.params.id)),
  R('POST', '/invoices/:id/void', async (c) => finance.voidInvoice(c.actor, c.params.id, body(c, z.object({ reason: z.string() })).reason)),
  R('GET', '/expenses', async (c) => finance.listExpenses(c.actor, c.query)),
  R('POST', '/expenses', async (c) => created(await finance.createExpense(c.actor, c.body as never, c.idemKey))),
  R('PATCH', '/expenses/:id', async (c) => finance.updateExpense(c.actor, c.params.id, c.body)),
  R('POST', '/expenses/:id/void', async (c) => finance.voidExpense(c.actor, c.params.id, body(c, z.object({ reason: z.string() })).reason)),

  // ---------- Dashboard ----------
  R('GET', '/dashboard/admin', async (c) => dash.getAdminDashboard(c.actor, c.query.get('month'), c.query.get('range'))),
  R('GET', '/dashboard/host', async (c) => dash.getHostDashboard(c.actor, c.query.get('hostId'), c.query.get('month'))),

  // ---------- 售後：案件／退款申請（Phase 2） ----------
  R('GET', '/aftersales/overview', async (c) => aftersales.getAftersalesOverview(c.actor)),
  R('GET', '/aftersales/cases', async (c) => aftersales.listCases(c.actor, c.query)),
  R('POST', '/aftersales/cases', async (c) => created(await aftersales.createCase(c.actor, c.body as never, c.idemKey))),
  R('GET', '/aftersales/cases/:id', async (c) => aftersales.getCase(c.actor, c.params.id)),
  R('PATCH', '/aftersales/cases/:id', async (c) => aftersales.updateCase(c.actor, c.params.id, c.body as never)),
  R('POST', '/aftersales/cases/:id/status', async (c) => aftersales.setCaseStatus(c.actor, c.params.id, c.body as never)),
  R('POST', '/aftersales/cases/:id/notes', async (c) => created(await aftersales.addCaseNote(c.actor, c.params.id, c.body as never))),
  R('POST', '/aftersales/cases/:id/refunds', async (c) => created(await aftersales.requestRefund(c.actor, c.params.id, c.body as never, c.idemKey))),
  R('GET', '/aftersales/refunds', async (c) => aftersales.listRefunds(c.actor, c.query)),
  R('POST', '/aftersales/refunds/:id/decision', async (c) => aftersales.decideRefund(c.actor, c.params.id, c.body as never)),
  R('POST', '/aftersales/refunds/:id/complete', async (c) => aftersales.completeRefund(c.actor, c.params.id, c.body as never)),

  // ---------- 例外／自動化／進件／通知／稽核 ----------
  R('GET', '/exceptions', async (c) => automation.listExceptions(c.actor, c.query)),
  R('POST', '/exceptions/:id/status', async (c) => { const b = body(c, z.object({ status: z.enum(['ACKNOWLEDGED', 'RESOLVED']), note: z.string() })); return automation.setExceptionStatus(c.actor, c.params.id, b.status, b.note); }),
  R('GET', '/automation/jobs', async (c) => automation.listJobs(c.actor)),
  R('POST', '/automation/jobs/:key', async (c) => {
    const b = body(c, z.object({ action: z.enum(['enable', 'disable', 'run']) }));
    if (b.action === 'run') return automation.runJobManually(c.actor, c.params.key);
    return automation.setJobEnabled(c.actor, c.params.key, b.action === 'enable');
  }),
  R('GET', '/automation/runs', async (c) => automation.listRuns(c.actor, c.query)),
  R('GET', '/intake', async (c) => intake.listIntake(c.actor, c.query)),
  R('POST', '/intake', async (c) => {
    const b = body(c, z.object({ externalSubmissionId: z.string(), payload: z.unknown() }));
    const r = await intake.receiveVendorIntake(c.actor, b.externalSubmissionId, b.payload);
    return { status: r.replayed ? 200 : 201, data: r };
  }),
  R('GET', '/notifications', async (c) => notif.listMyNotifications(c.actor, c.query)),
  R('GET', '/notifications/all', async (c) => notif.listAllNotifications(c.actor, c.query)),
  R('POST', '/notifications/:id/read', async (c) => notif.markNotificationRead(c.actor, c.params.id)),
  R('GET', '/audit', async (c) => listAudit(c.actor, c.query)),
];

setRoutes(routes);

export { camelize, can, isInternal };
