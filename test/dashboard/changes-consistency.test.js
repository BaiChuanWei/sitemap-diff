import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalConfig } from '../../src/config.js';
import { createAndListenDashboard } from './helpers/listen-with-retry.js';
import { readZipEntries } from '../helpers/zip-reader.js';

/**
 * Dashboard M4：DB / API / 报告三层的 missing/consecutive_missing/restored
 * 计数必须一致——这是本里程碑"用户能不能信任面板上看到的数字"的核心保证，
 * 不重复测试 M3 已经覆盖的安全/分页/SSE 场景。
 */

const SITES_HEADER = 'site_id,domain,priority,enabled,robots_url,sitemap_url,expected_game_path,notes,site_category';

function completeResult(pageUrls) {
  return {
    siteId: 'poki',
    domain: 'poki.com',
    status: 'success',
    complete: true,
    truncated: false,
    truncationReasons: [],
    startedAt: '2026-07-14T00:00:00.000Z',
    finishedAt: '2026-07-14T00:00:01.000Z',
    durationMs: 5,
    discoveredSitemaps: ['https://poki.com/sitemap.xml'],
    processedSitemaps: [{ url: 'https://poki.com/sitemap.xml', status: 'success', type: 'urlset' }],
    failedSitemaps: [],
    pageUrls,
    pageUrlCount: pageUrls.length,
    sitemapCount: 1,
    warnings: [],
    errors: [],
  };
}

function jsonHeaders(port, token) {
  return { host: `127.0.0.1:${port}`, 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, 'x-dashboard-token': token };
}

async function postJson(port, token, path, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: jsonHeaders(port, token), body: JSON.stringify(body || {}) });
}

async function getJson(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { host: `127.0.0.1:${port}` } });
  return { status: res.status, body: await res.json() };
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor 超时');
}

