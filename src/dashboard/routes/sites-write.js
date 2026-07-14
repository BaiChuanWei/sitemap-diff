import { join } from 'node:path';
import {
  validateSiteInput,
  validateEnabled,
  validateLimitsInput,
  validateSitemapsInput,
  ValidationError,
} from '../validation.js';
import { writeConfig, loadConfigSnapshot, ConfigVersionConflictError, ConfigLockedError } from '../config-store.js';
import { appendAuditLog } from '../audit-log.js';
import { LIMIT_FIELD_MAP, SITE_LIMITS_CSV_HEADERS, SITE_SITEMAPS_CSV_HEADERS } from '../../site-overrides.js';

/** 应用错误：携带一个语义化的错误码，供路由层映射 HTTP 状态码。 */
export class ApiError extends Error {
  constructor(code, message, { status, fieldErrors } = {}) {
    super(message);
    this.code = code;
    this.status = status || 500;
    this.fieldErrors = fieldErrors;
  }
}

function toApiError(err) {
  if (err instanceof ApiError) return err;
  if (err instanceof ValidationError) {
    return new ApiError('VALIDATION_ERROR', err.message, { status: 422, fieldErrors: err.fieldErrors });
  }
  if (err instanceof ConfigVersionConflictError) {
    return new ApiError('CONFIG_VERSION_CONFLICT', err.message, { status: 409 });
  }
  if (err instanceof ConfigLockedError) {
    return new ApiError('CONFIG_LOCKED', err.message, { status: 503 });
  }
  if (err.code === 'SYNC_SITES_FAILED' || err.code === 'CONFIG_WRITE_FAILED' || err.code === 'CONFIG_WRITE_VERIFY_FAILED') {
    return new ApiError(err.code, err.message, { status: 500 });
  }
  return new ApiError('INTERNAL_ERROR', err.message, { status: 500 });
}

function buildKnownIndexes(sitesRows) {
  const knownSiteIds = new Set(sitesRows.map((r) => r.site_id));
  const knownDomains = new Map(sitesRows.map((r) => [r.domain?.toLowerCase(), r.site_id]));
  return { knownSiteIds, knownDomains };
}

/** POST /api/sites：新增站点。 */
export function createSite(db, config, body, { expectedConfigVersion, auditLogDir } = {}) {
  try {
    const before = loadConfigSnapshot(config);
    const { knownSiteIds, knownDomains } = buildKnownIndexes(before.sites.rows);
    const validated = validateSiteInput(body, { isCreate: true, knownSiteIds, knownDomains });

    const result = writeConfig(config, {
      expectedConfigVersion,
      db,
      mutate: (snap) => ({
        sites: {
          headers: snap.sites.headers,
          rows: [
            ...snap.sites.rows,
            {
              site_id: validated.site_id,
              domain: validated.domain,
              priority: validated.priority,
              enabled: String(validated.enabled),
              robots_url: validated.robots_url,
              sitemap_url: validated.sitemap_url,
              expected_game_path: validated.expected_game_path,
              notes: validated.notes,
              site_category: validated.site_category,
            },
          ],
        },
      }),
    });

    appendAuditLog(auditLogDir, {
      action: 'create_site',
      site_id: validated.site_id,
      changed_fields: Object.keys(validated),
      result: 'success',
      configVersionBefore: before.configVersion,
      configVersionAfter: result.configVersion,
    });

    return { site: validated, configVersion: result.configVersion };
  } catch (err) {
    appendAuditLog(auditLogDir, {
      action: 'create_site',
      site_id: body?.site_id ?? null,
      result: 'failed',
      errorCode: err.code || 'VALIDATION_ERROR',
    });
    throw toApiError(err);
  }
}

