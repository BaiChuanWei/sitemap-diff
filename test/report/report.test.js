import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
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

const AI_REVIEW_PACKAGE_FILES = [
  'ai-review.json', 'ai-review.txt', 'changes.json', 'consecutive-missing-urls.csv',
  'manifest.json', 'missing-urls.csv', 'new-games.csv', 'new-urls.csv', 'new-urls.json',
  'report.md', 'restored-urls.csv', 'unknown-urls.csv',
].sort();

test('AI审查包：manifest.json / ai-review.json / ai-review.txt + 原有9个报告文件，12个文件正式落盘并原子打包', async () => {
  await withTempDb(async (db, outDir) => {
    const siteId = 'poki';
    db.prepare('INSERT INTO sites (site_id, domain, enabled, expected_game_path) VALUES (?, ?, 1, ?)').run(siteId, 'poki.com', '/g/');
    const site = { site_id: siteId, domain: 'poki.com' };
    const A = 'https://poki.com/g/a';
    const B = 'https://poki.com/g/b';
    const C = 'https://poki.com/g/c'; // 第4轮首次缺失（missing）
    const D = 'https://poki.com/g/d'; // 第2/3轮缺失，第4轮恢复（restored）
    const G = 'https://poki.com/g/g'; // 第3轮首次缺失，第4轮连续两轮缺失（consecutive_missing）
    const F = 'https://poki.com/g/hero-quest'; // 第4轮才出现（added）

    createCrawlRun(db, { runId: 'r1', startedAt: '2026-07-13T00:00:00Z' });
    persistCompleteSiteResult(db, { runId: 'r1', site, result: completeResult(siteId, [A, B, C, D, G]) }); // baseline

    createCrawlRun(db, { runId: 'r2', startedAt: '2026-07-13T01:00:00Z' });
    persistCompleteSiteResult(db, { runId: 'r2', site, result: completeResult(siteId, [A, B, C, G]) }); // D missing

    createCrawlRun(db, { runId: 'r3', startedAt: '2026-07-13T02:00:00Z' });
    persistCompleteSiteResult(db, { runId: 'r3', site, result: completeResult(siteId, [A, B, C]) }); // D consecutive_missing；G missing

    createCrawlRun(db, { runId: 'r4', startedAt: '2026-07-13T03:00:00Z' });
    const persisted = persistCompleteSiteResult(db, { runId: 'r4', site, result: completeResult(siteId, [A, B, D, F]) }); // C missing；D restored；G consecutive_missing；F added
    finishCrawlRun(db, {
      runId: 'r4',
      finishedAt: '2026-07-13T03:00:05Z',
      status: 'success',
      stats: {
        sitesTotal: 1, sitesSuccess: 1, sitesPartial: 0, sitesFailed: 0,
        baselineSiteCount: 0, baselineUrlCount: 0,
        addedUrlCount: persisted.addedCount, missingUrlCount: persisted.missingCount,
        consecutiveMissingCount: persisted.consecutiveMissingCount, restoredUrlCount: persisted.restoredCount,
      },
      errorSummary: null,
    });
    db.prepare('UPDATE crawl_runs SET run_mode = ?, site_selection = ? WHERE run_id = ?').run('selected', JSON.stringify([siteId]), 'r4');
    await classifyRun(db, { runId: 'r4', fetchPagesFn: mixedFetch });

    const runId = 'r4';
    const fixedNow = () => '2026-07-13T04:00:00.000Z';
    const dbSnapshotBefore = JSON.stringify(db.prepare('SELECT * FROM crawl_runs WHERE run_id = ?').get(runId));

    const report = generateReport(db, { runId, outputDir: outDir, now: fixedNow });

    // 导出前后数据库不变（report.js 全程只读）。
    const dbSnapshotAfter = JSON.stringify(db.prepare('SELECT * FROM crawl_runs WHERE run_id = ?').get(runId));
    assert.equal(dbSnapshotAfter, dbSnapshotBefore, '生成 AI 审查包前后数据库不应有任何变化');

    // 三份新文件 + zip 都和其它报告文件落在同一个 run 目录。
    for (const key of ['manifestJson', 'aiReviewJson', 'aiReviewTxt', 'aiReviewPackageZip']) {
      assert.equal(join(report.dir, basename(report.files[key])), report.files[key], `${key} 必须落在 run 目录`);
      assert.ok(existsSync(report.files[key]), `${key} 必须落盘`);
    }

    // ZIP 最终必须正好是 12 个文件。
    const zipEntries = readZipEntries(readFileSync(report.files.aiReviewPackageZip));
    const zipNames = zipEntries.map((e) => e.name).sort();
    assert.deepEqual(zipNames, AI_REVIEW_PACKAGE_FILES, 'zip 必须正好包含 12 个文件，不能多也不能少');

    // manifest.json：可解析，includedFiles 与 zip 实际清单一致，计数与 DB 一致，不含敏感/绝对路径信息。
    const manifest = JSON.parse(readFileSync(report.files.manifestJson, 'utf-8'));
    assert.equal(manifest.schemaVersion, '1.0');
    assert.equal(manifest.run.runId, runId);
    assert.equal(manifest.run.mode, 'selected');
    assert.deepEqual(manifest.run.selectedSiteIds, [siteId]);
    assert.deepEqual([...manifest.includedFiles].sort(), zipNames, 'manifest.includedFiles 必须和 zip 实际清单一致');
    assert.deepEqual(manifest.summary, {
      totalSites: 1, success: 1, partial: 0, failed: 0,
      added: 1, missing: 1, consecutiveMissing: 1, restored: 1,
      game: 1, nonGame: 0, unknown: 0,
    }, 'manifest.summary 必须和数据库算出来的统计一致');
    assert.ok(manifest.warnings.some((w) => w.includes('missing') && w.includes('永久删除')));
    assert.ok(manifest.warnings.some((w) => w.includes('consecutive_missing') && w.includes('永久删除')));
    assert.ok(manifest.warnings.some((w) => w.includes('restored') && w.includes('新增')));
    assert.ok(manifest.warnings.some((w) => w.includes('baseline') && w.includes('新增')));
    assert.ok(manifest.warnings.some((w) => w.includes('partial') && w.includes('failed')));
    const manifestText = JSON.stringify(manifest);
    assert.doesNotMatch(manifestText, new RegExp(outDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '不得包含本地绝对路径');
    assert.doesNotMatch(manifestText, /\.db["'/]|local\.db/i, '不得包含数据库路径');
    assert.doesNotMatch(manifestText, /token|api[_-]?key|secret/i, '不得包含 CSRF token / API Key 等敏感字段');

    // ai-review.json：可解析，四种 changeType 合法，each 字段只用现有数据，restored 不得混进 added。
    const aiReview = JSON.parse(readFileSync(report.files.aiReviewJson, 'utf-8'));
    assert.equal(aiReview.schemaVersion, '1.0');
    assert.ok(Array.isArray(aiReview.instructions) && aiReview.instructions.length > 0);
    assert.deepEqual(aiReview.summary, manifest.summary, 'ai-review.json 的 summary 必须和 manifest 一致');
    const VALID_TYPES = new Set(['added', 'missing', 'consecutive_missing', 'restored']);
    assert.ok(aiReview.items.every((i) => VALID_TYPES.has(i.changeType)), '每一项 changeType 必须是四种合法值之一');
    const byType = Object.fromEntries([...VALID_TYPES].map((t) => [t, aiReview.items.filter((i) => i.changeType === t)]));
    assert.equal(byType.added.length, 1);
    assert.equal(byType.added[0].url, F);
    assert.equal(byType.added[0].pageType, 'game', '新增的 F（含 hero）应该被分类为 game');
    assert.equal(byType.missing.length, 1);
    assert.equal(byType.missing[0].url, C);
    assert.equal(byType.missing[0].pageType, null, 'missing 条目不经过分类器，必须是 null 而不是编造值');
    assert.equal(byType.consecutive_missing.length, 1);
    assert.equal(byType.consecutive_missing[0].url, G);
    assert.equal(byType.restored.length, 1);
    assert.equal(byType.restored[0].url, D);
    assert.equal(byType.restored[0].changeType, 'restored', 'restored 不得被重新标记为 added');

    // ai-review.txt：包含任务说明、七个分区、必要警告，不含完整 HTML/调试日志。
    const txt = readFileSync(report.files.aiReviewTxt, 'utf-8');
    assert.ok(txt.startsWith('Sitemap变化AI审查任务'));
    assert.match(txt, /新的游戏页面/);
    assert.match(txt, /永久删除/);
    assert.match(txt, /## 1\. 运行摘要/);
    assert.match(txt, /## 2\. 新增URL/);
    assert.match(txt, /## 3\. 未知URL/);
    assert.match(txt, /## 4\. 本轮缺失/);
    assert.match(txt, /## 5\. 连续两轮缺失/);
    assert.match(txt, /## 6\. 恢复URL/);
    assert.match(txt, /## 7\. partial\/failed站点/);
    assert.match(txt, new RegExp(F.replace('.', '\\.')), '新增URL分区应该出现 F');
    assert.doesNotMatch(txt, /<html/i, '不得包含完整 HTML');

    // 重复生成（幂等）：原子改名后不应该留下任何 .tmp 临时文件，且三份新文件与 zip 内容都保持一致。
    // 用固定的 now 时钟，避免 manifest.generatedAt 因为两次真实调用间隔几毫秒而产生假性不一致。
    const second = generateReport(db, { runId, outputDir: outDir, now: fixedNow });
    const dirFiles = readdirSync(second.dir);
    assert.ok(dirFiles.every((f) => !f.includes('.tmp-')), `重复生成后不应残留临时文件: ${dirFiles.join(', ')}`);
    assert.equal(readFileSync(second.files.manifestJson, 'utf-8'), readFileSync(report.files.manifestJson, 'utf-8'));
    assert.equal(readFileSync(second.files.aiReviewJson, 'utf-8'), readFileSync(report.files.aiReviewJson, 'utf-8'));
    assert.equal(readFileSync(second.files.aiReviewTxt, 'utf-8'), readFileSync(report.files.aiReviewTxt, 'utf-8'));
    const zipEntries2 = readZipEntries(readFileSync(second.files.aiReviewPackageZip));
    const byName1 = Object.fromEntries(zipEntries.map((e) => [e.name, e.data.toString('utf-8')]));
    const byName2 = Object.fromEntries(zipEntries2.map((e) => [e.name, e.data.toString('utf-8')]));
    assert.deepEqual(byName2, byName1, '重复生成后 zip 内每个文件的内容必须和上一次完全一致');
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
