import { isIP } from 'node:net';
import { LIMIT_FIELD_MAP, validateLimitFieldValue } from '../site-overrides.js';

/**
 * Dashboard M2：站点配置写入的字段级校验，供 API 层调用。所有规则集中在
 * 这一个文件里，CSV 解析路径（site-overrides.js）和 JSON API 写入路径
 * 共用同一份限制值校验（validateLimitFieldValue），不允许出现两套规则。
 */

export class ValidationError extends Error {
  constructor(message, fieldErrors = {}) {
    super(message);
    this.name = 'ValidationError';
    this.fieldErrors = fieldErrors;
  }
}

function fieldError(field, message) {
  return new ValidationError(message, { [field]: message });
}

export const SITE_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function validateSiteId(value) {
  if (typeof value !== 'string' || !SITE_ID_REGEX.test(value)) {
    throw fieldError(
      'site_id',
      'site_id 只能包含小写字母、数字、下划线、连字符，必须以字母或数字开头，长度 1-64',
    );
  }
  return value;
}

// ---- SSRF 防护：拒绝本机/内网/链路本地地址 ----
// 已知局限（详见 docs/dashboard-threat-model.md "SSRF 残余风险"章节）：
// 这里只在保存配置时对字面量 IP / 明显的本机域名做静态检查，不做 DNS
// 解析，因此无法防御"域名此刻解析到公网 IP、之后又改解析到内网 IP"或
// "请求过程中发生 DNS rebinding"这类运行时攻击；也不检查 Sitemap 抓取
// 过程中的 HTTP 重定向目标。真正杜绝这类风险需要在网络层（fetcher.js）
// 对每次实际连接前的已解析 IP 做校验，这是一次远超本里程碑范围的架构
// 改动，本阶段不实现，作为已知残余风险记录。

const PRIVATE_IPV4_RANGES = [
  [0, 0, 0, 0, 8], // "this network"
  [10, 0, 0, 0, 8], // RFC1918
  [100, 64, 0, 0, 10], // CGNAT shared address space
  [127, 0, 0, 0, 8], // loopback
  [169, 254, 0, 0, 16], // link-local，含云元数据 169.254.169.254
  [172, 16, 0, 0, 12], // RFC1918
  [192, 168, 0, 0, 16], // RFC1918
];

function ipv4ToInt(a, b, c, d) {
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
  const val = ipv4ToInt(...parts);
  return PRIVATE_IPV4_RANGES.some(([a, b, c, d, bits]) => {
    const rangeVal = ipv4ToInt(a, b, c, d);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (val & mask) === (rangeVal & mask);
  });
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return true; // fc00::/7 唯一本地地址
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 链路本地
  const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

/** 判断一个 hostname（域名或 IP 字面量）是否指向本机/内网/链路本地地址。 */
export function isPrivateOrLoopbackHost(hostname) {
  const lower = hostname.toLowerCase().replace(/\.$/, '');
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local')) return true;

  const version = isIP(hostname);
  if (version === 4) return isPrivateIPv4(hostname);
  if (version === 6) return isPrivateIPv6(hostname);
  return false;
}

const DOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * 校验并规范化 domain 字段：只保存纯域名（不含协议/路径/端口/参数）。
 * 明确决定：不允许非标准端口——domain 字段假定就是 https://<domain> 的
 * 主机名，带端口会破坏这个既有假设（collect-runner.js 等处都是这样拼
 * baseUrl 的），因此直接拒绝。
 */
export function validateDomain(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw fieldError('domain', '域名不能为空');
  }
  const value = raw.trim();
  if (/[:/?#\s]/.test(value)) {
    throw fieldError('domain', '域名不能包含协议、端口、路径、参数或空格，只能是纯域名，例如 example.com');
  }
  const normalized = value.toLowerCase().replace(/\.$/, '');
  if (isPrivateOrLoopbackHost(normalized)) {
    throw fieldError('domain', '不允许使用本机地址、内网地址或链路本地地址作为域名');
  }
  if (isIP(normalized) === 0 && !DOMAIN_REGEX.test(normalized)) {
    throw fieldError('domain', '域名格式不正确');
  }
  return normalized;
}

/**
 * 校验 Sitemap/robots URL 类字段：只允许 http(s)，拒绝本机/内网/链路本地
 * 主机名（见上方"SSRF 防护"的已知局限说明）。
 */
export function validateHttpUrlField(raw, fieldName) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw fieldError(fieldName, `${fieldName} 不能为空`);
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw fieldError(fieldName, `${fieldName} 不是合法的 URL`);
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw fieldError(fieldName, `${fieldName} 只允许 http/https 协议`);
  }
  if (isPrivateOrLoopbackHost(url.hostname)) {
    throw fieldError(fieldName, `${fieldName} 不允许指向本机、内网或链路本地地址`);
  }
  return url.toString();
}

