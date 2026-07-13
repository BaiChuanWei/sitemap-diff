import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

export const SITES_CSV_HEADERS = [
  'site_id',
  'domain',
  'priority',
  'enabled',
  'robots_url',
  'sitemap_url',
  'expected_game_path',
  'notes',
];

/**
 * 加载本地配置：SQLite 数据库路径、站点清单 CSV 路径、报告输出目录。
 * 全部支持通过 overrides 覆盖，方便测试用临时目录。
 */
export function loadLocalConfig(overrides = {}) {
  return {
    dbPath: overrides.dbPath || resolve(projectRoot, 'data', 'local.db'),
    sitesCsvPath: overrides.sitesCsvPath || resolve(projectRoot, 'config', 'sites.example.csv'),
    outputDir: overrides.outputDir || resolve(projectRoot, 'output'),
    lockPath: overrides.lockPath || resolve(projectRoot, 'data', 'collector.lock'),
  };
}

/**
 * 解析站点清单 CSV 文本为记录数组。
 * 支持双引号包裹的字段（含逗号、含转义双引号 ""），满足本地配置文件的常见写法。
 */
export function parseSitesCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return [];

  const [headerLine, ...rows] = lines;
  const headers = splitCsvLine(headerLine).map((h) => h.trim());

  return rows.map((line) => {
    const cells = splitCsvLine(line);
    const record = {};
    headers.forEach((header, i) => {
      record[header] = (cells[i] ?? '').trim();
    });
    return record;
  });
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}
