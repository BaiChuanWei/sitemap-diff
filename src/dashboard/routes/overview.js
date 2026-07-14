import { statSync } from 'node:fs';
import { getDbStatus } from '../../storage/index.js';

/** GET /api/overview：总览页数据，纯只读查询，不做任何写操作。 */
export function getOverview(db, config) {
  const status = getDbStatus(db);
  let dbSizeBytes = null;
  try {
    dbSizeBytes = statSync(config.dbPath).size;
  } catch {
    dbSizeBytes = null;
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();

  const todayAdded = db
    .prepare(`SELECT COUNT(*) AS n FROM added_urls WHERE detected_at >= ?`)
    .get(todayIso).n;
  const todayGames = db
    .prepare(
      `SELECT COUNT(*) AS n FROM url_classifications
       WHERE classified_at >= ? AND page_type = 'game'`,
    )
    .get(todayIso).n;

  const runningRun = db
    .prepare(`SELECT run_id, started_at FROM crawl_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`)
    .get();

  return {
    siteCount: status.siteCount,
    enabledCount: status.enabledCount,
    baselineCount: status.baselineCount,
    seenUrlCount: status.seenUrlCount,
    addedUrlCount: status.addedUrlCount,
    todayAddedUrlCount: todayAdded,
    todayNewGameCount: todayGames,
    dbSizeBytes,
    lastRun: status.lastRun,
    recentSuccess: status.recentSuccess,
    recentFailed: status.recentFailed,
    // 服务重启后异常遗留的 running 状态整体运行记录（进程被杀死中途），
    // 只读展示，不擅自改写——是否处理留给后续里程碑的显式用户操作。
    staleRunningRun: runningRun || null,
  };
}

/** GET /api/sites：合并 sites 表状态的只读站点清单。 */
export function listSites(db) {
  return db
    .prepare(
      `SELECT site_id, domain, priority, enabled, robots_url, sitemap_url, expected_game_path, notes,
              last_attempt_at, last_success_at, last_status, last_error, baseline_completed_at
       FROM sites ORDER BY site_id ASC`,
    )
    .all();
}

/** GET /api/runs：运行历史列表，按开始时间倒序。 */
export function listRuns(db, { limit = 50 } = {}) {
  return db
    .prepare(`SELECT * FROM crawl_runs ORDER BY started_at DESC LIMIT ?`)
    .all(limit);
}

/** GET /api/runs/:run_id：单次运行详情 + 逐站结果，供"查看最近结果"使用。 */
export function getRunDetail(db, runId) {
  const run = db.prepare(`SELECT * FROM crawl_runs WHERE run_id = ?`).get(runId);
  if (!run) return null;
  const sites = db
    .prepare(`SELECT * FROM site_crawl_runs WHERE run_id = ? ORDER BY site_id ASC`)
    .all(runId);
  const addedSample = db
    .prepare(
      `SELECT site_id, original_url, detected_at FROM added_urls
       WHERE run_id = ? ORDER BY detected_at DESC LIMIT 50`,
    )
    .all(runId);
  return { run, sites, addedSample };
}
