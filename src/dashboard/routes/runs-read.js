import { existsSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { generateReport } from '../../report/report.js';
import { ApiError } from './sites-write.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const REPORT_FILE_BASENAMES = new Set([
  'new-urls.csv', 'new-urls.json', 'new-games.csv', 'unknown-urls.csv', 'report.md',
  'missing-urls.csv', 'consecutive-missing-urls.csv', 'restored-urls.csv', 'changes.json',
  'ai-review-package.zip',
]);
const CHANGE_TYPES = new Set(['added', 'missing', 'consecutive_missing', 'restored']);
const CONTENT_TYPES = {
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.zip': 'application/zip',
};

/** GET /api/runs/active */
export function getActiveRunRoute(runController) {
  return { active: runController.getActiveSnapshot() };
}

/** GET /api/runs/:run_id/sites */
export function getRunSitesRoute(runController, runId) {
  assertRunKnown(runController, runId);
  return { sites: runController.getRunSites(runId) };
}

/**
 * GET /api/runs/:run_id/changes?site_id=&type=added&page=1&page_size=50
 * 只读分页：type 支持 4 种变化类型——added（沿用 added_urls，不变）、
 * missing / consecutive_missing / restored（Dashboard M4 新增，查
 * url_changes）。分页结构统一，不为每种类型另开一个接口。
 */
