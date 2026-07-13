import { classifyUrl } from './classifier.js';
import { matchNonGame } from './non-game.js';
import { fetchPages as defaultFetchPages } from './page-fetcher.js';

/**
 * 对某次运行的全部新增 URL（added_urls）做页面初筛分类，结果写入
 * url_classifications（幂等：以 run_id+site_id+url_hash upsert）。
 *
 * 关键保证：
 *   - 每条 added_url 都产出一条分类，识别不出记为 unknown（绝不丢弃）；
 *   - 明确的 non_game（静态资源 / 分类页）不抓取页面，节省请求；
 *   - 其余 URL 尽力抓取页面拿元数据；抓取失败 → unknown/low/classificationError；
 *   - 只读 added_urls / sites，从不修改它们，分类失败也不破坏 M3 历史。
 *
 * @param fetchPagesFn 可注入的抓取函数（默认复用 M2 fetcher 的 fetchPages），便于测试
 * @returns { runId, total, counts:{game,non_game,unknown}, classificationErrors, bySite }
 */
export async function classifyRun(db, { runId, fetchPagesFn = defaultFetchPages, limits, now } = {}) {
  const ts = now || new Date().toISOString();

  const rows = db
    .prepare('SELECT run_id, site_id, url_hash, original_url, normalized_url, sitemap_url FROM added_urls WHERE run_id = ?')
    .all(runId);

  if (rows.length === 0) {
    return { runId, total: 0, counts: { game: 0, non_game: 0, unknown: 0 }, classificationErrors: 0, bySite: {} };
  }

  // 站点级元数据：domain、expected_game_path。
  const siteMeta = new Map();
  const siteStmt = db.prepare('SELECT domain, expected_game_path FROM sites WHERE site_id = ?');
  for (const siteId of new Set(rows.map((r) => r.site_id))) {
    siteMeta.set(siteId, siteStmt.get(siteId) || {});
  }

  // 需要抓取页面的 URL：跳过明确的 non_game。
  const fetchUrls = [];
  for (const row of rows) {
    if (!matchNonGame(row.normalized_url).matched) fetchUrls.push(row.original_url);
  }

  let pages = new Map();
  if (fetchUrls.length > 0) {
    pages = await fetchPagesFn([...new Set(fetchUrls)], { limits });
  }

  const upsert = db.prepare(
    `INSERT INTO url_classifications
       (run_id, site_id, url_hash, original_url, normalized_url, sitemap_url, page_type, game_name, confidence, evidence, classification_error, classified_at)
     VALUES (@run_id, @site_id, @url_hash, @original_url, @normalized_url, @sitemap_url, @page_type, @game_name, @confidence, @evidence, @classification_error, @classified_at)
     ON CONFLICT(run_id, site_id, url_hash) DO UPDATE SET
       original_url = @original_url,
       normalized_url = @normalized_url,
       sitemap_url = @sitemap_url,
       page_type = @page_type,
       game_name = @game_name,
       confidence = @confidence,
       evidence = @evidence,
       classification_error = @classification_error,
       classified_at = @classified_at`,
  );

  const counts = { game: 0, non_game: 0, unknown: 0 };
  const bySite = {};
  let classificationErrors = 0;

  const tx = db.transaction(() => {
    for (const row of rows) {
      const meta = siteMeta.get(row.site_id) || {};
      const record = {
        originalUrl: row.original_url,
        normalizedUrl: row.normalized_url,
        urlHash: row.url_hash,
        siteId: row.site_id,
        domain: meta.domain || null,
        sitemapUrl: row.sitemap_url,
      };
      const page = pages.get(row.original_url); // undefined 表示未抓取（non_game 或无需抓取）
      const c = classifyUrl(record, { expectedGamePath: meta.expected_game_path || undefined, page });

      upsert.run({
        run_id: runId,
        site_id: row.site_id,
        url_hash: row.url_hash,
        original_url: row.original_url,
        normalized_url: row.normalized_url,
        sitemap_url: row.sitemap_url ?? null,
        page_type: c.pageType,
        game_name: c.gameName ?? null,
        confidence: c.confidence ?? null,
        evidence: JSON.stringify(c.evidence || []),
        classification_error: c.classificationError ?? null,
        classified_at: ts,
      });

      counts[c.pageType] = (counts[c.pageType] || 0) + 1;
      bySite[row.site_id] = (bySite[row.site_id] || 0) + 1;
      if (c.classificationError) classificationErrors++;
    }
  });
  tx();

  return { runId, total: rows.length, counts, classificationErrors, bySite };
}
