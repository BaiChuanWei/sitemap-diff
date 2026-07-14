import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/index.js';
import { getOverview, listSites, listRuns, getRunDetail } from '../../src/dashboard/routes/overview.js';

function withTempDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dashboard-overview-'));
    const db = openDb(join(dir, 'test.db'));
    try {
      await fn(db, { dbPath: join(dir, 'test.db'), outputDir: dir });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('空数据库：总览接口返回全 0 状态，不抛错', withTempDb(async (db, config) => {
  const overview = getOverview(db, config);
  assert.equal(overview.siteCount, 0);
  assert.equal(overview.enabledCount, 0);
  assert.equal(overview.baselineCount, 0);
  assert.equal(overview.seenUrlCount, 0);
  assert.equal(overview.addedUrlCount, 0);
  assert.equal(overview.lastRun, null);
  assert.equal(overview.staleRunningRun, null);
}));

test('有历史数据：总览统计与直接查库结果一致', withTempDb(async (db, config) => {
  db.prepare(`INSERT INTO sites (site_id, domain, enabled, baseline_completed_at) VALUES ('a','a.com',1,'2026-01-01T00:00:00Z')`).run();
  db.prepare(`INSERT INTO sites (site_id, domain, enabled) VALUES ('b','b.com',0)`).run();
  db.prepare(`INSERT INTO seen_urls (site_id, original_url, normalized_url, url_hash, first_run_id, last_run_id) VALUES ('a','https://a.com/g/1','https://a.com/g/1','h1','r1','r1')`).run();
  db.prepare(`INSERT INTO crawl_runs (run_id, started_at, finished_at, status, sites_total, sites_success, sites_partial, sites_failed, added_url_count) VALUES ('r1','2026-01-01T00:00:00Z','2026-01-01T00:01:00Z','success',2,1,0,1,0)`).run();

  const overview = getOverview(db, config);
  assert.equal(overview.siteCount, 2);
  assert.equal(overview.enabledCount, 1);
  assert.equal(overview.baselineCount, 1);
  assert.equal(overview.seenUrlCount, 1);
  assert.equal(overview.lastRun.run_id, 'r1');
}));

test('staleRunningRun：检测到未正常结束（status=running）的运行记录', withTempDb(async (db, config) => {
  db.prepare(`INSERT INTO crawl_runs (run_id, started_at, status, sites_total) VALUES ('r-stuck','2026-01-01T00:00:00Z','running',5)`).run();
  const overview = getOverview(db, config);
  assert.equal(overview.staleRunningRun.run_id, 'r-stuck');
}));

test('listSites：返回字段与 sites 表状态一致', withTempDb(async (db) => {
  db.prepare(`INSERT INTO sites (site_id, domain, enabled, last_status, last_error) VALUES ('x','x.com',1,'failed','HTTP 403')`).run();
  const sites = listSites(db);
  assert.equal(sites.length, 1);
  assert.equal(sites[0].site_id, 'x');
  assert.equal(sites[0].last_status, 'failed');
  assert.equal(sites[0].last_error, 'HTTP 403');
}));

test('listRuns：按开始时间倒序返回', withTempDb(async (db) => {
  db.prepare(`INSERT INTO crawl_runs (run_id, started_at, status) VALUES ('r1','2026-01-01T00:00:00Z','success')`).run();
  db.prepare(`INSERT INTO crawl_runs (run_id, started_at, status) VALUES ('r2','2026-01-02T00:00:00Z','success')`).run();
  const runs = listRuns(db);
  assert.deepEqual(runs.map((r) => r.run_id), ['r2', 'r1']);
}));

test('getRunDetail：找不到的 run_id 返回 null；存在时返回逐站结果', withTempDb(async (db) => {
  assert.equal(getRunDetail(db, 'no-such-run'), null);

  db.prepare(`INSERT INTO crawl_runs (run_id, started_at, status) VALUES ('r1','2026-01-01T00:00:00Z','success')`).run();
  db.prepare(`INSERT INTO site_crawl_runs (run_id, site_id, status, complete, truncated, page_url_count, added_url_count) VALUES ('r1','a','success',1,0,10,2)`).run();
  db.prepare(`INSERT INTO added_urls (run_id, site_id, original_url, normalized_url, url_hash) VALUES ('r1','a','https://a.com/g/new','https://a.com/g/new','h-new')`).run();

  const detail = getRunDetail(db, 'r1');
  assert.equal(detail.run.run_id, 'r1');
  assert.equal(detail.sites.length, 1);
  assert.equal(detail.sites[0].site_id, 'a');
  assert.equal(detail.addedSample.length, 1);
}));

test('服务重启恢复：新 DB 连接立刻能看到既有历史数据，不依赖进程内存态', withTempDb(async (db, config) => {
  db.prepare(`INSERT INTO sites (site_id, domain, enabled) VALUES ('a','a.com',1)`).run();
  db.prepare(`INSERT INTO crawl_runs (run_id, started_at, status, sites_total) VALUES ('r1','2026-01-01T00:00:00Z','success',1)`).run();
  db.close();

  // 模拟"服务重启"：重新 openDb 同一个文件，不共享任何进程内存状态。
  const reopened = openDb(config.dbPath);
  try {
    const overview = getOverview(reopened, config);
    assert.equal(overview.siteCount, 1);
    assert.equal(overview.lastRun.run_id, 'r1');
  } finally {
    reopened.close();
  }
}));
