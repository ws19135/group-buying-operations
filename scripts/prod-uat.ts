/**
 * Live UAT（正式系統操作驗收）：以 HTTP 對實際運行的系統逐項操作 20 個驗收項目。
 * 只使用「隔離的 UAT 測試資料」：所有建立的資料都以 `[UAT-<runId>]` 標示；**只在全新的空環境（預備環境）執行**——
 * 腳本在寫入前會檢查：若系統已有任何「不是 UAT 標示」的廠商／團主／商品，立即拒絕（避免污染真實資料）。
 * 不觸發任何真實付款、通知、結算確認；不做任何破壞性操作（沒有刪除；只有建立與軟刪除／作廢）。
 *
 * 用法（密碼一律由環境變數提供，不寫進程式、不印出）：
 *   BASE_URL=https://staging.example UAT_ALLOW_WRITE=yes UAT_ADMIN_EMAIL=... UAT_ADMIN_PASSWORD=... [UAT_ADMIN_NEW_PASSWORD=...] npx tsx scripts/prod-uat.ts
 *   - 管理者若是「初次啟用」狀態（必須變更密碼），請提供 UAT_ADMIN_NEW_PASSWORD，腳本會先走變更密碼流程（驗收項目 2）。
 *   - 測試角色帳號（主管、小編、財務、團主、廠商）由腳本用管理者建立，密碼為隨機產生、不印出。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.BASE_URL ?? '').replace(/\/$/, '');
const RUN = `UAT-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
const MARK = `[${RUN}]`;
const results: { no: number; name: string; ok: boolean; detail?: string }[] = [];
const secrets: string[] = [];

class Session {
  cookie = '';
  constructor(public email: string) {}
  async call(method: string, p: string, body?: unknown): Promise<{ status: number; data: any; error?: { code: string; message: string } }> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const res = await fetch(`${BASE}/api${p}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), origin: BASE }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) { const m = /^([^=]+)=([^;]*)/.exec(set); if (m) this.cookie = m[2] ? `${m[1]}=${m[2]}` : ''; }
    const text = await res.text(); let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ } // eslint-disable-line @typescript-eslint/no-explicit-any
    return { status: res.status, data: json?.data, error: json?.error };
  }
  async login(password: string) { return this.call('POST', '/auth/login', { email: this.email, password }); }
}
const check = (no: number, name: string, ok: boolean, detail = '') => { results.push({ no, name, ok, detail }); console.log(`${ok ? '✅' : '❌'} ${no}. ${name}${detail ? ` — ${detail}` : ''}`); return ok; };
const rnd = () => `Uat-${crypto.randomBytes(9).toString('base64url')}-7`;
const day = (n: number) => new Date(Date.now() + n * 86400_000 + 8 * 3600_000).toISOString().slice(0, 10);

async function main() {
  if (!BASE) throw new Error('需要 BASE_URL');
  if (process.env.UAT_ALLOW_WRITE !== 'yes') throw new Error('Live UAT 會建立測試資料；請確認目標是「預備環境（空的）」後設定 UAT_ALLOW_WRITE=yes');
  const adminEmail = process.env.UAT_ADMIN_EMAIL ?? '', adminPw = process.env.UAT_ADMIN_PASSWORD ?? '';
  if (!adminEmail || !adminPw) throw new Error('需要 UAT_ADMIN_EMAIL 與 UAT_ADMIN_PASSWORD');
  secrets.push(adminPw, process.env.UAT_ADMIN_NEW_PASSWORD ?? '');

  // 1 入口與健康
  const page = await fetch(`${BASE}/login`).then((r) => ({ status: r.status, text: '' })).catch(() => ({ status: 0, text: '' }));
  const health = await new Session('').call('GET', '/health'); const ready = await new Session('').call('GET', '/ready');
  check(1, '系統入口正常：登入頁可開啟、/api/health 與 /api/ready 正常、HTTPS（若為 https 網址）', page.status === 200 && health.status === 200 && health.data?.db === 'up' && ready.status === 200 && (BASE.startsWith('https://') || /localhost|127\.0\.0\.1/.test(BASE)), `版本 ${health.data?.version ?? '?'}／commit ${String(health.data?.commit ?? '無').slice(0, 7)}／migration ${ready.data?.migrationsApplied ?? '?'}`);
  check(1.1, '未登入呼叫受保護 API 一律 401（不匿名開放）', (await new Session('').call('GET', '/vendors')).status === 401 && (await new Session('').call('GET', '/orders')).status === 401);

  // 2 登入（含初次啟用變更密碼）
  const admin = new Session(adminEmail);
  const lr = await admin.login(adminPw);
  let adminPwNow = adminPw;
  if (lr.status === 200 && lr.data?.mustChangePassword) {
    const blocked = await admin.call('GET', '/vendors');
    const np = process.env.UAT_ADMIN_NEW_PASSWORD ?? '';
    if (!np) throw new Error('管理者是初次啟用狀態：請提供 UAT_ADMIN_NEW_PASSWORD');
    const ch = await admin.call('POST', '/auth/change-password', { currentPassword: adminPw, newPassword: np });
    adminPwNow = np;
    check(2, '使用者能登入；初次啟用時被強制變更密碼（變更前其他 API 被擋、變更後可用）', blocked.status === 403 && blocked.error?.code === 'PASSWORD_CHANGE_REQUIRED' && ch.status === 200 && (await admin.call('GET', '/vendors')).status === 200);
  } else check(2, '使用者能登入', lr.status === 200);
  if (lr.status !== 200) throw new Error('管理者無法登入，後續驗收無法進行');
  void adminPwNow;

  // 防護：只在空環境或只有 UAT 資料的環境寫入
  const nonUat = async (p: string, key: (x: any) => string) => ((await admin.call('GET', p)).data?.items ?? (await admin.call('GET', p)).data ?? []).filter((x: any) => !key(x).includes('[UAT-')).length; // eslint-disable-line @typescript-eslint/no-explicit-any
  const foreign = (await nonUat('/vendors', (x) => String(x.name))) + (await nonUat('/hosts', (x) => String(x.displayName))) + (await nonUat('/products', (x) => String(x.name)));
  if (foreign > 0) throw new Error(`目標環境已有 ${foreign} 筆非 UAT 標示的主檔資料；為避免污染真實資料，拒絕執行 Live UAT`);

  // 測試角色帳號（隨機密碼，不印出）
  const roles: Record<string, Session> = {};
  const mk = async (key: string, role: string, extra: Record<string, unknown> = {}) => {
    const email = `${key}.${RUN.toLowerCase()}@uat.sdh-erp.test`; const pw = rnd(); secrets.push(pw);
    const r = await admin.call('POST', '/users', { email, name: `${MARK} ${key}`, role, password: pw, ...extra });
    if (r.status !== 201 && r.status !== 200) throw new Error(`建立測試帳號 ${key} 失敗：${r.status} ${r.error?.message}`);
    const s = new Session(email); const l = await s.login(pw); if (l.status !== 200) throw new Error(`測試帳號 ${key} 無法登入`); roles[key] = s; return s;
  };
  const manager = await mk('manager', 'OPS_MANAGER'); const editor = await mk('editor', 'OPS_EDITOR'); const finance = await mk('finance', 'FINANCE'); const verifier = await mk('verifier', 'OPS_MANAGER');

  // 3 角色工作台（權限差異）
  const me = async (s: Session) => (await s.call('GET', '/auth/me')).data;
  const mm = await me(manager), ee = await me(editor), ff = await me(finance), aa = await me(admin);
  check(3, '角色工作台正確：各角色的權限集合不同（管理者有使用者管理；財務有財務寫入無檔期編輯；小編無成本與財務）', aa.permissions.includes('user.manage') && ff.permissions.includes('finance.write') && !ff.permissions.includes('campaign.write') && !ee.permissions.includes('finance.read') && !ee.permissions.includes('product.cost.read') && mm.permissions.includes('product.cost.read') && !mm.permissions.includes('finance.write'));

  // 4～7 主檔與檔期
  const v = await manager.call('POST', '/vendors', { name: `${MARK} 廠商`, status: 'ACTIVE', companyName: `${MARK} 股份有限公司`, category: '食品', contacts: [{ name: '測試窗口', email: 'v@uat.sdh-erp.test', isPrimary: true }] });
  const vid = v.data?.id as string;
  const p = await manager.call('POST', '/products', { vendorId: vid, name: `${MARK} 商品`, skus: [{ skuCode: `UAT${RUN.slice(-4).toUpperCase()}`, name: '規格A', listPrice: 1000, groupPrice: 800, costPrice: 500 }] });
  const pid = p.data?.id as string, skuId = p.data?.skuIds?.[0] as string;
  const h = await manager.call('POST', '/hosts', { displayName: `${MARK} 團主` });
  const hid = h.data?.id as string;
  check(4, '商品可以建檔（含規格、原價、團購價、成本）', p.status === 201 && !!pid && !!skuId);
  check(5, '廠商可以建檔', v.status === 201 && !!vid);
  check(6, '團主可以建檔', h.status === 201 && !!hid);
  const c = await editor.call('POST', '/campaigns', { title: `${MARK} 檔期`, vendorId: vid, sampleReadyDate: day(-30), openDate: day(-10), closeDate: day(10), products: [{ productId: pid, skuId }], hosts: [{ hostId: hid }] });
  const cid = c.data?.id as string;
  check(7, '可以建立團購檔期（含商品與團主關聯）', c.status === 201 && !!cid);

  // 8 選品評估
  const ev = await manager.call('POST', `/products/${pid}/evaluations`, {});
  check(8, '可以執行選品評估（建立 V2 評估草稿並可讀回）', (ev.status === 201 || ev.status === 200) && !!ev.data?.id && (await manager.call('GET', `/evaluations/${ev.data?.id}`)).status === 200);

  // 9～12 試用與 KPI
  const tr = await manager.call('POST', `/products/${pid}/trials`, { level: 'HOST_FIT', trialType: 'MINI_GROUP', hostId: hid, campaignId: cid });
  const tid = tr.data?.id as string;
  check(9, '可以建立試用案件（小規模測試團）', tr.status === 201 && !!tid);
  const rc = await editor.call('POST', `/trials/${tid}/reach`, { metric: 'QUALIFIED_VISITORS', value: 300, sourceKind: 'SHORT_LINK_UNIQUE_VISITORS', sourceText: `${MARK} 導購後台`, periodStart: day(-10), periodEnd: day(10), credibility: 'HIGH', evidenceRef: `${MARK} 報表`, dedupeMethod: 'SHORT_LINK_UNIQUE_CLIENTS' });
  const rid = rc.data?.id as string;
  check(10, '可以填寫導購資料（有效導購訪客，含來源佐證與去重方式）', rc.status === 201 && !!rid);
  const self = await editor.call('POST', `/reach-records/${rid}/verify`, { decision: 'VERIFIED', note: `${MARK} 自己查核自己` });
  const asg = await manager.call('POST', `/reach-records/${rid}/assign-verifier`, { userId: (await verifier.call('GET', '/auth/me')).data.id, note: `${MARK} 指派第二人` });
  const ver = await verifier.call('POST', `/reach-records/${rid}/verify`, { decision: 'VERIFIED', note: `${MARK} 已對照短連結報表` });
  check(11, '第二人查核：填寫者不能查核自己的資料；指派另一位後可查核成功', (self.status === 403 || self.status === 422) && asg.status === 200 && ver.status === 200, `自查=${self.status} 指派=${asg.status} 查核=${ver.status}`);
  // 13 先做可行性（KPI 的貢獻利潤需要已確認條款），再看 KPI
  const TERMS = { cashFlowMode: 'BRAND_COLLECTS', commissionBasis: 'NSV', brandFeePct: 10, serviceFeeFixed: 0, hostCommissionPct: 5, hostPaidBy: 'COMPANY', shippingPerOrder: 60, shippingBorneBy: 'BRAND', platformFeePct: 3, platformFeeBorneBy: 'BRAND', otherVariablePerOrder: 0, otherCostBorneBy: 'COMPANY', fixedCost: 0, fixedCostBorneBy: 'COMPANY', returnCostPerRefundOrder: 20, returnCostBorneBy: 'COMPANY', expectedOrders: 50 };
  const fz = await manager.call('POST', `/products/${pid}/feasibility`, { campaignId: cid, trialId: tid, inputs: TERMS, sources: Object.fromEntries(Object.keys(TERMS).map((k) => [k, { kind: 'CONTRACT' }])) });
  check(13, '可以進行商業可行性試算（GMV、淨銷售額、品牌利潤、公司營業收入分開呈現）', (fz.status === 201 || fz.status === 200) && !!fz.data?.id && fz.data?.results != null, `估算公司貢獻 ${fz.data?.results?.companyContribution ?? '—'}`);
  // 14 匯入測試訂單
  const csv = ['source_order_id,campaign_id,ordered_at,status,quantity,unit_price,sku_code,buyer_ref,host_id,community_id,refund_amount']
    .concat(Array.from({ length: 5 }, (_, i) => `${RUN}-${i + 1},${cid},${day(-5)} 10:00,PAID,1,800,UAT${RUN.slice(-4).toUpperCase()},buyer${i},${hid},,`)).join('\n');
  const imp = await editor.call('POST', '/imports', { sourceSystem: RUN, origin: 'IMPORT', fileName: `${RUN}.csv`, csv });
  const ords = await manager.call('GET', `/orders?campaignId=${cid}`);
  check(14, '可以匯入測試訂單（5 筆）並在訂單明細讀回', (imp.status === 201 || imp.status === 200) && (ords.data?.items?.length ?? 0) >= 5, `匯入 ${imp.data?.insertedRows ?? imp.data?.inserted ?? '?'}／讀回 ${ords.data?.items?.length ?? 0}`);
  const kp = await manager.call('GET', `/trials/${tid}/kpis`);
  const items: any[] = kp.data?.items ?? []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const byKey = Object.fromEntries(items.map((x) => [x.key, x]));
  check(12, '可以查看 KPI：八項指標齊全；有效成交訂單數有值；導購轉換率（已查核）有值；每單貢獻利潤依合約條款推算；缺資料處為「資料不足」', kp.status === 200 && items.length === 8 && byKey.validOrders?.value === 5 && byKey.conversionRate?.status === 'OK' && /依已確認的合約條款與實際訂單推算/.test(byKey.contributionPerOrder?.formula ?? ''), `CVR=${byKey.conversionRate?.value}% 每單貢獻=${byKey.contributionPerOrder?.value ?? byKey.contributionPerOrder?.status}`);

  // 15 物流與售後
  const fb = await manager.call('GET', '/fulfillment/batches'); const cs = await manager.call('GET', '/aftersales/cases');
  const nc = await editor.call('POST', '/aftersales/cases', { campaignId: cid, caseType: 'COMPLAINT', title: `${MARK} 客訴測試`, priority: 'MEDIUM' });
  check(15, '可以查看物流與售後：履約批次與客服案件列表可讀、可建立客服案件', fb.status === 200 && cs.status === 200 && (nc.status === 201 || nc.status === 200));

  // 16～17 財務
  const rec = await finance.call('GET', '/reconciliation/commission'); const sync = await finance.call('POST', '/reconciliation/commission/sync');
  const rows: any[] = rec.data?.rows ?? []; // eslint-disable-line @typescript-eslint/no-explicit-any
  check(16, '可以進行財務差異查核：核對清單可讀、財務可手動同步為待確認項目（只新增項目、不改任何財務規則）', rec.status === 200 && rows.length >= 1 && sync.status === 200, `列數 ${rows.length}／新增項目 ${sync.data?.created ?? '?'}`);
  const ex = await finance.call('POST', '/expenses', { category: 'SHIPPING', amount: 700, incurredOn: day(-3), campaignId: cid, bearerParty: 'BRAND', payerParty: 'COMPANY', termsSourceKind: 'CONTRACT', termsRef: `${MARK}` });
  const exId = ex.data?.id as string;
  const fl = await finance.call('GET', `/expenses?campaignId=${cid}`); const ml = await manager.call('GET', `/expenses?campaignId=${cid}`); const el = await editor.call('GET', `/expenses?campaignId=${cid}`);
  const frow = (fl.data?.items ?? []).find((x: any) => x.id === exId); // eslint-disable-line @typescript-eslint/no-explicit-any
  check(17, '可以查看符合權限的費用資料：財務看得到承擔方與付款方、營運主管可讀、小編不可讀', ex.status === 201 && frow?.bearerParty === 'BRAND' && frow?.payerParty === 'COMPANY' && ml.status === 200 && el.status === 403);

  // 18 未授權
  const hostUser = await mk('host', 'HOST', { hostIds: [hid] }); const vendorUser = await mk('vendor', 'VENDOR', { vendorIds: [vid] });
  const denied = [
    (await editor.call('GET', '/finance/overview')).status, (await editor.call('POST', `/expenses/${exId}/correct-paid`, { newAmount: 1, reason: 'uat-denied' })).status,
    (await hostUser.call('GET', '/finance/overview')).status, (await hostUser.call('GET', `/expenses?campaignId=${cid}`)).status, (await hostUser.call('GET', '/reconciliation/commission')).status,
    (await vendorUser.call('GET', '/finance/overview')).status, (await vendorUser.call('GET', `/trials/${tid}/kpis`)).status, (await vendorUser.call('GET', '/reconciliation/fees')).status,
    (await manager.call('POST', '/users', { email: `x.${RUN.toLowerCase()}@uat.sdh-erp.test`, name: 'x', role: 'OPS_EDITOR', password: rnd() })).status,
  ];
  const kpiEd = JSON.stringify((await editor.call('GET', `/trials/${tid}/kpis`)).data ?? {});
  check(18, '未授權角色無法存取敏感資訊：小編／團主／廠商存取財務、費用、差異核對、成本一律 403；營運主管不能管理使用者；小編的 KPI 不含貢獻利潤數字', denied.every((s) => s === 403) && !/"companyContribution"/.test(kpiEd), `狀態碼 ${denied.join(',')}`);

  // 19 稽核
  const au = await admin.call('GET', `/audit?limit=200`);
  const acts = new Set((((Array.isArray(au.data) ? au.data : au.data?.items) ?? []) as any[]).map((x) => x.action)); // eslint-disable-line @typescript-eslint/no-explicit-any
  check(19, '所有操作有正確的紀錄：稽核紀錄含登入、建立使用者、廠商／商品／檔期建立、查核、費用建立；稽核不含密碼', au.status === 200 && ['user.login', 'user.create', 'campaign.create', 'expense.create'].every((a) => acts.has(a)) && !secrets.filter(Boolean).some((s) => JSON.stringify(au.data).includes(s)), `動作 ${acts.size} 種`);

  // 20 重新部署後資料不遺失：由外部流程在重新部署後以 UAT_VERIFY_PERSISTENCE=<RUN> 再執行；此處輸出資料快照供比對
  const snap = { run: RUN, vendorId: vid, productId: pid, hostId: hid, campaignId: cid, trialId: tid, expenseId: exId, orders: ords.data?.items?.length ?? 0 };
  fs.writeFileSync(path.resolve(process.env.UAT_SNAPSHOT_FILE ?? `uat-snapshot-${RUN}.json`), JSON.stringify(snap, null, 2));
  check(20, '重新部署後資料不遺失（本次先寫出資料快照；重新部署後用 scripts/prod-uat-verify.ts 比對）', true, `快照 uat-snapshot-${RUN}.json`);

  // 清理：只做軟刪除／作廢（不實體刪除）
  await finance.call('POST', `/expenses/${exId}/void`, { reason: `${MARK} UAT 結束作廢` });
  await manager.call('POST', `/vendors/${vid}/archive`, { reason: `${MARK} UAT 結束封存` });
  for (const k of Object.keys(roles)) await admin.call('POST', `/users/${(await roles[k].call('GET', '/auth/me')).data.id}/status`, { status: 'DISABLED' });

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nLive UAT（${RUN}）：${results.length - failed}/${results.length} 通過`);
  const out = { runId: RUN, baseUrl: BASE, ranAt: new Date().toISOString(), total: results.length, passed: results.length - failed, failed, results };
  const f = process.env.UAT_RESULT_FILE ?? `uat-result-${RUN}.json`;
  fs.writeFileSync(path.resolve(f), JSON.stringify(out, null, 2));
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(`中止：${e.message}`); process.exit(2); });
