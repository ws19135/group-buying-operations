const toCamel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
export const toSnake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

type Json = unknown;

/** snake_case 欄位轉 camelCase（遞迴；Date 物件原樣保留） */
export function camelize<T = Json>(v: Json): T {
  if (Array.isArray(v)) return v.map((x) => camelize(x)) as T;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, Json> = {};
    for (const [k, val] of Object.entries(v as Record<string, Json>)) out[toCamel(k)] = camelize(val);
    return out as T;
  }
  return v as T;
}
