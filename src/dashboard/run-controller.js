import { randomUUID } from 'node:crypto';
import { runCollect } from '../collect-runner.js';
import { classifyRun } from '../classify/runner.js';
import { generateReport } from '../report/report.js';
import { acquireLock, releaseLock } from '../lock.js';
import { loadSiteOverrides } from '../config.js';
import { ApiError } from './routes/sites-write.js';
import { appendRunLog } from './run-log.js';

const TERMINAL_SITE_STATUSES = new Set(['success', 'partial', 'failed']);

/**
 * Dashboard M3：网页运行控制器。一个 createRunController() 实例对应一个
 * Dashboard 服务进程的生命周期（在 createDashboardServer() 里创建一次），
 * 不使用模块级单例——避免像 diagnose-write.js 那样，同一进程里多个测试用
 * 的 Dashboard 实例互相污染彼此的"活动运行"状态。
 *
 * 职责边界：只编排——依次调用现有的 runCollect() / classifyRun() /
 * generateReport()，不重新实现采集、分类、报告的任何一行核心逻辑。
 * "任何时刻只允许一个正式采集任务运行"用两层保护：进程内 activeRun 引用
 * （挡住同进程内的并发点击/双标签页）+ 真实的 data/collector.lock 文件锁
 * （挡住命令行 CLI 和面板之间的交叉运行）。
 */
