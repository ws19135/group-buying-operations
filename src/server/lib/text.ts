/** 名稱正規化：去除空白與常見標點、全形轉半形、轉小寫，用於重複偵測 */
export function normalizeName(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　·・．.,，、:：;；!！?？'"“”‘’()（）\[\]【】「」『』\-_/\\|]+/g, '');
}

export function nonEmpty(s: string | null | undefined): string | null {
  const t = (s ?? '').trim();
  return t ? t : null;
}
