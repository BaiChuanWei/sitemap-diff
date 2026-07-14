import { randomUUID } from 'node:crypto';
import { diagnoseSite } from '../../diagnose.js';
import { loadSiteOverrides, parseCsvWithHeaders } from '../../config.js';
import { readFileSync, existsSync } from 'node:fs';
import { ApiError } from './sites-write.js';

/**
 * 诊断任务的进程内注册表：POST 发起诊断拿到 diagnostic_id，GET 轮询结果。
 * 只保存在内存里——诊断本来就是"重新点一次就能再跑"的只读操作，不需要
 * 跨服务重启持久化；浏览器刷新页面不会重启服务进程，内存态足够。
 */
const registry = new Map(); // diagnostic_id -> { status, site_id, startedAt, finishedAt, result, error }
const inFlightBySite = new Map(); // site_id -> diagnostic_id，防止同站重复诊断

export function startDiagnosis(config, siteId, { fetchImpl } = {}) {
  if (inFlightBySite.has(siteId)) {
    const existingId = inFlightBySite.get(siteId);
    throw new ApiError('DIAGNOSIS_IN_PROGRESS', `站点 ${siteId} 已经有一个诊断正在进行`, {
      status: 409,
      fieldErrors: { diagnostic_id: existingId },
    });
  }

  if (!existsSync(config.sitesCsvPath)) {
    throw new ApiError('SITE_NOT_FOUND', '站点清单不存在', { status: 404 });
  }
  const { rows } = parseCsvWithHeaders(readFileSync(config.sitesCsvPath, 'utf-8'));
  const site = rows.find((r) => r.site_id === siteId);
  if (!site) throw new ApiError('SITE_NOT_FOUND', `站点不存在: ${siteId}`, { status: 404 });

  const diagnosticId = randomUUID();
  const entry = { diagnosticId, siteId, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null };
  registry.set(diagnosticId, entry);
  inFlightBySite.set(siteId, diagnosticId);

  const knownSiteIds = new Set(rows.map((r) => r.site_id));
  const { limitOverrides, sitemapOverrides } = loadSiteOverrides(config, { knownSiteIds });

  // 诊断本身可能耗时数十秒（大站点），不阻塞 HTTP 响应——异步执行，
  // 调用方立刻拿到 diagnostic_id 去轮询。单个诊断失败只影响它自己的
  // registry 条目，不会抛到未捕获异常里影响面板服务本身。
  diagnoseSite({ site, limitOverrides, sitemapOverrides, fetchImpl })
    .then((result) => {
      entry.status = 'done';
      entry.result = result;
      entry.finishedAt = new Date().toISOString();
    })
    .catch((err) => {
      entry.status = 'failed';
      entry.error = err.message;
      entry.finishedAt = new Date().toISOString();
    })
    .finally(() => {
      inFlightBySite.delete(siteId);
    });

  return { diagnosticId, status: entry.status };
}

export function getDiagnosis(diagnosticId) {
  const entry = registry.get(diagnosticId);
  if (!entry) throw new ApiError('DIAGNOSTIC_NOT_FOUND', `找不到诊断结果: ${diagnosticId}`, { status: 404 });
  return entry;
}

/** 测试专用：清空注册表，避免测试之间互相污染"同站重复诊断"状态。 */
export function _resetDiagnosisRegistryForTests() {
  registry.clear();
  inFlightBySite.clear();
}