export function createRunController({
  db,
  config,
  eventHub,
  collectSiteFn,
  classifyFetchPagesFn,
  now = () => new Date().toISOString(),
  logDir,
} = {}) {
  let activeRun = null;

  function broadcast(eventName, payload) {
    if (eventHub) eventHub.broadcast(eventName, payload);
  }

  function logEvent(entry) {
    try {
      appendRunLog(logDir, entry);
    } catch (err) {
      // 运行日志写失败不能影响正在进行的运行，只在服务端控制台留痕。
      console.error('[run-controller] 写运行日志失败', err);
    }
  }

  /** 启动一次运行：mode='all' 跑全部启用站点，mode='selected' 跑 siteIds 指定的站点。 */
  function startRun({ mode, siteIds }) {
    if (activeRun) {
      throw new ApiError('RUN_ALREADY_ACTIVE', '已有监控任务正在运行', {
        status: 409,
        extra: { activeRunId: activeRun.runId },
      });
    }

    const sites = resolveSites(db, { mode, siteIds });
    if (sites.length === 0) {
      throw new ApiError('INVALID_SITE_SELECTION', '没有可运行的站点', { status: 422 });
    }

    const runId = randomUUID();
    const startedAt = now();

    // 真实的运行锁：即使内存里没有活动运行（比如面板刚重启），如果 CLI
    // 正在跑（或者上一次面板运行留下了尚未过期的锁），这里会拿不到锁。
    const lock = acquireLock(config.lockPath, { runId, startedAt });
    if (!lock.acquired) {
      const holder = lock.holder || {};
      throw new ApiError(
        'COLLECTOR_LOCKED',
        `已有采集进程正在运行（pid=${holder.pid ?? '?'}, runId=${holder.runId ?? '?'}，起于 ${holder.startedAt ?? '?'}），请稍后再试`,
        { status: 503 },
      );
    }

    const siteOrder = sites.map((s) => s.site_id);
    const sitesById = new Map(
      sites.map((s, i) => [
        s.site_id,
        {
          index: i + 1,
          siteId: s.site_id,
          domain: s.domain || null,
          status: 'waiting',
          complete: null,
          truncated: null,
          pageUrlCount: 0,
          addedUrlCount: 0,
          missingUrlCount: 0,
          consecutiveMissingCount: 0,
          restoredUrlCount: 0,
          comparisonPerformed: null,
          isBaseline: null,
          durationMs: null,
          errorCode: null,
          errorSummary: null,
        },
      ]),
    );

    const run = {
      runId,
      mode,
      startedAt,
      phase: 'preparing',
      cancelRequested: false,
      siteOrder,
      sitesById,
      stats: {
        sitesTotal: sites.length,
        sitesSuccess: 0,
        sitesPartial: 0,
        sitesFailed: 0,
        baselineSiteCount: 0,
        baselineUrlCount: 0,
        addedUrlCount: 0,
        missingUrlCount: 0,
        consecutiveMissingCount: 0,
        restoredUrlCount: 0,
      },
    };
    activeRun = run;

    broadcast('run_started', { runId, mode, siteCount: sites.length, startedAt });
    logEvent({ run_id: runId, event: 'run_started', phase: 'preparing' });

    // 不 await——POST 请求立刻返回，真正的采集/分类/报告在后台异步执行，
    // 不能因为浏览器断开或前端 bug 而中断已经开始的正式采集任务。
    runLifecycle(run, sites).catch((err) => {
      console.error('[run-controller] 运行流程出现未预期的异常', err);
    });

    return { runId, mode, phase: run.phase, siteCount: sites.length };
  }

  async function runLifecycle(run, sites) {
    let reachedClassify = false;
    try {
      setPhase(run, 'collecting');

      const knownSiteIds = new Set(db.prepare('SELECT site_id FROM sites').all().map((r) => r.site_id));
      const { limitOverrides, sitemapOverrides } = loadSiteOverrides(config, { knownSiteIds });

      const collectResult = await runCollect(db, {
        sites,
        runId: run.runId,
        collectSiteFn,
        siteLimitOverrides: limitOverrides,
        siteSitemapOverrides: sitemapOverrides,
        now,
        onEvent: (type, payload) => handleCollectEvent(run, type, payload),
        shouldCancel: () => run.cancelRequested,
      });

      // runCollect 本身不知道"这是不是一次面板发起的选中站点运行"这个
      // Dashboard 概念，运行结束后单独补一次 UPDATE 记录 mode/选中范围
      // （migration 0004 新增的两列），不影响 runCollect 写的其它字段。
      db.prepare('UPDATE crawl_runs SET run_mode = ?, site_selection = ? WHERE run_id = ?').run(
        run.mode,
        run.mode === 'selected' ? JSON.stringify(sites.map((s) => s.site_id)) : null,
        run.runId,
      );
      Object.assign(run.stats, collectResult.stats);

      if (collectResult.cancelled) {
        setPhase(run, 'cancelled');
        broadcast('run_cancelled', { runId: run.runId, stats: { ...run.stats } });
        logEvent({ run_id: run.runId, event: 'run_cancelled', phase: 'cancelled' });
        return;
      }

      reachedClassify = true;
      setPhase(run, 'classifying');
      broadcast('classification_started', { runId: run.runId });
      const classifyResult = await classifyRun(db, { runId: run.runId, fetchPagesFn: classifyFetchPagesFn, now });
      broadcast('classification_finished', {
        runId: run.runId,
        total: classifyResult.total,
        counts: classifyResult.counts,
        classificationErrors: classifyResult.classificationErrors,
      });
      logEvent({ run_id: run.runId, event: 'classification_finished', phase: 'classifying', status: 'success' });

      setPhase(run, 'reporting');
      const report = generateReport(db, { runId: run.runId, outputDir: config.outputDir, now });
      broadcast('report_generated', { runId: run.runId, dir: report.dir, stats: report.stats });
      logEvent({ run_id: run.runId, event: 'report_generated', phase: 'reporting', status: 'success' });

      setPhase(run, 'completed');
      broadcast('run_finished', { runId: run.runId, status: 'completed', stats: { ...run.stats } });
      logEvent({ run_id: run.runId, event: 'run_finished', phase: 'completed', status: 'completed' });
    } catch (err) {
      if (reachedClassify) {
        // 采集阶段已经真实落盘成功；分类/报告阶段出错不能让 crawl_runs
        // 停留在采集阶段写下的 success/partial 状态，那会误导用户以为
        // 整个流程（含分类和报告）都顺利完成了。
        try {
          db.prepare('UPDATE crawl_runs SET status = ? WHERE run_id = ?').run('failed', run.runId);
        } catch {
          // 连这次状态修正都失败：保留原状态，留给用户从日志里排查。
        }
      }
      setPhase(run, 'failed');
      broadcast('run_failed', { runId: run.runId, message: err.message });
      logEvent({ run_id: run.runId, event: 'run_failed', phase: 'failed', status: 'failed', error_code: err.code || 'RUN_FAILED' });
    } finally {
      releaseLock(config.lockPath, run.runId);
      if (activeRun === run) activeRun = null;
    }
  }

  function setPhase(run, phase) {
    run.phase = phase;
    broadcast('run_phase_changed', { runId: run.runId, phase });
  }

  function handleCollectEvent(run, type, payload) {
    if (type === 'site_started') {
      const entry = run.sitesById.get(payload.siteId);
      if (entry) entry.status = 'running';
      broadcast('site_started', payload);
      return;
    }
    if (type === 'sitemap_discovered') {
      broadcast('sitemap_discovered', payload);
      return;
    }
    if (type === 'site_finished') {
      const entry = run.sitesById.get(payload.siteId);
      if (entry) {
        Object.assign(entry, {
          status: payload.status,
          complete: payload.complete,
          truncated: payload.truncated,
          pageUrlCount: payload.pageUrlCount,
          addedUrlCount: payload.addedUrlCount,
          missingUrlCount: payload.missingUrlCount,
          consecutiveMissingCount: payload.consecutiveMissingCount,
          restoredUrlCount: payload.restoredUrlCount,
          comparisonPerformed: payload.comparisonPerformed,
          isBaseline: payload.isBaseline,
          durationMs: payload.durationMs,
          errorCode: payload.errorCode,
          errorSummary: payload.errorSummary,
        });
      }
      // 增量更新运行级统计，让"实时运行"页面在采集过程中就能看到滚动更新
      // 的成功/partial/失败计数，不用等整轮 runCollect() 返回才有数字。
      // 分桶规则和 collect-runner.js 内部完全一致：site_finished 的
      // status==='success' 一定来自"已准入"分支（这是 collect-runner.js
      // 唯一会发出这个字面量状态的地方），其余一律按 failed/partial 二分。
      if (payload.status === 'success') {
        run.stats.sitesSuccess++;
        if (payload.isBaseline) {
          run.stats.baselineSiteCount++;
          run.stats.baselineUrlCount += payload.pageUrlCount;
        }
      } else if (payload.status === 'failed') {
        run.stats.sitesFailed++;
      } else {
        run.stats.sitesPartial++;
      }
      run.stats.addedUrlCount += payload.addedUrlCount || 0;
      run.stats.missingUrlCount += payload.missingUrlCount || 0;
      run.stats.consecutiveMissingCount += payload.consecutiveMissingCount || 0;
      run.stats.restoredUrlCount += payload.restoredUrlCount || 0;
      broadcast('site_finished', payload);
      logEvent({
        run_id: run.runId,
        event: 'site_finished',
        site_id: payload.siteId,
        phase: run.phase,
        status: payload.status,
        duration_ms: payload.durationMs,
        error_code: payload.errorCode,
      });
    }
  }

  /** 请求安全停止：协作式取消，不杀进程、不强制中断当前正在处理的站点。 */
  function cancelRun(runId) {
    if (activeRun && activeRun.runId === runId) {
      if (!activeRun.cancelRequested) {
        activeRun.cancelRequested = true;
        broadcast('run_cancel_requested', { runId });
        logEvent({ run_id: runId, event: 'run_cancel_requested', phase: activeRun.phase });
      }
      // 重复取消幂等：不管是不是第一次调用，都返回当前状态，不报错。
      return { runId, phase: activeRun.phase, cancelRequested: true };
    }

    const row = db.prepare('SELECT run_id, finished_at FROM crawl_runs WHERE run_id = ?').get(runId);
    if (!row) throw new ApiError('RUN_NOT_FOUND', `找不到运行: ${runId}`, { status: 404 });
    if (row.finished_at) throw new ApiError('RUN_ALREADY_FINISHED', '该运行已经结束，无法取消', { status: 409 });
    // 存在且 finished_at 为空，但不是内存里的活动运行——服务重启后遗留的
    // "异常中断"记录，没有真正在跑的进程可以响应取消请求。
    throw new ApiError('RUN_CANCEL_NOT_ALLOWED', '该运行当前不在本面板进程中活动，无法取消（可能是服务重启前遗留的运行）', {
      status: 409,
    });
  }

  /** GET /api/runs/active：没有活动运行时返回 null。不含逐站表格（见 getRunSites）。 */
  function getActiveSnapshot() {
    if (!activeRun) return null;
    const sitesCompleted = activeRun.siteOrder.filter((id) => TERMINAL_SITE_STATUSES.has(activeRun.sitesById.get(id).status)).length;
    return {
      runId: activeRun.runId,
      mode: activeRun.mode,
      phase: activeRun.phase,
      cancelRequested: activeRun.cancelRequested,
      startedAt: activeRun.startedAt,
      stats: { ...activeRun.stats, sitesCompleted },
    };
  }

  /** GET /api/runs/:run_id/sites：活动运行给内存实时表（含 waiting/running）；结束后回落到 SQLite。 */
  function getRunSites(runId) {
    if (activeRun && activeRun.runId === runId) {
      return activeRun.siteOrder.map((id) => ({ ...activeRun.sitesById.get(id) }));
    }
    const rows = db
      .prepare(
        `SELECT scr.site_id, s.domain, scr.status, scr.complete, scr.truncated,
                scr.page_url_count, scr.added_url_count,
                scr.missing_url_count, scr.consecutive_missing_count, scr.restored_url_count, scr.comparison_performed,
                scr.duration_ms, scr.error_summary
         FROM site_crawl_runs scr LEFT JOIN sites s ON s.site_id = scr.site_id
         WHERE scr.run_id = ? ORDER BY scr.site_id ASC`,
      )
      .all(runId);
    return rows.map((r, i) => ({
      index: i + 1,
      siteId: r.site_id,
      domain: r.domain || null,
      status: r.status,
      complete: !!r.complete,
      truncated: !!r.truncated,
      pageUrlCount: r.page_url_count,
      addedUrlCount: r.added_url_count,
      missingUrlCount: r.missing_url_count,
      consecutiveMissingCount: r.consecutive_missing_count,
      restoredUrlCount: r.restored_url_count,
      comparisonPerformed: !!r.comparison_performed,
      // 运行结束、内存态清空后，"这一站是不是本次 baseline"这个标记不再
      // 持久化（site_crawl_runs 没有这一列）——只在运行进行中通过内存态
      // 提供，历史查询统一返回 null，不猜测。
      isBaseline: null,
      durationMs: r.duration_ms,
      errorCode: null,
      errorSummary: r.error_summary,
    }));
  }

  function isRunKnown(runId) {
    if (activeRun && activeRun.runId === runId) return true;
    return !!db.prepare('SELECT 1 FROM crawl_runs WHERE run_id = ?').get(runId);
  }

  return { startRun, cancelRun, getActiveSnapshot, getRunSites, isRunKnown };
}

