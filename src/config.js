import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { parseSiteLimitOverrides, parseSiteSitemapOverrides } from './site-overrides.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

function existsFile(path) {
  return existsSync(path);
}

function readFileText(path) {
  return readFileSync(path, 'utf-8');
}

export const SITES_CSV_HEADERS = [
  'site_id',
  'domain',
  'priority',
  'enabled',
  'robots_url',
  'sitemap_url',
  'expected_game_path',
  'notes',
  'site_category',
];

/**
 * 加载本地配置：SQLite 数据库路径、站点清单 CSV 路径、报告输出目录。
 * 全部支持通过 overrides 覆盖，方便测试用临时目录。
 *
 * 默认站点清单是正式的 config/sites.csv（生产用，不提交示例数据）。
 * config/sites.example.csv 只是模板，永远不作为默认路径——避免真实
 * --collect/--inspect-site 在没人注意的情况下悄悄跑在示例数据上。
 */
export function loadLocalConfig(overrides = {}) {
  return {
    dbPath: overrides.dbPath || resolve(projectRoot, 'data', 'local.db'),
    sitesCsvPath: overrides.sitesCsvPath || resolve(projectRoot, 'config', 'sites.csv'),
    outputDir: overrides.outputDir || resolve(projectRoot, 'output'),
    lockPath: overrides.lockPath || resolve(projectRoot, 'data', 'collector.lock'),
    // Milestone 5A-P1：两份都是可选覆盖文件，不存在时等同于"没有任何站点有覆盖"。
    siteLimitsCsvPath: overrides.siteLimitsCsvPath || resolve(projectRoot, 'config', 'site-limits.csv'),
    siteSitemapsCsvPath: overrides.siteSitemapsCsvPath || resolve(projectRoot, 'config', 'site-sitemaps.csv'),
  };
}

/**
 * 加载站点级限制覆盖 + 手工 Sitemap 配置（Milestone 5A-P1）。文件不存在时
 * 返回空 Map（等价于没有任何覆盖），文件存在但内容非法时直接抛错——
 * 拒绝在错误配置下静默使用危险值。
 */
export function loadSiteOverrides(config, { knownSiteIds } = {}) {
  const limitOverrides = existsFile(config.siteLimitsCsvPath)
    ? parseSiteLimitOverrides(parseSitesCsv(readFileText(config.siteLimitsCsvPath)), { knownSiteIds })
    : new Map();
  const sitemapOverrides = existsFile(config.siteSitemapsCsvPath)
    ? parseSiteSitemapOverrides(parseSitesCsv(readFileText(config.siteSitemapsCsvPath)), { knownSiteIds })
    : new Map();
  return { limitOverrides, sitemapOverrides };
}

/**
 * 解析站点清单 CSV 文本为记录数组。
 * 支持双引号包裹的字段（含逗号、含转义双引号 ""、含引号内换行），满足
 * 本地配置文件的常见写法。
 */
export function parseSitesCsv(csvText) {
  const rows = tokenizeCsv(csvText);
  if (rows.length === 0) return [];

  const [headerRow, ...dataRows] = rows;
  const headers = headerRow.map((h) => h.trim());

  return dataRows.map((cells) => {
    const record = {};
    headers.forEach((header, i) => {
      record[header] = (cells[i] ?? '').trim();
    });
    return record;
  });
}

/**
 * 对整段 CSV 文本做引号感知的分词，返回行数组（每行是单元格字符串数组）。
 * 关键点：换行符只有在"不处于引号内"时才代表新的一行——这样引号包裹的
 * 字段内部允许包含真正的换行符，不会被错误地切断成两行。
 * 完全空白的物理行（对应一个只有单一空字符串单元格的行）会被跳过，
 * 保持和历史行为一致（"忽略空行"）。
 */
function tokenizeCsv(csvText) {
  const rows = [];
  let row = [];
  let current = '';
  let inQuotes = false;
  let i = 0;
  const n = csvText.length;

  function endCell() {
    row.push(current);
    current = '';
  }
  function endRow() {
    endCell();
    // 跳过纯空白行（历史行为：连续空行 / 结尾多余换行不产生记录）。
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  }

  while (i < n) {
    const char = csvText[i];
    if (inQuotes) {
      if (char === '"') {
        if (csvText[i + 1] === '"') {
          current += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      current += char;
      i++;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i++;
    } else if (char === ',') {
      endCell();
      i++;
    } else if (char === '\r' && csvText[i + 1] === '\n') {
      endRow();
      i += 2;
    } else if (char === '\n' || char === '\r') {
      endRow();
      i++;
    } else {
      current += char;
      i++;
    }
  }
  // 文本末尾没有以换行结束时，把最后一个单元格/行也收尾。
  if (current !== '' || row.length > 0) endRow();

  return rows;
}

/**
 * 解析 CSV 文本，同时保留原始表头（顺序、列集合）。Dashboard M2 的配置
 * 写回功能需要保留文件原有的列结构，不能假设一份写死的表头列表——
 * 三份配置文件（sites/site-limits/site-sitemaps）表头都不一样，且
 * 未来允许有人手工加列，写回时不应该把这些列丢掉。
 */
export function parseCsvWithHeaders(csvText) {
  const rows = tokenizeCsv(csvText);
  if (rows.length === 0) return { headers: [], rows: [] };

  const [headerRow, ...dataRows] = rows;
  const headers = headerRow.map((h) => h.trim());
  const records = dataRows.map((cells) => {
    const record = {};
    headers.forEach((header, i) => {
      record[header] = (cells[i] ?? '').trim();
    });
    return record;
  });
  return { headers, rows: records };
}

/**
 * 把记录数组序列化回 CSV 文本，按传入的 headers 顺序输出列。
 * 统一走这一个函数做转义（含逗号/双引号/换行的字段自动加引号），
 * Dashboard M2 的配置写入功能禁止手工拼接 CSV 字符串。
 */
export function serializeCsv(headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCsvField(row[h])).join(','));
  }
  return lines.join('\n') + '\n';
}

function escapeCsvField(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

