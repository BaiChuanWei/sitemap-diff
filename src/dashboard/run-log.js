import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');

/**
 * 运行事件结构化日志：logs/dashboard-runs.jsonl，每行一条 JSON。
 * 只记录 timestamp/run_id/event/site_id/phase/status/duration/error_code
 * 这些字段，绝不写入 CSRF token、完整 HTML、完整 URL 列表、请求 Header。
 *
 * 调用方（run-controller.js）负责在自己的调用点用 try/catch 包住，日志写
 * 失败绝不能影响正在进行的采集/分类/报告——这里保持和 appendAuditLog 一样
 * 的"失败就抛错"的简单实现，把"要不要吞掉错误"的决定留给调用方。
 */
export function appendRunLog(logDir, entry) {
  const dir = logDir || join(projectRoot, 'logs');
  mkdirSync(dir, { recursive: true });
  const safeEntry = {
    timestamp: new Date().toISOString(),
    run_id: entry.run_id ?? null,
    event: entry.event,
    site_id: entry.site_id ?? null,
    phase: entry.phase ?? null,
    status: entry.status ?? null,
    duration_ms: entry.duration_ms ?? null,
    error_code: entry.error_code ?? null,
  };
  appendFileSync(join(dir, 'dashboard-runs.jsonl'), JSON.stringify(safeEntry) + '\n', 'utf-8');
  return safeEntry;
}