/** 根据 mode 解析出这次运行要跑的站点行；siteIds 存在性/启用性都以当前 DB 为准。 */
function resolveSites(db, { mode, siteIds }) {
  if (mode === 'all') {
    return db.prepare('SELECT * FROM sites WHERE enabled = 1 ORDER BY site_id ASC').all();
  }

  // mode === 'selected'：siteIds 已经在路由层做过数组/长度/去重等格式校验，
  // 这里只做"当前 DB 里到底存不存在/是否启用"这类和实时状态相关的校验——
  // 不复用路由层传来的假设，因为两次请求之间站点状态可能已经变了。
  const allSites = db.prepare('SELECT * FROM sites').all();
  const bySiteId = new Map(allSites.map((s) => [s.site_id, s]));
  const missing = siteIds.filter((id) => !bySiteId.has(id));
  if (missing.length) {
    throw new ApiError('SITE_NOT_FOUND', `以下站点不存在: ${missing.join(', ')}`, { status: 404 });
  }
  const disabled = siteIds.filter((id) => !bySiteId.get(id).enabled);
  if (disabled.length) {
    throw new ApiError('SITE_DISABLED', `以下站点已暂停，不能加入本次运行: ${disabled.join(', ')}`, { status: 422 });
  }
  return siteIds.map((id) => bySiteId.get(id));
}