test('DB / API / 报告三层的 missing 计数必须一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm4-consistency-'));
  const config = loadLocalConfig({
    dbPath: join(dir, 'test.db'),
    sitesCsvPath: join(dir, 'sites.csv'),
    siteLimitsCsvPath: join(dir, 'site-limits.csv'),
    siteSitemapsCsvPath: join(dir, 'site-sitemaps.csv'),
    outputDir: join(dir, 'output'),
    lockPath: join(dir, 'collector.lock'),
  });
  writeFileSync(config.sitesCsvPath, `${SITES_HEADER}\npoki,poki.com,high,true,,,,,\n`, 'utf-8');

  // 第一轮返回 [A,B,C]（baseline），第二轮返回 [A,B]（C 缺失）——用一个可变
  // 的闭包变量在两次 POST /api/runs 之间切换返回值，不需要真的发网络请求。
  let round = 1;
  const collectSiteFn = async () => {
    if (round === 1) return completeResult(['https://poki.com/g/a', 'https://poki.com/g/b', 'https://poki.com/g/c']);
    return completeResult(['https://poki.com/g/a', 'https://poki.com/g/b']);
  };

  const { dashboard, port } = await createAndListenDashboard({
    config,
    logDir: join(dir, 'logs'),
    collectSiteFn,
    classifyFetchPagesFn: async () => new Map(),
  });

  try {
    const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { host: `127.0.0.1:${port}` } });
    const token = (await healthRes.json()).data.sessionToken;

    // 第一轮：baseline，跑完确认没有任何变化事件。
    const run1 = await postJson(port, token, '/api/runs', { mode: 'selected', siteIds: ['poki'] });
    const { runId: runId1 } = (await run1.json()).data;
    await waitFor(async () => (await getJson(port, '/api/runs/active')).body.data.active === null);

    // 第二轮：C 消失。
    round = 2;
    const run2 = await postJson(port, token, '/api/runs', { mode: 'selected', siteIds: ['poki'] });
    const { runId: runId2 } = (await run2.json()).data;
    await waitFor(async () => (await getJson(port, '/api/runs/active')).body.data.active === null);

    // ---- DB 层：site_crawl_runs 直接查询 ----
    const scr = dashboard.db.prepare('SELECT * FROM site_crawl_runs WHERE run_id = ? AND site_id = ?').get(runId2, 'poki');
    assert.equal(scr.missing_url_count, 1);
    assert.equal(scr.consecutive_missing_count, 0);
    assert.equal(scr.restored_url_count, 0);
    assert.equal(scr.comparison_performed, 1);

    // ---- API 层：GET /api/runs/:id/sites 的聚合字段必须和 DB 一致 ----
    const sitesRes = await getJson(port, `/api/runs/${runId2}/sites`);
    const pokiRow = sitesRes.body.data.sites.find((s) => s.siteId === 'poki');
    assert.equal(pokiRow.missingUrlCount, 1);
    assert.equal(pokiRow.comparisonPerformed, true);

    // ---- API 层：GET /api/runs/:id/changes?type=missing 分页总数必须和 DB 一致 ----
    const changesRes = await getJson(port, `/api/runs/${runId2}/changes?site_id=poki&type=missing`);
    assert.equal(changesRes.body.data.total, 1);
    assert.equal(changesRes.body.data.items[0].originalUrl, 'https://poki.com/g/c');
    assert.equal(changesRes.body.data.items[0].changeType, 'missing');

    // type=consecutive_missing / restored 此时应该都是 0（还没发生）。
    const consecutiveRes = await getJson(port, `/api/runs/${runId2}/changes?site_id=poki&type=consecutive_missing`);
    assert.equal(consecutiveRes.body.data.total, 0);
    const restoredRes = await getJson(port, `/api/runs/${runId2}/changes?site_id=poki&type=restored`);
    assert.equal(restoredRes.body.data.total, 0);

    // ---- 报告层：report.stats 与下载的 missing-urls.csv / changes.json 必须和上面一致 ----
    const reportMeta = await getJson(port, `/api/runs/${runId2}/report`);
    assert.equal(reportMeta.status, 200);
    assert.equal(reportMeta.body.data.stats.missingTotal, 1);
    assert.equal(reportMeta.body.data.stats.consecutiveMissingTotal, 0);
    assert.equal(reportMeta.body.data.stats.restoredTotal, 0);
    assert.equal(reportMeta.body.data.files.missingUrlsCsv, 'missing-urls.csv');
    assert.equal(reportMeta.body.data.files.changesJson, 'changes.json');

    // ---- AI 审查包：正式落盘在项目 output 目录内，API 只是暴露相对路径 + 提供下载副本 ----
    assert.equal(reportMeta.body.data.aiReviewPackage.filename, 'ai-review-package.zip');
    assert.equal(reportMeta.body.data.files.aiReviewPackageZip, 'ai-review-package.zip');
    assert.match(
      reportMeta.body.data.aiReviewPackage.relativePath,
      new RegExp(`^output/\\d{4}-\\d{2}-\\d{2}/${runId2}/ai-review-package\\.zip$`),
    );
    const zipRes = await fetch(`http://127.0.0.1:${port}/api/runs/${runId2}/report/ai-review-package.zip`, { headers: { host: `127.0.0.1:${port}` } });
    assert.equal(zipRes.status, 200);
    assert.match(zipRes.headers.get('content-type'), /application\/zip/);
    const zipBuf = Buffer.from(await zipRes.arrayBuffer());
    const zipEntries = readZipEntries(zipBuf);
    const missingCsvEntry = zipEntries.find((e) => e.name === 'missing-urls.csv');
    assert.ok(missingCsvEntry, 'zip 内必须包含 missing-urls.csv');
    assert.match(missingCsvEntry.data.toString('utf-8'), /https:\/\/poki\.com\/g\/c/);

    const csvRes = await fetch(`http://127.0.0.1:${port}/api/runs/${runId2}/report/missing-urls.csv`, { headers: { host: `127.0.0.1:${port}` } });
    const csvText = await csvRes.text();
    assert.match(csvText, /https:\/\/poki\.com\/g\/c/);
    assert.equal(csvText.trim().split('\r\n').length, 2, 'header + 1 行数据');

    const changesJsonRes = await fetch(`http://127.0.0.1:${port}/api/runs/${runId2}/report/changes.json`, { headers: { host: `127.0.0.1:${port}` } });
    const changesJson = await changesJsonRes.json();
    assert.equal(changesJson.missing.length, 1);
    assert.equal(changesJson.missing[0].original_url, 'https://poki.com/g/c');
    assert.equal(changesJson.consecutiveMissing.length, 0);
    assert.equal(changesJson.restored.length, 0);
  } finally {
    await dashboard.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