export function getRunChangesRoute(db, runController, runId, { siteId, type, page, pageSize } = {}) {
  assertRunKnown(runController, runId);
  const changeType = type === undefined ? 'added' : type;
  if (!CHANGE_TYPES.has(changeType)) {
    throw new ApiError('INVALID_PAGE_PARAMS', `type 必须是 added/missing/consecutive_missing/restored 之一，收到: ${type}`, { status: 422 });
  }

  const pageNum = parsePositiveInt(page, 1);
  const sizeNum = parsePositiveInt(pageSize, DEFAULT_PAGE_SIZE);
  if (pageNum === null || sizeNum === null || sizeNum > MAX_PAGE_SIZE) {
    throw new ApiError('INVALID_PAGE_PARAMS', `page/page_size 参数不合法（page_size 上限 ${MAX_PAGE_SIZE}）`, { status: 422 });
  }

  if (changeType === 'added') {
    const whereParts = ['a.run_id = ?'];
    const params = [runId];
    if (siteId) {
      whereParts.push('a.site_id = ?');
      params.push(siteId);
    }
    const where = whereParts.join(' AND ');

    const total = db.prepare(`SELECT COUNT(*) AS n FROM added_urls a WHERE ${where}`).get(...params).n;
    const rows = db
      .prepare(
        `SELECT a.site_id, a.original_url, a.normalized_url, a.detected_at,
                c.page_type, c.game_name, c.confidence, c.classification_error
         FROM added_urls a
         LEFT JOIN url_classifications c
           ON c.run_id = a.run_id AND c.site_id = a.site_id AND c.url_hash = a.url_hash
         WHERE ${where}
         ORDER BY a.detected_at DESC, a.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, sizeNum, (pageNum - 1) * sizeNum);

    return {
      page: pageNum,
      pageSize: sizeNum,
      total,
      items: rows.map((r) => ({
        siteId: r.site_id,
        originalUrl: r.original_url,
        normalizedUrl: r.normalized_url,
        detectedAt: r.detected_at,
        changeType: 'added',
        // 采集刚完成、分类阶段还没跑到这条 URL 时 page_type 是 NULL——
        // 明确展示"待分类"，不能悄悄当成 unknown（那是分类完成后的真实结论）。
        pageType: r.page_type || '待分类',
        gameName: r.game_name,
        confidence: r.confidence,
        classificationError: r.classification_error,
      })),
    };
  }

  // missing / consecutive_missing / restored：不经过分类器（这三种变化
  // 不触发页面抓取或分类），所以没有 page_type/game_name 等字段。
  const whereParts = ['c.run_id = ?', 'c.change_type = ?'];
  const params = [runId, changeType];
  if (siteId) {
    whereParts.push('c.site_id = ?');
    params.push(siteId);
  }
  const where = whereParts.join(' AND ');

  const total = db.prepare(`SELECT COUNT(*) AS n FROM url_changes c WHERE ${where}`).get(...params).n;
  const rows = db
    .prepare(
      `SELECT c.site_id, c.original_url, c.normalized_url, c.detected_at
       FROM url_changes c
       WHERE ${where}
       ORDER BY c.detected_at DESC, c.id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, sizeNum, (pageNum - 1) * sizeNum);

  return {
    page: pageNum,
    pageSize: sizeNum,
    total,
    items: rows.map((r) => ({
      siteId: r.site_id,
      originalUrl: r.original_url,
      normalizedUrl: r.normalized_url,
      detectedAt: r.detected_at,
      changeType,
    })),
  };
}

/** GET /api/runs/:run_id/report：报告元数据（文件名走白名单，不回显绝对路径）。 */
export function getRunReportRoute(db, config, runController, runId) {
  assertRunKnown(runController, runId);
  assertReportReady(db, runController, runId);
  const report = generateReport(db, { runId, outputDir: config.outputDir });
  return {
    dir: report.dir,
    files: Object.fromEntries(Object.entries(report.files).map(([key, path]) => [key, basename(path)])),
    stats: report.stats,
    // AI 审查包：正式落盘在这个 run 自己的报告目录（不是浏览器临时下载），
    // relativePath 只是给用户看/复制的展示字符串，见 report.js 的说明。
    aiReviewPackage: {
      filename: basename(report.files.aiReviewPackageZip),
      relativePath: report.aiReviewPackageRelativePath,
    },
  };
}

/**
 * GET /api/runs/:run_id/report/:filename：下载单个报告文件。
 * filename 必须命中固定白名单（REPORT_FILE_BASENAMES），不接受用户传入的
 * 任意路径或绝对路径——实际读取的文件路径永远来自服务端自己调用
 * generateReport() 得到的 report.files，不会用请求里的字符串拼路径。
 */
export function getRunReportFileRoute(db, config, runController, runId, filename) {
  assertRunKnown(runController, runId);
  assertReportReady(db, runController, runId);
  if (!REPORT_FILE_BASENAMES.has(filename)) {
    throw new ApiError('REPORT_FILE_NOT_FOUND', `未知的报告文件: ${filename}`, { status: 404 });
  }
  const report = generateReport(db, { runId, outputDir: config.outputDir });
  const match = Object.values(report.files).find((path) => basename(path) === filename);
  if (!match || !existsSync(match)) {
    throw new ApiError('REPORT_FILE_NOT_FOUND', `报告文件不存在: ${filename}`, { status: 404 });
  }
  return { filePath: match, contentType: CONTENT_TYPES[extname(match)] || 'application/octet-stream' };
}

function assertRunKnown(runController, runId) {
  if (!runController.isRunKnown(runId)) {
    throw new ApiError('RUN_NOT_FOUND', `找不到运行: ${runId}`, { status: 404 });
  }
}

/**
 * 报告只有在采集+分类都走完之后生成才有意义。两种情况都拒绝：
 *  1. 运行仍然活跃且还没进入报告阶段（preparing/collecting/classifying）；
 *  2. 运行已经结束、内存态已经清空，但它的终态是 cancelled——安全停止
 *     的设计就是"跳过分类和生成报告"，此时如果仍然放行，generateReport()
 *     会照样对着一个空的 url_classifications 生成一份"看起来正常、其实
 *     什么都没分类"的空报告，会误导用户以为整轮流程正常跑完了。
 */
function assertReportReady(db, runController, runId) {
  const active = runController.getActiveSnapshot();
  if (active && active.runId === runId && ['preparing', 'collecting', 'classifying'].includes(active.phase)) {
    throw new ApiError('REPORT_NOT_READY', '本次运行尚未进入生成报告阶段', { status: 409 });
  }
  if (!active || active.runId !== runId) {
    const row = db.prepare('SELECT status FROM crawl_runs WHERE run_id = ?').get(runId);
    if (row && row.status === 'cancelled') {
      throw new ApiError('REPORT_NOT_READY', '该运行被安全停止，跳过了分类和报告阶段，没有可用的报告', { status: 409 });
    }
  }
}

function parsePositiveInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}
