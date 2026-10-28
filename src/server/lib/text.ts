/** 名稱正規化：去除空白與常見標點、全形轉半形、轉小寫，用於重複偵測 */
export function normalizeName(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000\u00b7\u30fb\uff0e.,\uff0c\u3001:\uff1a;\uff1b!\uff01?\uff1f'"\u201c\u201d\u2018\u2019()\uff08\uff09[\]\u3010\u3011\u300c\u300d\u300e\u300f\-_/\\|]+/g, '');
}

export function nonEmpty(s: string | null | undefined): string | null {
  const t = (s ?? '').trim();
  return t ? t : null;
}

/** 使用者輸入的連結只接受 http(s)，避免 javascript:／data: 等 scheme 被存入後在介面上變成可執行連結 */
export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
