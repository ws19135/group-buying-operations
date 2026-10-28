export type AppEnv = 'development' | 'test' | 'production';

export function appEnv(): AppEnv {
  const v = process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development';
  if (v === 'production' || v === 'test') return v;
  return 'development';
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL 未設定（請參考 .env.example）');
  return url;
}

export function sessionSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    if (appEnv() === 'production') throw new Error('production 必須設定至少 32 字元的 SESSION_SECRET');
    return 'dev-only-insecure-secret-do-not-use-in-production';
  }
  return s;
}

export function automationEnabled(): boolean {
  return (process.env.AUTOMATION_ENABLED ?? 'off').toLowerCase() === 'on';
}

export const SESSION_COOKIE = 'erp_session';
export const SESSION_TTL_HOURS = 12;
export const ORG_TZ = 'Asia/Taipei';
