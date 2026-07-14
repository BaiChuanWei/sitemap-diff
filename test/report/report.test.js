import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/index.js';
import { persistCompleteSiteResult, createCrawlRun, finishCrawlRun } from '../../src/storage/index.js';
import { classifyRun } from '../../src/classify/runner.js';
import { generateReport } from '../../src/report/report.js';
import { extractPageMeta } from '../../src/classify/page-meta.js';
import { readZipEntries } from '../helpers/zip-reader.js';

function completeResult(siteId, pageUrls, overrides = {}) {
  return {
    siteId, domain: `${siteId}.com`, status: 'success', complete: true, truncated: false,
    truncationReasons: [], startedAt: '2026-07-13T00:00:00.000Z', finishedAt: '2026-07-13T00:00:01.000Z',
    durationMs: 1, discoveredSitemaps: [], processedSitemaps: [{ url: `https://${siteId}.com/sitemap.xml`, status: 'success' }],
    failedSitemaps: [], pageUrls, pageUrlCount: pageUrls.length, sitemapCount: 1, warnings: [], errors: [], ...overrides,
  };
}

async function setupRun(db, { siteId = 'poki', expectedGamePath = '/g/', addedUrls, fetchPagesFn, sitemapUrlNull = true } = {}) {
  db.prepare('INSERT INTO sites (site_id, domain, enabled, expected_game_path) VALUES (?, ?, 1, ?)').run(siteId, `${siteId}.com`, expectedGamePath);
  const site = { site_id: siteId, domain: `${siteId}.com` };
  createCrawlRun(db, { runId: 'baseline', startedAt: '2026-07-13T00:00:00.000Z' });
  persistCompleteSiteResult(db, { runId: 'baseline', site, result: completeResult(siteId, ['https://poki.com/g/base']) });

  createCrawlRun(db, { runId: 'run-2', startedAt: '2026-07-13T01:00:00.000Z' });
  persistCompleteSiteResult(db, { runId: 'run-2', site, result: completeResult(siteId, ['https://poki.com/g/base', ...addedUrls]) });
  finishCrawlRun(db, {
    runId: 'run-2', finishedAt: '2026-07-13T01:00:05.000Z', status: 'success',
    stats: { sitesTotal: 1, sitesSuccess: 1, sitesPartial: 0, sitesFailed: 0, baselineSiteCount: 0, baselineUrlCount: 0, addedUrlCount: addedUrls.length },
    errorSummary: null,
  });
  await classifyRun(db, { runId: 'run-2', fetchPagesFn });
  return 'run-2';
}

