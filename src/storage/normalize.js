import { createHash } from 'node:crypto';

/**
 * 保守的 URL 标准化（Milestone 3 第一版）。
 *
 * 只做以下最小、无损的规范化：
 *   - trim 前后空白；
 *   - 协议、主机名小写（WHATWG URL 已经保证）；
 *   - 删除 fragment（#... 不影响页面身份）；
 *   - 默认端口归一化（http:80 / https:443 会被 URL 自动去掉）；
 *   - 保留路径大小写；
 *   - 保留全部查询参数（不删除任何 tracking 参数，避免误合并不同页面）；
 *   - 不自动增删尾部斜杠、不合并不同尾部路径。
 *
 * 目的是：不同的页面绝不能被标准化成同一个 URL。宁可少合并，不可错合并。
 *
 * 非法 URL 抛错，由调用方决定如何处理（本项目里页面 URL 已经在采集阶段
 * 校验过是合法 http(s) URL，这里再兜底一层）。
 */
export function normalizeUrl(rawUrl) {
  const trimmed = String(rawUrl).trim();
  const u = new URL(trimmed); // 非 http(s) 或非法会抛错
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`不是 http(s) URL: ${rawUrl}`);
  }
  u.hash = '';
  return u.href;
}

/** 基于 normalized URL 生成稳定哈希（sha256 hex），作为 (site_id, url_hash) 去重键。 */
export function urlHash(normalizedUrl) {
  return createHash('sha256').update(normalizedUrl).digest('hex');
}

/**
 * 把一个原始页面 URL 转成 { originalUrl, normalizedUrl, urlHash }。
 * 标准化失败时返回 null，调用方可选择跳过（但采集阶段已保证是合法 URL）。
 */
export function toUrlRecord(rawUrl) {
  let normalizedUrl;
  try {
    normalizedUrl = normalizeUrl(rawUrl);
  } catch {
    return null;
  }
  return {
    originalUrl: String(rawUrl).trim(),
    normalizedUrl,
    urlHash: urlHash(normalizedUrl),
  };
}
