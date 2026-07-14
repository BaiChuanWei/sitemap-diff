import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');

/**
 * 配置修改审计日志：logs/config-audit.jsonl，每行一条 JSON。
 * 只记录 timestamp/action/site_id/changed_fields/result/version 前后/
 * errorCode 这些字段，绝不写入 CSRF token、完整请求 Header、API Key 或
 * 配置文件的完整内容。
 */
export function appendAuditLog(logDir, entry) {
  const dir = logDir || join(projectRoot, 'logs');
  mkdirSync(dir, { recursive: true });
  const safeEntry = {
    timestamp: new Date().toISOString(),
    action: entry.action,
    site_id: entry.site_id ?? null,
    changed_fields: entry.changed_fields ?? [],
    result: entry.result,
    configVersionBefore: entry.configVersionBefore ?? null,
    configVersionAfter: entry.configVersionAfter ?? null,
    errorCode: entry.errorCode ?? null,
  };
  appendFileSync(join(dir, 'config-audit.jsonl'), JSON.stringify(safeEntry) + '\n', 'utf-8');
  return safeEntry;
}
