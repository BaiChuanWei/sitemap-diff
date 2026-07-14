import zlib from 'node:zlib';
import { DEFAULT_LIMITS, RETRYABLE_HTTP_STATUSES, USER_AGENT } from './limits.js';
import { SitemapFetchError, FETCH_ERROR_CODES } from './errors.js';

/**
 * 抓取一个 URL 并返回统一的结构化结果，不抛出预期内的失败（超时、HTTP
 * 错误、重定向超限、响应过大、Gzip 解压失败等），全部体现在返回值里；
 * 只有调用参数本身有问题才会抛异常。
 *
 * 返回：
 * {
 *   ok, httpStatus, contentType, contentEncoding, compressed,
 *   text, errorCode, errorMessage, attempts, finalUrl
 * }
 */
export async function fetchSitemap(url, options = {}) {
  const limits = options.limits || DEFAULT_LIMITS;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sleep = options.sleep || defaultSleep;

  let attempts = 0;
  let lastFailure = { errorCode: FETCH_ERROR_CODES.NETWORK_ERROR, errorMessage: '未知错误', httpStatus: null, contentType: null };

  for (let attempt = 0; attempt <= limits.MAX_RETRIES; attempt++) {
    attempts++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limits.REQUEST_TIMEOUT_MS);

    try {
      const { response, finalUrl } = await fetchFollowingRedirects(url, {
        fetchImpl,
        signal: controller.signal,
        maxRedirects: limits.MAX_REDIRECTS,
      });
      clearTimeout(timer);

      const contentType = response.headers.get('content-type');
      const contentEncoding = response.headers.get('content-encoding');

      if (!response.ok) {
        const retryable = RETRYABLE_HTTP_STATUSES.includes(response.status);
        lastFailure = {
          errorCode: FETCH_ERROR_CODES.HTTP_ERROR,
          errorMessage: `HTTP ${response.status}`,
          httpStatus: response.status,
          contentType,
        };
        if (retryable && attempt < limits.MAX_RETRIES) {
          await sleep(backoffDelayMs(attempt, limits));
          continue;
        }
        return buildResult({ ok: false, attempts, finalUrl, ...lastFailure });
      }

      let raw;
      try {
        raw = await readBodyWithLimit(response, limits.MAX_DOWNLOAD_BYTES);
      } catch (err) {
        // 只有 readBodyWithLimit 自己因为超过大小限制主动抛出的
        // SitemapFetchError 才是真正的"响应过大"，不可重试。其他任何错误
        // （例如连接在读取响应体途中被提前关闭）都是瞬时网络问题，应该像
        // 别的网络错误一样走退避重试，而不是被当成"响应过大"直接判死。
        if (err instanceof SitemapFetchError) {
          clearTimeout(timer);
          return buildResult({
            ok: false,
            attempts,
            finalUrl,
            httpStatus: response.status,
            contentType,
            errorCode: err.code,
            errorMessage: err.message,
          });
        }
        clearTimeout(timer);
        lastFailure = { errorCode: FETCH_ERROR_CODES.NETWORK_ERROR, errorMessage: err.message, httpStatus: response.status, contentType };
        if (attempt < limits.MAX_RETRIES) {
          await sleep(backoffDelayMs(attempt, limits));
          continue;
        }
        return buildResult({ ok: false, attempts, finalUrl, ...lastFailure });
      }

      // 判断是否需要解压只看文件头魔数（1f 8b），不信任 URL 后缀或响应头——
      // 后两者仅供参考，服务器经常在这两点上撒谎（.gz 返回明文、或反向）。
      const looksGzip = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b;

      if (!looksGzip) {
        return buildResult({
          ok: true,
          attempts,
          finalUrl,
          httpStatus: response.status,
          contentType,
          contentEncoding,
          compressed: false,
          text: raw.toString('utf-8'),
        });
      }

      try {
        const decompressed = await decompressGzip(raw, limits.MAX_DECOMPRESSED_BYTES);
        return buildResult({
          ok: true,
          attempts,
          finalUrl,
          httpStatus: response.status,
          contentType,
          contentEncoding,
          compressed: true,
          text: decompressed.toString('utf-8'),
        });
      } catch (err) {
        return buildResult({
          ok: false,
          attempts,
          finalUrl,
          httpStatus: response.status,
          contentType,
          compressed: true,
          errorCode: err.code || FETCH_ERROR_CODES.GZIP_DECOMPRESS_FAILED,
          errorMessage: err.message,
        });
      }
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err.name === 'AbortError';
      const isTooManyRedirects = err instanceof SitemapFetchError && err.code === FETCH_ERROR_CODES.TOO_MANY_REDIRECTS;
      const code = isAbort ? FETCH_ERROR_CODES.TIMEOUT : isTooManyRedirects ? FETCH_ERROR_CODES.TOO_MANY_REDIRECTS : FETCH_ERROR_CODES.NETWORK_ERROR;
      const message = isAbort ? `请求超时(${limits.REQUEST_TIMEOUT_MS}ms)` : err.message;
      lastFailure = { errorCode: code, errorMessage: message, httpStatus: null, contentType: null };

      const canRetry = !isTooManyRedirects && attempt < limits.MAX_RETRIES;
      if (canRetry) {
        await sleep(backoffDelayMs(attempt, limits));
        continue;
      }
      return buildResult({ ok: false, attempts, finalUrl: url, ...lastFailure });
    }
  }

  return buildResult({ ok: false, attempts, finalUrl: url, ...lastFailure });
}

