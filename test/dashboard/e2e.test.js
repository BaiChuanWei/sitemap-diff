import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalConfig } from '../../src/config.js';
import { createDashboardServer } from '../../src/dashboard/server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');

function withSeededDashboard(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-e2e-'));
    const config = loadLocalConfig({ dbPath: join(dir, 'test.db'), outputDir: join(dir, 'output') });
    const port = 28711 + Math.floor(Math.random() * 500);
    const dashboard = createDashboardServer({ config, port });
    try {
      dashboard.db.prepare(`INSERT INTO sites (site_id, domain, enabled, last_status, baseline_completed_at) VALUES ('poki','poki.com',1,'success','2026-01-01T00:00:00Z')`).run();
      dashboard.db.prepare(`INSERT INTO crawl_runs (run_id, started_at, finished_at, status, sites_total, sites_success, sites_partial, sites_failed, added_url_count) VALUES ('r1','2026-01-01T00:00:00Z','2026-01-01T00:01:00Z','success',1,1,0,0,3)`).run();
      dashboard.db.prepare(`INSERT INTO site_crawl_runs (run_id, site_id, status, complete, truncated, page_url_count, added_url_count) VALUES ('r1','poki','success',1,0,100,3)`).run();
      await dashboard.listen();
      await fn({ dashboard, port });
    } finally {
      await dashboard.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('端到端（轻量）：首页 HTML 能加载，且能通过接口拿到已写入的种子数据', withSeededDashboard(async ({ port }) => {
  const headers = { host: `127.0.0.1:${port}` };

  const indexRes = await fetch(`http://127.0.0.1:${port}/`, { headers });
  assert.equal(indexRes.status, 200);
  const html = await indexRes.text();
  assert.match(html, /<script src="\/app\.js">/);

  const overviewRes = await fetch(`http://127.0.0.1:${port}/api/overview`, { headers });
  const overview = await overviewRes.json();
  assert.equal(overview.siteCount, 1);
  assert.equal(overview.baselineCount, 1);
  assert.equal(overview.lastRun.run_id, 'r1');

  const sitesRes = await fetch(`http://127.0.0.1:${port}/api/sites`, { headers });
  const { sites } = await sitesRes.json();
  assert.equal(sites.length, 1);
  assert.equal(sites[0].site_id, 'poki');

  const runsRes = await fetch(`http://127.0.0.1:${port}/api/runs`, { headers });
  const { runs } = await runsRes.json();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].added_url_count, 3);

  const runDetailRes = await fetch(`http://127.0.0.1:${port}/api/runs/r1`, { headers });
  const detail = await runDetailRes.json();
  assert.equal(detail.sites[0].site_id, 'poki');
}));

test('前端脚本不使用 innerHTML 拼接服务端数据（XSS 防护的静态检查）', () => {
  const appJs = readFileSync(join(projectRoot, 'public', 'dashboard', 'app.js'), 'utf-8');
  assert.doesNotMatch(appJs, /\.innerHTML\s*=/, 'app.js 不应该用 innerHTML 赋值渲染任何数据');
});
