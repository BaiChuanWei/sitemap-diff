/**
 * 极简 CSV 序列化，满足本地报告需求：正确转义引号、逗号、换行，UTF-8 输出。
 * 不引入第三方依赖。
 */
export function toCsv(headers, rows) {
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCell(row[h])).join(','));
  }
  // 以换行结尾，便于追加和 diff。
  return lines.join('\r\n') + '\r\n';
}

function escapeCell(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/[",\r\n]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