async function fetchFollowingRedirects(url, { fetchImpl, signal, maxRedirects }) {
  let currentUrl = url;
  for (let redirectCount = 0; ; redirectCount++) {
    const response = await fetchImpl(currentUrl, {
      redirect: 'manual',
      signal,
      headers: { 'user-agent': USER_AGENT },
    });

    const location = response.headers.get('location');
    const isRedirect = response.status >= 300 && response.status < 400 && location;
    if (!isRedirect) {
      return { response, finalUrl: currentUrl };
    }
    if (redirectCount >= maxRedirects) {
      throw new SitemapFetchError(FETCH_ERROR_CODES.TOO_MANY_REDIRECTS, `重定向次数超过限制(${maxRedirects})`);
    }
    currentUrl = new URL(location, currentUrl).toString();
  }
}

async function readBodyWithLimit(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new SitemapFetchError(FETCH_ERROR_CODES.RESPONSE_TOO_LARGE, `响应超过大小限制(${maxBytes} 字节)`);
    }
    return buf;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new SitemapFetchError(FETCH_ERROR_CODES.RESPONSE_TOO_LARGE, `响应超过大小限制(${maxBytes} 字节)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/** 流式解压，边解压边检查累计大小，超限立即中止并丢弃缓冲，避免 Gzip 炸弹撑爆内存。 */
function decompressGzip(buffer, maxBytes) {
  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    const chunks = [];
    let total = 0;
    let settled = false;

    gunzip.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        gunzip.destroy();
        reject(new SitemapFetchError(FETCH_ERROR_CODES.GZIP_TOO_LARGE, `解压后超过大小限制(${maxBytes} 字节)`));
        return;
      }
      chunks.push(chunk);
    });
    gunzip.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new SitemapFetchError(FETCH_ERROR_CODES.GZIP_DECOMPRESS_FAILED, `Gzip 解压失败: ${err.message}`));
    });
    gunzip.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    gunzip.end(buffer);
  });
}

function backoffDelayMs(attempt, limits) {
  return limits.RETRY_BASE_DELAY_MS * 2 ** attempt;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildResult({
  ok,
  attempts,
  finalUrl,
  httpStatus = null,
  contentType = null,
  contentEncoding = null,
  compressed = false,
  text = null,
  errorCode = null,
  errorMessage = null,
}) {
  return { ok, httpStatus, contentType, contentEncoding, compressed, text, errorCode, errorMessage, attempts, finalUrl };
}