/** PATCH /api/sites/:site_id：编辑站点（site_id 本身不可修改）。 */
export function updateSite(db, config, siteId, body, { expectedConfigVersion, auditLogDir } = {}) {
  try {
    const before = loadConfigSnapshot(config);
    const existingRow = before.sites.rows.find((r) => r.site_id === siteId);
    if (!existingRow) throw new ApiError('SITE_NOT_FOUND', `站点不存在: ${siteId}`, { status: 404 });

    const { knownDomains } = buildKnownIndexes(before.sites.rows);
    // 故意不删除 body 里可能带的 site_id——交给 validateSiteInput 检查
    // "是否尝试修改 site_id"，删掉的话这个尝试会被静默丢弃而不是报错拒绝。
    const merged = { ...rowToInput(existingRow), ...body };
    const validated = validateSiteInput(merged, { isCreate: false, knownDomains, currentSiteId: siteId });

    const result = writeConfig(config, {
      expectedConfigVersion,
      db,
      mutate: (snap) => ({
        sites: {
          headers: snap.sites.headers,
          rows: snap.sites.rows.map((r) =>
            r.site_id === siteId
              ? {
                  ...r,
                  domain: validated.domain,
                  priority: validated.priority,
                  enabled: String(validated.enabled),
                  robots_url: validated.robots_url,
                  sitemap_url: validated.sitemap_url,
                  expected_game_path: validated.expected_game_path,
                  notes: validated.notes,
                  site_category: validated.site_category,
                }
              : r,
          ),
        },
      }),
    });

    appendAuditLog(auditLogDir, {
      action: 'update_site',
      site_id: siteId,
      changed_fields: Object.keys(body || {}),
      result: 'success',
      configVersionBefore: before.configVersion,
      configVersionAfter: result.configVersion,
    });

    return { site: { site_id: siteId, ...validated }, configVersion: result.configVersion };
  } catch (err) {
    appendAuditLog(auditLogDir, { action: 'update_site', site_id: siteId, result: 'failed', errorCode: err.code || 'VALIDATION_ERROR' });
    throw toApiError(err);
  }
}

function rowToInput(row) {
  return {
    domain: row.domain,
    priority: row.priority || 'medium',
    enabled: row.enabled === 'true' || row.enabled === '1',
    robots_url: row.robots_url || '',
    sitemap_url: row.sitemap_url || '',
    expected_game_path: row.expected_game_path || '',
    notes: row.notes || '',
    site_category: row.site_category || '',
  };
}

/** POST /api/sites/:site_id/enable 或 /disable：只改 enabled 字段（"暂停监控"，绝不删除历史）。 */
export function setSiteEnabled(db, config, siteId, enabled, { expectedConfigVersion, auditLogDir } = {}) {
  validateEnabled(enabled);
  return updateSite(db, config, siteId, { enabled }, { expectedConfigVersion, auditLogDir });
}

/** GET /api/sites/:site_id：合并 CSV 配置 + SQLite 运行状态。 */
export function getSiteDetail(db, config, siteId) {
  const snap = loadConfigSnapshot(config);
  const row = snap.sites.rows.find((r) => r.site_id === siteId);
  if (!row) throw new ApiError('SITE_NOT_FOUND', `站点不存在: ${siteId}`, { status: 404 });

  const dbRow = db.prepare('SELECT * FROM sites WHERE site_id = ?').get(siteId);
  const limitsRow = snap.limits.rows.find((r) => r.site_id === siteId) || null;
  const sitemapRows = snap.sitemaps.rows.filter((r) => r.site_id === siteId);

  return {
    config: row,
    runtime: dbRow || null,
    limits: limitsRow,
    sitemaps: sitemapRows,
    configVersion: snap.configVersion,
  };
}

/** GET /api/sites/:site_id/limits */
export function getSiteLimits(config, siteId) {
  const snap = loadConfigSnapshot(config);
  const row = snap.limits.rows.find((r) => r.site_id === siteId);
  const values = {};
  for (const field of Object.keys(LIMIT_FIELD_MAP)) values[field] = row?.[field] || '';
  return { values, configVersion: snap.configVersion };
}

