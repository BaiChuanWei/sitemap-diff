import { validateRunStartInput } from '../validation.js';
import { toApiError } from './sites-write.js';
import { appendRunLog } from '../run-log.js';

/**
 * Dashboard M3：运行控制写接口。只做"校验请求体 + 调用 run-controller.js"，
 * 不重新实现任何单实例保护/锁逻辑——那些规则完全在 run-controller.js 里，
 * 这里只负责把 HTTP 层的输入翻译成 run-controller 的调用参数。
 */

/** POST /api/runs */
export function startRunRoute(db, runController, body, { logDir } = {}) {
  try {
    const totalSiteCount = db.prepare('SELECT COUNT(*) n FROM sites').get().n;
    const validated = validateRunStartInput(body, { totalSiteCount });
    return runController.startRun(validated);
  } catch (err) {
    const apiError = toApiError(err);
    try {
      appendRunLog(logDir, { event: 'run_start_rejected', status: 'failed', error_code: apiError.code });
    } catch {
      // 日志失败不影响错误返回
    }
    throw apiError;
  }
}

/** POST /api/runs/:run_id/cancel */
export function cancelRunRoute(runController, runId) {
  try {
    return runController.cancelRun(runId);
  } catch (err) {
    throw toApiError(err);
  }
}
