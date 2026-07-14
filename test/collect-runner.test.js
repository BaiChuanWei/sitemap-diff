import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/index.js';
import { runCollect, buildCollectParams } from '../src/collect-runner.js';
import { parseSiteLimitOverrides, parseSiteSitemapOverrides } from '../src/site-overrides.js';
import { DEFAULT_LIMITS } from '../src/sitemap/limits.js';

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

test('准入：status=success 但 pageUrlCount=0（零价值成功）不得计入 sites_failed，需与 site_crawl_runs.status 一致', async () => {
  // 复现 50 站阶段发现的真实 bug：html5games.com 这类站点技术上抓取成功
  // （status=success/complete=true/truncated=false），但 Sitemap 内容是
  // 空模板，pageUrlCount=0，因此 isAdmissible() 判定不可准入。此前
  // collect-runner.js 的聚合计数只区分 status==='partial' 和"其余全部计
  // 入 failed"，导致这种 status=success 的站点被错误地计入了
  // crawl_runs.sites_failed，而 site_crawl_runs.status 里存的却仍然是
  // 'success'——造成汇总统计和逐站表相互矛盾（50 站阶段第二轮
  // sites_failed=13 但 site_crawl_runs 里实际只有 12 条 status=failed）。
  await withTempDb(async (db) => {
    const site = insertSite(db, 'zerovalue', 'zerovalue.com');
    const r = await runCollect(db, {
      sites: [site],
      runId: 'run-1',
      collectSiteFn: async () => completeResult('zerovalue', []), // pageUrlCount=0，但 status 仍是 success
    });
    assert.equal(r.stats.sitesSuccess, 0, '零 URL 不应准入为 success');
    assert.equal(r.stats.sitesFailed, 0, 'status=success 的站点不应计入 sites_failed');
    assert.equal(r.stats.sitesPartial, 1, '未准入但 status!=failed 的站点应计入 sites_partial');
    const scr = db.prepare('SELECT status FROM site_crawl_runs WHERE site_id = ?').get('zerovalue');
    assert.equal(scr.status, 'success', 'site_crawl_runs 应如实记录采集器返回的技术状态');
    const row = db.prepare('SELECT * FROM crawl_runs WHERE run_id = ?').get('run-1');
    assert.equal(row.sites_failed, 0);
    assert.equal(row.sites_partial, 1);
  });
});

test('Milestone 5A-P1：站点级限制覆盖只影响该站，collectSiteFn 收到的 limits 各自独立', async () => {
  await withTempDb(async (db) => {
    const a = insertSite(db, 'kongregate', 'kongregate.com');
    const b = insertSite(db, 'poki', 'poki.com');
    const siteLimitOverrides = parseSiteLimitOverrides([{ site_id: 'kongregate', max_download_bytes: '52428800' }]);

    const receivedLimits = {};
    await runCollect(db, {
      sites: [a, b],
      runId: 'run-1',
      siteLimitOverrides,
      collectSiteFn: async (params) => {
        receivedLimits[params.siteId] = params.limits;
        return completeResult(params.siteId, [`https://${params.siteId}.com/g/a`]);
      },
    });

    assert.equal(receivedLimits.kongregate.MAX_DOWNLOAD_BYTES, 52428800);
    assert.equal(receivedLimits.poki.MAX_DOWNLOAD_BYTES, DEFAULT_LIMITS.MAX_DOWNLOAD_BYTES, '未覆盖的站点必须保持默认值');
  });
});

