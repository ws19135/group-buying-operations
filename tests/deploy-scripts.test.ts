import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

/** 部署相關檔案的結構性守衛（不連資料庫、不需要 Docker）：
 *  這些性質一旦被改壞，部署會變得不安全——例如沒備份就套用 migration、對外開放資料庫埠、UAT 能打到正式環境。 */
const read = (p: string) => fs.readFileSync(p, 'utf8');

describe('deploy-remote.sh', () => {
  const s = read('deploy/deploy-remote.sh');
  const at = (needle: string) => { const i = s.indexOf(needle); expect(i, `找不到：${needle}`).toBeGreaterThan(-1); return i; };

  it('順序：確認已初次建置 → 部署前備份 → migration → 啟動 app／proxy → 就緒檢查', () => {
    const order = [at('db_is_bootstrapped ||'), at('do_backup pre-deploy'), at('npm run db:migrate'), at('up -d app proxy'), at('/api/ready')];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it('資料庫尚未初次建置就拒絕，且不自己執行 prod:bootstrap（初次建置必須由人刻意執行）', () => {
    expect(s).toMatch(/db_is_bootstrapped \|\| fail/);
    expect(s).not.toMatch(/npm run prod:bootstrap/);
  });
  it('使用 set -euo pipefail，備份失敗會中止部署', () => {
    expect(s).toMatch(/set -euo pipefail/);
    expect(read('deploy/host-common.sh')).toMatch(/set -euo pipefail/);
  });
});

describe('host-common.sh', () => {
  const s = read('deploy/host-common.sh');
  it('.env.production 權限不是 600／400 就拒絕', () => { expect(s).toMatch(/600\|400\) ;;/); expect(s).toMatch(/必須是 600/); });
  it('備份檔以 umask 077 建立、寫入 SHA-256、並用 pg_restore --list 驗證', () => {
    expect(s).toMatch(/umask 077/); expect(s).toMatch(/sha256sum "\$\(basename/); expect(s).toMatch(/exec -T db pg_restore --list < "\$file"[^\n]*\|\| \{ fail/);
  });
});

describe('docker-compose.prod.yml', () => {
  const s = read('docker-compose.prod.yml');
  const services = s.slice(s.indexOf('\nservices:'), s.indexOf('\nnetworks:'));
  const blocks = services.split(/\n {2}(?=[a-z]+:\n)/).slice(1);
  const byName = Object.fromEntries(blocks.map((b) => [b.slice(0, b.indexOf(':')), b]));
  it('只有 proxy 對外開放連接埠；資料庫與 app 不得有 ports', () => {
    expect(Object.keys(byName).sort()).toEqual(['app', 'db', 'proxy']);
    expect(byName.db).not.toMatch(/\n\s+ports:/); expect(byName.app).not.toMatch(/\n\s+ports:/);
    expect(byName.proxy).toMatch(/"80:80"/); expect(byName.proxy).toMatch(/"443:443"/);
  });
  it('正式環境固定關閉自動化、通知只用測試 Adapter、不帶任何 DEMO 設定', () => {
    expect(byName.app).toMatch(/AUTOMATION_ENABLED: "off"/); expect(byName.app).toMatch(/NOTIFY_ADAPTER: test/);
    expect(s).not.toMatch(/ALLOW_DEMO_IN_PRODUCTION|DEMO_PASSWORD/);
  });
  it('資料庫在 internal 網路（不連外）', () => { expect(s).toMatch(/internal: \{ internal: true \}/); expect(byName.db).toMatch(/networks: \[internal\]/); });
});

describe('GitHub workflows', () => {
  it('UAT 工作流程固定在 staging、需要 https、需要人工確認空資料庫', () => {
    const s = read('.github/workflows/uat-staging.yml');
    expect(s).toMatch(/environment: staging\b/); expect(s).not.toMatch(/environment:.*production/);
    expect(s).toMatch(/confirm_empty_staging/); expect(s).toMatch(/https:\/\/\*/);
    expect(s).toMatch(/workflow_dispatch/); expect(s).not.toMatch(/\n {2}(push|pull_request):/);
  });
  it('部署工作流程：手動觸發、target 為 staging／production、環境綁定 target、先確認 CI 綠燈', () => {
    const s = read('.github/workflows/deploy-production.yml');
    expect(s).toMatch(/workflow_dispatch/); expect(s).toMatch(/options: \[staging, production\]/);
    expect(s).toMatch(/environment: \$\{\{ inputs\.target \}\}/); expect(s).toMatch(/CI must be green/);
    expect(s).not.toMatch(/\n {2}(push|pull_request|schedule):/);
  });
  it('部署與 UAT 工作流程沒有寫死任何密鑰、主機或網址', () => {
    for (const f of ['.github/workflows/deploy-production.yml', '.github/workflows/uat-staging.yml']) {
      const s = read(f);
      expect(s).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/); expect(s).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
      expect(s).not.toMatch(/https:\/\/(?!\$\{\{)[a-z0-9.-]+\.(com|tw|net|io|app)\b/);
    }
  });
});