async function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'm4-report-'));
  const outDir = join(dir, 'output');
  const db = openDb(join(dir, 'local.db'));
  try {
    return await fn(db, outDir, dir);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const mixedFetch = async (urls) => {
  const m = new Map();
  for (const u of urls) {
    if (u.includes('hero')) m.set(u, { ok: true, meta: extractPageMeta('<title>Hero Quest</title><h1>Hero Quest</h1>') });
    else m.set(u, { ok: true, meta: extractPageMeta('<title>x</title>') });
  }
  return m;
};

test('测试7/8/9 CSV/JSON 记录数一致，new-games 与 unknown-urls 是 new-urls 子集', async () => {
  await withTempDb(async (db, outDir) => {
    const runId = await setupRun(db, {
      addedUrls: ['https://poki.com/g/hero-quest', 'https://poki.com/category/action', 'https://poki.com/x/y/z'],
      fetchPagesFn: mixedFetch,
    });
    const { files, stats } = generateReport(db, { runId, outputDir: outDir });

    const newUrls = parseCsv(readFileSync(files.newUrlsCsv, 'utf-8'));
    const newGames = parseCsv(readFileSync(files.newGamesCsv, 'utf-8'));
    const unknowns = parseCsv(readFileSync(files.unknownUrlsCsv, 'utf-8'));
    const json = JSON.parse(readFileSync(files.newUrlsJson, 'utf-8'));

    assert.equal(newUrls.length, 3);
    assert.equal(json.urls.length, 3, 'CSV 与 JSON 记录数一致');
    assert.equal(stats.addedTotal, 3);

    // new-games ⊆ new-urls
    const allUrlSet = new Set(newUrls.map((r) => r.original_url));
    assert.ok(newGames.every((g) => allUrlSet.has(g.original_url)));
    assert.ok(newGames.every((g) => g.page_type === 'game'));
    // unknown-urls ⊆ new-urls
    assert.ok(unknowns.every((u) => allUrlSet.has(u.original_url)));
    assert.ok(unknowns.every((u) => u.page_type === 'unknown'));

    assert.equal(newGames.length, 1);
    assert.equal(unknowns.length, 1);
  });
});

test('测试11 重复报告结果一致（幂等，同目录同内容）', async () => {
  await withTempDb(async (db, outDir) => {
    const runId = await setupRun(db, { addedUrls: ['https://poki.com/g/hero-quest'], fetchPagesFn: mixedFetch });
    const first = generateReport(db, { runId, outputDir: outDir });
    const contentA = readFileSync(first.files.newUrlsCsv, 'utf-8');
    const second = generateReport(db, { runId, outputDir: outDir });
    const contentB = readFileSync(second.files.newUrlsCsv, 'utf-8');
    assert.equal(first.dir, second.dir, '同一 run 应写同一目录');
    assert.equal(contentA, contentB, '重复报告内容应一致');
  });
});

test('测试12 报告失败不破坏 SQLite（输出目录非法时抛错，但库不变）', async () => {
  await withTempDb(async (db, outDir, dir) => {
    const runId = await setupRun(db, { addedUrls: ['https://poki.com/g/hero-quest'], fetchPagesFn: mixedFetch });
    const before = {
      cls: db.prepare('SELECT COUNT(*) AS n FROM url_classifications').get().n,
      seen: db.prepare('SELECT COUNT(*) AS n FROM seen_urls').get().n,
      added: db.prepare('SELECT COUNT(*) AS n FROM added_urls').get().n,
    };
    // 用一个"文件"当作 outputDir 的父级，使 mkdir 失败
    const filePath = join(dir, 'not-a-dir');
    writeFileSync(filePath, 'x');
    assert.throws(() => generateReport(db, { runId, outputDir: filePath }));
    const after = {
      cls: db.prepare('SELECT COUNT(*) AS n FROM url_classifications').get().n,
      seen: db.prepare('SELECT COUNT(*) AS n FROM seen_urls').get().n,
      added: db.prepare('SELECT COUNT(*) AS n FROM added_urls').get().n,
    };
    assert.deepEqual(after, before, '报告失败不得改动 SQLite');
  });
});

test('测试15 中文游戏名与 UTF-8 输出正确', async () => {
  await withTempDb(async (db, outDir) => {
    const fetchPagesFn = async (urls) => {
      const m = new Map();
      for (const u of urls) m.set(u, { ok: true, meta: extractPageMeta('<title>超级冒险</title><h1>超级冒险</h1>') });
      return m;
    };
    // JSON-LD 明确游戏 + 中文标题 → game，game_name 含中文
    const fetchZh = async (urls) => {
      const m = new Map();
      for (const u of urls) m.set(u, { ok: true, meta: extractPageMeta('<script type="application/ld+json">{"@type":"VideoGame","name":"超级冒险"}</script><h1>超级冒险</h1>') });
      return m;
    };
    const runId = await setupRun(db, { expectedGamePath: null, addedUrls: ['https://poki.com/x/y/zh'], fetchPagesFn: fetchZh });
    const { files } = generateReport(db, { runId, outputDir: outDir });
    const csv = readFileSync(files.newUrlsCsv, 'utf-8');
    assert.ok(csv.includes('超级冒险'), 'CSV 应以 UTF-8 正确输出中文');
    const json = JSON.parse(readFileSync(files.newUrlsJson, 'utf-8'));
    assert.ok(json.urls.some((r) => (r.game_name || '').includes('超级冒险')));
  });
});

test('测试16 sitemap_url=null 时报告仍正常生成，字段保留', async () => {
  await withTempDb(async (db, outDir) => {
    const runId = await setupRun(db, { addedUrls: ['https://poki.com/g/hero-quest'], fetchPagesFn: mixedFetch });
    // M3 的 added_urls.sitemap_url 目前为 null
    const { files } = generateReport(db, { runId, outputDir: outDir });
    const rows = parseCsv(readFileSync(files.newUrlsCsv, 'utf-8'));
    assert.ok('sitemap_url' in rows[0], 'CSV 必须保留 sitemap_url 字段');
    assert.equal(rows[0].sitemap_url, '', 'null 序列化为空');
    const json = JSON.parse(readFileSync(files.newUrlsJson, 'utf-8'));
    assert.ok('sitemap_url' in json.urls[0]);
  });
});

test('空 run 报告：0 新增也能正常生成全部 5 个文件', async () => {
  await withTempDb(async (db, outDir) => {
    createCrawlRun(db, { runId: 'empty', startedAt: '2026-07-13T02:00:00.000Z' });
    finishCrawlRun(db, {
      runId: 'empty', finishedAt: '2026-07-13T02:00:01.000Z', status: 'success',
      stats: { sitesTotal: 3, sitesSuccess: 3, sitesPartial: 0, sitesFailed: 0, baselineSiteCount: 0, baselineUrlCount: 0, addedUrlCount: 0 },
      errorSummary: null,
    });
    const { files, stats } = generateReport(db, { runId: 'empty', outputDir: outDir });
    for (const f of Object.values(files)) assert.ok(existsSync(f), `${f} 应存在`);
    assert.equal(stats.addedTotal, 0);
    const md = readFileSync(files.reportMd, 'utf-8');
    assert.ok(md.includes('新增 URL 总数：0'));
  });
});

test('report.md 含 run_id/时间/统计/输出路径', async () => {
  await withTempDb(async (db, outDir) => {
    const runId = await setupRun(db, { addedUrls: ['https://poki.com/g/hero-quest'], fetchPagesFn: mixedFetch });
    const { files } = generateReport(db, { runId, outputDir: outDir });
    const md = readFileSync(files.reportMd, 'utf-8');
    assert.ok(md.includes(runId));
    assert.ok(md.includes('game：'));
    assert.ok(md.includes('new-urls.csv'));
  });
});

test('AI审查包：正式落盘在 run 目录，原子覆盖不留临时文件，只含报告文件、不含库/配置/日志', async () => {
  await withTempDb(async (db, outDir) => {
    const runId = await setupRun(db, { addedUrls: ['https://poki.com/g/hero-quest'], fetchPagesFn: mixedFetch });

    const first = generateReport(db, { runId, outputDir: outDir });
    assert.ok(first.files.aiReviewPackageZip.endsWith('ai-review-package.zip'));
    assert.ok(existsSync(first.files.aiReviewPackageZip), '正式 zip 必须落盘在 run 目录');
    assert.equal(first.files.aiReviewPackageZip, join(first.dir, 'ai-review-package.zip'), 'zip 必须和其它报告文件同目录');
    assert.equal(first.aiReviewPackageRelativePath, `output/${first.date}/${runId}/ai-review-package.zip`);

    const zipBuf1 = readFileSync(first.files.aiReviewPackageZip);
    const entries1 = readZipEntries(zipBuf1);
    const names = entries1.map((e) => e.name).sort();
    assert.deepEqual(
      names,
      [
        'changes.json', 'consecutive-missing-urls.csv', 'missing-urls.csv', 'new-games.csv',
        'new-urls.csv', 'new-urls.json', 'report.md', 'restored-urls.csv', 'unknown-urls.csv',
      ],
      'zip 内必须只有报告文件，不能出现数据库/配置/日志文件',
    );

    // 重复生成（幂等）：原子改名后不应该留下任何 .tmp 临时文件，且解包内容一致。
    const second = generateReport(db, { runId, outputDir: outDir });
    const dirFiles = readdirSync(second.dir);
    assert.ok(dirFiles.every((f) => !f.includes('.tmp-')), `重复生成后不应残留临时文件: ${dirFiles.join(', ')}`);

    const zipBuf2 = readFileSync(second.files.aiReviewPackageZip);
    const entries2 = readZipEntries(zipBuf2);
    const byName1 = Object.fromEntries(entries1.map((e) => [e.name, e.data.toString('utf-8')]));
    const byName2 = Object.fromEntries(entries2.map((e) => [e.name, e.data.toString('utf-8')]));
    assert.deepEqual(byName2, byName1, '重复生成后 zip 内每个文件的内容必须和上一次完全一致');

    // report.md 本身也打包进了 zip，且和磁盘上单独的 report.md 内容一致。
    const reportMdOnDisk = readFileSync(second.files.reportMd, 'utf-8');
    assert.equal(byName2['report.md'], reportMdOnDisk);
  });
});

// --- 极简 CSV 解析（仅供测试断言用，支持引号包裹字段） ---
function parseCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.length > 0);
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const o = {};
    headers.forEach((h, i) => (o[h] = cells[i] ?? ''));
    return o;
  });
}
function splitCsvLine(line) {
  const cells = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}