/** 同上，但允许空值（可选字段）。 */
export function validateOptionalHttpUrlField(raw, fieldName) {
  if (raw === undefined || raw === null || raw === '') return '';
  return validateHttpUrlField(raw, fieldName);
}

const PRIORITIES = new Set(['high', 'medium', 'low']);

export function validatePriority(value) {
  if (value === undefined || value === null || value === '') return 'medium';
  if (!PRIORITIES.has(value)) {
    throw fieldError('priority', 'priority 只能是 high / medium / low 之一');
  }
  return value;
}

export function validateEnabled(value) {
  if (typeof value !== 'boolean') {
    throw fieldError('enabled', 'enabled 只接受布尔值 true/false，不接受字符串');
  }
  return value;
}

/**
 * 校验站点新增/编辑的输入。knownSiteIds/knownDomains 用于唯一性检查，
 * isCreate=true 时 site_id 是必填且必须全新；isCreate=false（编辑）时
 * 不校验/不允许修改 site_id（调用方不应该把 site_id 传进 body）。
 */
export function validateSiteInput(input, { isCreate, knownSiteIds, knownDomains, currentSiteId } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('请求体必须是一个 JSON 对象');
  }

  const allowedFields = new Set([
    'site_id',
    'domain',
    'priority',
    'enabled',
    'robots_url',
    'sitemap_url',
    'expected_game_path',
    'notes',
    'site_category',
  ]);
  const unknown = Object.keys(input).filter((k) => !allowedFields.has(k));
  if (unknown.length > 0) {
    throw new ValidationError(`未知字段: ${unknown.join(', ')}`, Object.fromEntries(unknown.map((f) => [f, '未知字段'])));
  }

  const fieldErrors = {};
  const result = {};

  if (isCreate) {
    try {
      result.site_id = validateSiteId(input.site_id);
      if (knownSiteIds && knownSiteIds.has(result.site_id)) {
        throw fieldError('site_id', 'site_id 已存在');
      }
    } catch (err) {
      Object.assign(fieldErrors, err.fieldErrors);
    }
  } else if ('site_id' in input && input.site_id !== currentSiteId) {
    fieldErrors.site_id = 'site_id 不可修改（关联 SQLite baseline 与历史，重命名需要单独的迁移功能）';
  }

  try {
    result.domain = validateDomain(input.domain);
    if (knownDomains && knownDomains.has(result.domain) && knownDomains.get(result.domain) !== currentSiteId) {
      fieldErrors.domain = '该域名已被其它站点使用';
    }
  } catch (err) {
    Object.assign(fieldErrors, err.fieldErrors);
  }

  try {
    result.priority = validatePriority(input.priority);
  } catch (err) {
    Object.assign(fieldErrors, err.fieldErrors);
  }

  try {
    result.enabled = input.enabled === undefined ? true : validateEnabled(input.enabled);
  } catch (err) {
    Object.assign(fieldErrors, err.fieldErrors);
  }

  try {
    result.robots_url = input.robots_url !== undefined ? validateOptionalHttpUrlField(input.robots_url, 'robots_url') : '';
  } catch (err) {
    Object.assign(fieldErrors, err.fieldErrors);
  }

  try {
    result.sitemap_url = input.sitemap_url !== undefined ? validateOptionalHttpUrlField(input.sitemap_url, 'sitemap_url') : '';
  } catch (err) {
    Object.assign(fieldErrors, err.fieldErrors);
  }

  result.expected_game_path = typeof input.expected_game_path === 'string' ? input.expected_game_path : '';
  result.notes = typeof input.notes === 'string' ? input.notes : '';
  result.site_category = typeof input.site_category === 'string' ? input.site_category : '';

  if (Object.keys(fieldErrors).length > 0) {
    throw new ValidationError('站点配置校验失败', fieldErrors);
  }
  return result;
}

