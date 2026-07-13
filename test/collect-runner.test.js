import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/index.js';
import { runCollect, buildCollectParams } from '../src/collect-runner.js';

async function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'm3-runner-'));
  const db = openDb(join(dir, 'local.db'));
  try {
    return await fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function insertSite(db, siteId, domain) {
  db.prepare(`INSERT INTO sites (site_id, domain, enabled) VALUES (?, ?, 1)`).run(siteId, domain);
  return { site_id: siteId, domain };
}

function completeResult(siteId, pageUrls) {
  return {
    siteId,
    domain: `${siteId}.com`,
    status: 'success',
    complete: true,
    truncated: false,
    truncationReasons: [],
    startedAt: '2026-07-13T00:00:00.000Z',
    finishedAt: '2026-07-13T00:00:01.000Z',
    durationMs: 1000,
    discoveredSitemaps: [`https://${siteId}.com/sitemap.xml`],
    processedSitemaps: [{ url: `https://${siteId}.com/sitemap.xml`, status: 'success', type: 'urlset' }],
    failedSitemaps: [],
    pageUrls,
    pageUrlCount: pageUrls.length,
    sitemapCount: 1,
    warnings: [],
    errors: [],
  };
}

test('buildCollectParams：domain→baseUrl，sitemap_url→手工入口', () => {
  assert.deepEqual(buildCollectParams({ site_id: 'x', domain: 'x.com' }, undefined), {
    siteId: 'x',
    domain: 'x.com',
    limits: undefined,
    baseUrl: 'https://x.com',
  });
  const withManual = buildCollectParams({ site_id: 'y', domain: 'y.com', sitemap_url: 'https://y.com/s.xml' });
  assert.equal(withManual.manualSitemapUrl, 'https://y.com/s.xml');
});

test('两轮 baseline→added：第一轮全部 baseline（added=0），第二轮发现新增', async () => {
  await withTempDb(async (db) => {
    const site = insertSite(db, 'poki', 'poki.com');
    const A = 'https://poki.com/g/a';
    const B = 'https://poki.com/g/b';
    const C = 'https://poki.com/g/c';

    // 第一轮：baseline
    const r1 = await runCollect(db, {
      sites: [site],
      runId: 'run-1',
      collectSiteFn: async () => completeResult('poki', [A, B]),
    });
    assert.equal(r1.stats.sitesSuccess, 1);
    assert.equal(r1.stats.baselineSiteCount, 1);
    assert.equal(r1.stats.baselineUrlCount, 2);
    assert.equal(r1.stats.addedUrlCount, 0, '首轮 baseline 不产生新增');

    // 第二轮：多一个 C
    const r2 = await runCollect(db, {
      sites: [site],
      runId: 'run-2',
      collectSiteFn: async () => completeResult('poki', [A, B, C]),
    });
    assert.equal(r2.stats.baselineSiteCount, 0, '第二轮不再是 baseline');
    assert.equal(r2.stats.addedUrlCount, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seen_urls').get().n, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM added_urls').get().n, 1);
  });
});

test('第二轮相同数据无虚假新增（幂等）', async () => {
  await withTempDb(async (db) => {
    const site = insertSite(db, 'poki', 'poki.com');
    const urls = ['https://poki.com/g/a', 'https://poki.com/g/b'];
    await runCollect(db, { sites: [site], runId: 'run-1', collectSiteFn: async () => completeResult('poki', urls) });
    const r2 = await runCollect(db, { sites: [site], runId: 'run-2', collectSiteFn: async () => completeResult('poki', urls) });
    assert.equal(r2.stats.addedUrlCount, 0, '相同数据第二轮不能有新增');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM added_urls').get().n, 0);
  });
});

test('准入：partial 结果不写历史，只记录 site_crawl_runs 为 partial', async () => {
  await withTempDb(async (db) => {
    const site = insertSite(db, 'poki', 'poki.com');
    const r = await runCollect(db, {
      sites: [site],
      runId: 'run-1',
      collectSiteFn: async () => ({
        ...completeResult('poki', ['https://poki.com/g/a']),
        status: 'partial',
        complete: false,
      }),
    });
    assert.equal(r.stats.sitesPartial, 1);
    assert.equal(r.stats.sitesSuccess, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seen_urls').get().n, 0, 'partial 不写 seen_urls');
    const scr = db.prepare('SELECT status FROM site_crawl_runs WHERE site_id = ?').get('poki');
    assert.equal(scr.status, 'partial');
  });
});

test('单站失败不影响其他站：一个采集抛错，其他站正常建立 baseline', async () => {
  await withTempDb(async (db) => {
    const good = insertSite(db, 'good', 'good.com');
    const bad = insertSite(db, 'bad', 'bad.com');
    const good2 = insertSite(db, 'good2', 'good2.com');

    const r = await runCollect(db, {
      sites: [good, bad, good2],
      runId: 'run-1',
      collectSiteFn: async (params) => {
        if (params.siteId === 'bad') throw new Error('模拟采集崩溃');
        return completeResult(params.siteId, [`https://${params.siteId}.com/g/a`]);
      },
    });

    assert.equal(r.stats.sitesSuccess, 2, '两个正常站点应成功');
    assert.equal(r.stats.sitesFailed, 1, '崩溃的站点记为失败');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seen_urls').get().n, 2);
    // 失败站点记录了运行诊断，但没有 seen_urls
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seen_urls WHERE site_id = ?').get('bad').n, 0);
    const badRow = db.prepare('SELECT last_status FROM sites WHERE site_id = ?').get('bad');
    assert.equal(badRow.last_status, 'failed');
  });
});

test('crawl_runs 汇总：sites_total/success/partial/failed 与 baseline 统计正确', async () => {
  await withTempDb(async (db) => {
    const s1 = insertSite(db, 's1', 's1.com');
    const s2 = insertSite(db, 's2', 's2.com');
    const r = await runCollect(db, {
      sites: [s1, s2],
      runId: 'run-1',
      collectSiteFn: async (p) =>
        p.siteId === 's1'
          ? completeResult('s1', ['https://s1.com/g/a'])
          : { ...completeResult('s2', []), status: 'failed', complete: false, pageUrlCount: 0 },
    });
    const row = db.prepare('SELECT * FROM crawl_runs WHERE run_id = ?').get('run-1');
    assert.equal(row.sites_total, 2);
    assert.equal(row.sites_success, 1);
    assert.equal(row.sites_failed, 1);
    assert.equal(row.baseline_site_count, 1);
    assert.equal(row.status, 'partial');
    assert.ok(row.finished_at);
  });
});
