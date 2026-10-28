'use client';
import { ApiForm } from '@/ui/ApiForm';

interface Opt { value: string; label: string }

/** 加入商品：value = productId|skuId */
export function AddProductForm({ campaignId, options }: { campaignId: string; options: Opt[] }) {
  return <ApiFormSplit endpoint={`/api/campaigns/${campaignId}/products`} options={options} />;
}

function ApiFormSplit({ endpoint, options }: { endpoint: string; options: Opt[] }) {
  return (
    <form data-testid="add-product-form" onSubmit={async (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      const [productId, skuId] = String(fd.get('pick') ?? '').split('|');
      const price = String(fd.get('campaignPrice') ?? '').trim();
      const { callApi } = await import('@/ui/api');
      const r = await callApi(endpoint, 'POST', { productId, ...(skuId ? { skuId } : {}), ...(price ? { campaignPrice: Number(price) } : {}) });
      const msg = e.currentTarget.querySelector('[data-msg]') as HTMLElement | null;
      if (!r.ok) { if (msg) { msg.textContent = r.error?.message ?? '失敗'; msg.style.display = 'block'; } return; }
      location.reload();
    }}>
      <div data-msg className="banner error" style={{ display: 'none' }} role="alert" />
      <label className="field"><span className="lbl">商品／規格<span className="req"> *</span></span>
        <select name="pick" required data-testid="field-pick"><option value="">請選擇</option>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
      <label className="field"><span className="lbl">檔期價（選填）</span><input type="number" min={0} name="campaignPrice" data-testid="field-campaignPrice" /></label>
      <button className="btn primary" type="submit" data-testid="add-product-submit">加入</button>
    </form>
  );
}

export function AddPlacementForm({ campaignId, options, minDate, maxDate }: { campaignId: string; options: Opt[]; minDate: string | null; maxDate: string | null }) {
  return (
    <form data-testid="add-placement-form" onSubmit={async (e) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      const [hostId, communityId] = String(fd.get('pick') ?? '').split('|');
      const body: Record<string, unknown> = { hostId, communityId, placementType: fd.get('placementType'), scheduledOn: fd.get('scheduledOn') };
      for (const k of ['scheduledTime', 'contentRef', 'note']) { const v = String(fd.get(k) ?? '').trim(); if (v) body[k] = v; }
      const { callApi } = await import('@/ui/api');
      const r = await callApi(`/api/campaigns/${campaignId}/placements`, 'POST', body);
      const msg = e.currentTarget.querySelector('[data-msg]') as HTMLElement | null;
      if (!r.ok) { if (msg) { msg.textContent = r.error?.message ?? '失敗'; msg.style.display = 'block'; } return; }
      location.reload();
    }}>
      <div data-msg className="banner error" style={{ display: 'none' }} role="alert" />
      <label className="field"><span className="lbl">團主／社群<span className="req"> *</span></span>
        <select name="pick" required data-testid="field-pick"><option value="">請選擇</option>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
      <div className="form-grid">
        <label className="field"><span className="lbl">形式<span className="req"> *</span></span>
          <select name="placementType" required data-testid="field-placementType">{[['LAUNCH', '開團公告'], ['POST', '貼文'], ['STORY', '限動'], ['LIVE_TALK', 'Live Talk'], ['TOPIC', '話題'], ['REMINDER', '催單']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="field"><span className="lbl">日期<span className="req"> *</span></span><input type="date" name="scheduledOn" required min={minDate ?? undefined} max={maxDate ?? undefined} data-testid="field-scheduledOn" /><span className="help">需落在檔期區間內</span></label>
        <label className="field"><span className="lbl">時間（HH:MM）</span><input type="time" name="scheduledTime" /></label>
        <label className="field"><span className="lbl">內容連結／編號</span><input name="contentRef" /></label>
      </div>
      <label className="field"><span className="lbl">備註</span><input name="note" /></label>
      <button className="btn primary" type="submit" data-testid="add-placement-submit">新增曝光安排</button>
    </form>
  );
}

export { ApiForm };
