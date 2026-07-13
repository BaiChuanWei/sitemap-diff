/** HTTP/网络层错误：超时、重试耗尽、重定向超限、响应过大、Gzip 解压失败等。 */
export class SitemapFetchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SitemapFetchError';
    this.code = code;
  }
}

/** XML 解析层错误：格式无效、根元素未知。 */
export class SitemapParseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SitemapParseError';
    this.code = code;
  }
}

export const FETCH_ERROR_CODES = Object.freeze({
  TIMEOUT: 'TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  HTTP_ERROR: 'HTTP_ERROR',
  TOO_MANY_REDIRECTS: 'TOO_MANY_REDIRECTS',
  RESPONSE_TOO_LARGE: 'RESPONSE_TOO_LARGE',
  GZIP_DECOMPRESS_FAILED: 'GZIP_DECOMPRESS_FAILED',
  GZIP_TOO_LARGE: 'GZIP_TOO_LARGE',
});

export const PARSE_ERROR_CODES = Object.freeze({
  INVALID_XML: 'INVALID_XML',
  UNKNOWN_ROOT: 'UNKNOWN_ROOT',
});

export const LOADER_ERROR_CODES = Object.freeze({
  MAX_DEPTH_EXCEEDED: 'MAX_DEPTH_EXCEEDED',
  MAX_SITEMAPS_EXCEEDED: 'MAX_SITEMAPS_EXCEEDED',
  CIRCULAR_REFERENCE: 'CIRCULAR_REFERENCE',
});