test('Milestone 5A-P1：手工 Sitemap 配置（manual_only）正确传给 collectSiteFn', async () => {
  await withTempDb(async (db) => {
    const site = insertSite(db, 'lagged', 'lagged.com');
    const siteSitemapOverrides = parseSiteSitemapOverrides([
      { site_id: 'lagged', sitemap_url: 'https://lagged.com/sitemap.xml', enabled: 'true', mode: 'manual_only', notes: '', verified_at: '' },
    ]);

    let receivedParams;
    await runCollect(db, {
      sites: [site],
      runId: 'run-1',
      siteSitemapOverrides,
      collectSiteFn: async (params) => {
        receivedParams = params;
        return completeResult('lagged', ['https://lagged.com/g/a']);
      },
    });

    assert.deepEqual(receivedParams.manualSitemaps, ['https://lagged.com/sitemap.xml']);
    assert.equal(receivedParams.discoveryMode, 'manual_only');
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

// ---- Dashboard M3：onEvent / shouldCancel ----

test('Dashboard M3：onEvent 按顺序发出 site_started/sitemap_discovered/site_finished，字段完整', async () => {
  await withTempDb(async (db) => {
    const s1 = insertSite(db, 's1', 's1.com');
    const s2 = insertSite(db, 's2', 's2.com');
    const events = [];
    const result = await runCollect(db, {
      sites: [s1, s2],
      runId: 'run-evt',
      collectSiteFn: async (p) => completeResult(p.siteId, [`https://${p.siteId}.com/g/a`]),
      onEvent: (type, payload) => events.push({ type, payload }),
    });
    assert.equal(result.cancelled, false);

    const types = events.map((e) => e.type);
    assert.deepEqual(types, [
      'site_started', 'sitemap_discovered', 'site_finished',
      'site_started', 'sitemap_discovered', 'site_finished',
    ]);

    const firstStarted = events[0];
    assert.equal(firstStarted.payload.runId, 'run-evt');
    assert.equal(firstStarted.payload.siteId, 's1');
    assert.equal(firstStarted.payload.domain, 's1.com');
    assert.equal(firstStarted.payload.index, 1);
    assert.equal(firstStarted.payload.total, 2);
    assert.ok(firstStarted.payload.startedAt);

    const firstFinished = events[2];
    assert.equal(firstFinished.payload.siteId, 's1');
    assert.equal(firstFinished.payload.status, 'success');
    assert.equal(firstFinished.payload.complete, true);
    assert.equal(firstFinished.payload.truncated, false);
    assert.equal(firstFinished.payload.pageUrlCount, 1);
    assert.equal(firstFinished.payload.addedUrlCount, 0); // 首次 baseline，added 恒为 0
    assert.equal(firstFinished.payload.isBaseline, true);
    assert.equal(typeof firstFinished.payload.durationMs, 'number');
    assert.equal(firstFinished.payload.errorCode, null);
  });
});

test('Dashboard M3：失败站点也会发出 site_finished（带 errorCode/errorSummary）', async () => {
  await withTempDb(async (db) => {
    const s1 = insertSite(db, 's1', 's1.com');
    const events = [];
    await runCollect(db, {
      sites: [s1],
      runId: 'run-evt-fail',
      collectSiteFn: async () => { throw new Error('网络超时'); },
      onEvent: (type, payload) => events.push({ type, payload }),
    });
    const finished = events.find((e) => e.type === 'site_finished');
    assert.equal(finished.payload.status, 'failed');
    assert.equal(finished.payload.errorCode, 'COLLECT_THREW');
    assert.match(finished.payload.errorSummary, /网络超时/);
  });
});

test('Dashboard M3：onEvent 回调本身抛错不影响正式采集结果', async () => {
  await withTempDb(async (db) => {
    const s1 = insertSite(db, 's1', 's1.com');
    const result = await runCollect(db, {
      sites: [s1],
      runId: 'run-evt-throw',
      collectSiteFn: async (p) => completeResult(p.siteId, ['https://s1.com/g/a']),
      onEvent: () => { throw new Error('前端已断开，事件发送失败'); },
    });
    assert.equal(result.status, 'success');
    assert.equal(result.stats.sitesSuccess, 1);
    const row = db.prepare('SELECT * FROM crawl_runs WHERE run_id = ?').get('run-evt-throw');
    assert.equal(row.status, 'success');
  });
});

test('Dashboard M3：shouldCancel 在下一站开始前生效——当前站正常跑完并写入历史，后续站不再调度', async () => {
  await withTempDb(async (db) => {
    const s1 = insertSite(db, 's1', 's1.com');
    const s2 = insertSite(db, 's2', 's2.com');
    const s3 = insertSite(db, 's3', 's3.com');
    let started = 0;
    const result = await runCollect(db, {
      sites: [s1, s2, s3],
      runId: 'run-cancel',
      collectSiteFn: async (p) => {
        started++;
        return completeResult(p.siteId, [`https://${p.siteId}.com/g/a`]);
      },
      shouldCancel: () => started >= 1, // 第一站跑完后才允许取消检查生效
    });
    assert.equal(started, 1, '只应该开始了第一个站点的采集，其余站点不应该被调度');
    assert.equal(result.cancelled, true);
    assert.equal(result.status, 'cancelled');
    assert.equal(result.stats.sitesSuccess, 1);

    // 已经完成的第一站历史正常写入，不因为取消而丢失。
    const s1Row = db.prepare('SELECT * FROM seen_urls WHERE site_id = ?').get('s1');
    assert.ok(s1Row);
    const s2Row = db.prepare('SELECT * FROM site_crawl_runs WHERE run_id = ? AND site_id = ?').get('run-cancel', 's2');
    assert.equal(s2Row, undefined, '未开始的站点不应该有任何运行记录');

    const runRow = db.prepare('SELECT * FROM crawl_runs WHERE run_id = ?').get('run-cancel');
    assert.equal(runRow.status, 'cancelled');
    assert.equal(runRow.sites_success, 1);
  });
});

test('Dashboard M3：不传 shouldCancel 时行为不变（永远不取消）', async () => {
  await withTempDb(async (db) => {
    const s1 = insertSite(db, 's1', 's1.com');
    const s2 = insertSite(db, 's2', 's2.com');
    const result = await runCollect(db, {
      sites: [s1, s2],
      runId: 'run-no-cancel',
      collectSiteFn: async (p) => completeResult(p.siteId, [`https://${p.siteId}.com/g/a`]),
    });
    assert.equal(result.cancelled, false);
    assert.equal(result.stats.sitesSuccess, 2);
  });
});
