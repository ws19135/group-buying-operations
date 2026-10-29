export interface ApiResult<T = unknown> { ok: boolean; status: number; data?: T; error?: { code: string; message: string; details?: unknown; requestId?: string } }

export async function callApi<T = unknown>(url: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' = 'GET', body?: unknown, idemKey?: string): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(idemKey ? { 'idempotency-key': idemKey } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, status: res.status, data: json.data as T };
    return { ok: false, status: res.status, error: json.error ?? { code: 'UNKNOWN', message: `請求失敗（${res.status}）` } };
  } catch {
    return { ok: false, status: 0, error: { code: 'NETWORK', message: '無法連線到伺服器，請檢查網路後再試' } };
  }
}