/** PUT /api/sites/:site_id/limits */
export function putSiteLimits(config, siteId, body, { expectedConfigVersion, auditLogDir } = {}) {
  try {
    const before = loadConfigSnapshot(config);
    if (!before.sites.rows.some((r) => r.site_id === siteId)) {
      throw new ApiError('SITE_NOT_FOUND', `站点不存在: ${siteId}`, { status: 404 });
    }
    const validated = validateLimitsInput(body);
    const hasAnyValue = Object.values(validated).some((v) => v !== '');

    const result = writeConfig(config, {
      expectedConfigVersion,
      mutate: (snap) => {
        const others = snap.limits.rows.filter((r) => r.site_id !== siteId);
        const headers = snap.limits.headers.length ? snap.limits.headers : SITE_LIMITS_CSV_HEADERS;
        const newRow = { site_id: siteId, ...validated };
        return { limits: { headers, rows: hasAnyValue ? [...others, newRow] : others } };
      },
    });

    appendAuditLog(auditLogDir, {
      action: 'update_site_limits',
      site_id: siteId,
      changed_fields: Object.keys(body || {}),
      result: 'success',
      configVersionBefore: before.configVersion,
      configVersionAfter: result.configVersion,
    });

    return { values: validated, configVersion: result.configVersion };
  } catch (err) {
    appendAuditLog(auditLogDir, { action: 'update_site_limits', site_id: siteId, result: 'failed', errorCode: err.code || 'VALIDATION_ERROR' });
    throw toApiError(err);
  }
}

/** GET /api/sites/:site_id/sitemaps */
export function getSiteSitemaps(config, siteId) {
  const snap = loadConfigSnapshot(config);
  const rows = snap.sitemaps.rows.filter((r) => r.site_id === siteId);
  const mode = rows[0]?.mode || 'merge';
  return {
    mode,
    urls: rows.map((r) => ({ sitemap_url: r.sitemap_url, enabled: r.enabled === 'true', notes: r.notes || '', verified_at: r.verified_at || '' })),
    configVersion: snap.configVersion,
  };
}

/** PUT /api/sites/:site_id/sitemaps */
export function putSiteSitemaps(config, siteId, body, { expectedConfigVersion, auditLogDir } = {}) {
  try {
    const before = loadConfigSnapshot(config);
    if (!before.sites.rows.some((r) => r.site_id === siteId)) {
      throw new ApiError('SITE_NOT_FOUND', `站点不存在: ${siteId}`, { status: 404 });
    }
    const validated = validateSitemapsInput(body);

    const result = writeConfig(config, {
      expectedConfigVersion,
      mutate: (snap) => {
        const others = snap.sitemaps.rows.filter((r) => r.site_id !== siteId);
        const headers = snap.sitemaps.headers.length ? snap.sitemaps.headers : SITE_SITEMAPS_CSV_HEADERS;
        const nowIso = new Date().toISOString().slice(0, 10);
        const newRows = validated.urls.map((u) => ({
          site_id: siteId,
          sitemap_url: u.sitemap_url,
          enabled: String(u.enabled),
          mode: validated.mode,
          notes: u.notes,
          verified_at: nowIso,
        }));
        return { sitemaps: { headers, rows: [...others, ...newRows] } };
      },
    });

    appendAuditLog(auditLogDir, {
      action: 'update_site_sitemaps',
      site_id: siteId,
      changed_fields: ['mode', 'urls'],
      result: 'success',
      configVersionBefore: before.configVersion,
      configVersionAfter: result.configVersion,
    });

    return { mode: validated.mode, urls: validated.urls, configVersion: result.configVersion };
  } catch (err) {
    appendAuditLog(auditLogDir, { action: 'update_site_sitemaps', site_id: siteId, result: 'failed', errorCode: err.code || 'VALIDATION_ERROR' });
    throw toApiError(err);
  }
}
