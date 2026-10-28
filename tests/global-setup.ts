// 每次測試前重建測試資料庫 schema（僅限 TEST_DATABASE_URL 指向的資料庫）
export default async function setup() {
  process.env.APP_ENV = 'test';
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://erp:erp_dev_pw@127.0.0.1:5432/erp_test';
  if (!/test/i.test(new URL(process.env.DATABASE_URL).pathname)) {
    throw new Error('拒絕執行：測試資料庫名稱必須包含 "test"，避免清空開發／正式資料庫');
  }
  const { resetDatabase } = await import('../src/server/lib/migrate');
  const { closePool } = await import('../src/server/lib/db');
  await resetDatabase();
  await closePool();
}