/** 校验站点级限制输入（JSON body：6 个可选字段），复用 site-overrides.js 的单字段规则。 */
export function validateLimitsInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('请求体必须是一个 JSON 对象');
  }
  const allowedFields = new Set(Object.keys(LIMIT_FIELD_MAP));
  const unknown = Object.keys(input).filter((k) => !allowedFields.has(k));
  if (unknown.length > 0) {
    throw new ValidationError(`未知字段: ${unknown.join(', ')}`, Object.fromEntries(unknown.map((f) => [f, '未知字段'])));
  }

  const fieldErrors = {};
  const result = {};
  for (const csvField of Object.keys(LIMIT_FIELD_MAP)) {
    const raw = input[csvField];
    if (raw === undefined || raw === null || raw === '') {
      result[csvField] = '';
      continue;
    }
    try {
      validateLimitFieldValue(csvField, raw);
      result[csvField] = String(raw);
    } catch (err) {
      fieldErrors[csvField] = err.message;
    }
  }
  if (Object.keys(fieldErrors).length > 0) {
    throw new ValidationError('站点限制校验失败', fieldErrors);
  }
  return result;
}

/** 校验手工 Sitemap 输入（JSON body：{ mode, urls: [{sitemap_url, enabled, notes}] }）。 */
export function validateSitemapsInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('请求体必须是一个 JSON 对象');
  }
  const { mode, urls } = input;
  if (mode !== undefined && mode !== 'merge' && mode !== 'manual_only') {
    throw fieldError('mode', 'mode 只能是 merge 或 manual_only');
  }
  if (urls !== undefined && !Array.isArray(urls)) {
    throw fieldError('urls', 'urls 必须是数组');
  }

  const fieldErrors = {};
  const seen = new Set();
  const normalizedUrls = [];
  let enabledCount = 0;

  for (const [i, entry] of (urls || []).entries()) {
    if (!entry || typeof entry !== 'object') {
      fieldErrors[`urls[${i}]`] = '每一项必须是对象';
      continue;
    }
    let normalizedUrl;
    try {
      normalizedUrl = validateHttpUrlField(entry.sitemap_url, `urls[${i}].sitemap_url`);
    } catch (err) {
      Object.assign(fieldErrors, err.fieldErrors);
      continue;
    }
    if (seen.has(normalizedUrl)) continue; // 去重，不报错——重复 Endpoint 静默合并
    seen.add(normalizedUrl);
    const enabled = entry.enabled !== false;
    if (enabled) enabledCount++;
    normalizedUrls.push({
      sitemap_url: normalizedUrl,
      enabled,
      notes: typeof entry.notes === 'string' ? entry.notes : '',
    });
  }

  if (mode === 'manual_only' && enabledCount === 0) {
    fieldErrors.mode = 'manual_only 模式下必须至少有一个已启用且合法的手工 Sitemap Endpoint';
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new ValidationError('手工 Sitemap 校验失败', fieldErrors);
  }

  return { mode: mode || 'merge', urls: normalizedUrls };
}
