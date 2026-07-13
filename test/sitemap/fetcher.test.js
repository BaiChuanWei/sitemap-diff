import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { fetchSitemap } from '../../src/sitemap/fetcher.js';
import { FETCH_ERROR_CODES } from '../../src/sitemap/errors.js';
import { DEFAULT_LIMITS } from '../../src/sitemap/limits.js';
import { startTestServer, noSleep } from '../helpers/http-server.js';

const XML_BODY = '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example-games.test/g/a</loc></url></urlset>';

function fastLimits(overrides = {}) {
  return { ...DEFAULT_LIMITS, REQUEST_TIMEOUT_MS: 150, MAX_RETRIES: 2, RETRY_BASE_DELAY_MS: 5, ...overrides };
}

// ---- Level 3: Gzip ----

test('gzip: .gz URL + 真实 gzip 内容会被正确解压', async () => {
  const gz = zlib.gzipSync(Buffer.from(XML_BODY));
  const { url, close } = await startTestServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/gzip' });
    res.end(gz);
  });
  try {
    const result = await fetchSitemap(`${url}/sitemap.xml.gz`, { limits: fastLimits(), sleep: noSleep });
    assert.equal(result.ok, true);
    assert.equal(result.compressed, true);
    assert.equal(result.text, XML_BODY);
  } finally {
    await close();
  }
});

test('gzip: 无 .gz 后缀但文件头是 Gzip 魔数，依然会被解压', async () => {
  const gz = zlib.gzipSync(Buffer.from(XML_BODY));
  const { url, close } = await startTestServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(gz);
  });
  try {
    const result = await fetchSitemap(`${url}/sitemap-no-suffix`, { limits: fastLimits(), sleep: noSleep });
    assert.equal(result.ok, true);
    assert.equal(result.compressed, true);
    assert.equal(result.text, XML_BODY);
  } finally {
    await close();
  }
});

test('gzip: .gz URL 但服务器返回明文 XML，不重复解压', async () => {
  const { url, close } = await startTestServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(XML_BODY);
  });
  try {
    const result = await fetchSitemap(`${url}/sitemap.xml.gz`, { limits: fastLimits(), sleep: noSleep });
    assert.equal(result.ok, true);
    assert.equal(result.compressed, false);
    assert.equal(result.text, XML_BODY);
  } finally {
    await close();
  }
});

test('gzip: 损坏的 Gzip 数据返回明确的 GZIP_DECOMPRESS_FAILED 错误', async () => {
  const corrupted = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xff, 0xff, 0xff]);
  const { url, close } = await startTestServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/gzip' });
    res.end(corrupted);
  });
  try {
    const result = await fetchSitemap(`${url}/broken.xml.gz`, { limits: fastLimits(), sleep: noSleep });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, FETCH_ERROR_CODES.GZIP_DECOMPRESS_FAILED);
  } finally {
    await close();
  }
});

test('gzip: 解压后大小超过限制会中止并返回 GZIP_TOO_LARGE', async () => {
  const bigXml = XML_BODY + '<!-- padding -->'.repeat(5000);
  const gz = zlib.gzipSync(Buffer.from(bigXml));
  const { url, close } = await startTestServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/gzip' });
    res.end(gz);
  });
  try {
    const result = await fetchSitemap(`${url}/huge.xml.gz`, {
      limits: fastLimits({ MAX_DECOMPRESSED_BYTES: 1000 }),
      sleep: noSleep,
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, FETCH_ERROR_CODES.GZIP_TOO_LARGE);
  } finally {
    await close();
  }
});

// ---- Level 4: 网络行为 ----

test('网络: 请求超时会在重试耗尽后返回 TIMEOUT', async () => {
  const { url, close } = await startTestServer((req, res) => {
    const timer = setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/xml' });
      res.end(XML_BODY);
    }, 5000);
    req.on('close', () => clearTimeout(timer));
  });
  try {
    const result = await fetchSitemap(`${url}/slow.xml`, {
      limits: fastLimits({ REQUEST_TIMEOUT_MS: 80, MAX_RETRIES: 1 }),
      sleep: noSleep,
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, FETCH_ERROR_CODES.TIMEOUT);
    assert.equal(result.attempts, 2);
  } finally {
    await close();
  }
});

test('网络: 429 之后成功，会重试并最终拿到结果', async () => {
  let calls = 0;
  const { url, close } = await startTestServer((req, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(429, { 'content-type': 'text/plain' });
      res.end('rate limited');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(XML_BODY);
  });
  try {
    const result = await fetchSitemap(`${url}/rate-limited.xml`, { limits: fastLimits(), sleep: noSleep });
    assert.equal(result.ok, true);
    assert.equal(result.text, XML_BODY);
    assert.equal(result.attempts, 2);
  } finally {
    await close();
  }
});

test('网络: 503 之后成功，会重试并最终拿到结果', async () => {
  let calls = 0;
  const { url, close } = await startTestServer((req, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(503);
      res.end('unavailable');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(XML_BODY);
  });
  try {
    const result = await fetchSitemap(`${url}/flaky.xml`, { limits: fastLimits(), sleep: noSleep });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
  } finally {
    await close();
  }
});

test('网络: 404 不会重试，只请求一次', async () => {
  let calls = 0;
  const { url, close } = await startTestServer((req, res) => {
    calls++;
    res.writeHead(404);
    res.end('not found');
  });
  try {
    const result = await fetchSitemap(`${url}/missing.xml`, { limits: fastLimits(), sleep: noSleep });
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 404);
    assert.equal(result.errorCode, FETCH_ERROR_CODES.HTTP_ERROR);
    assert.equal(calls, 1, '404 不应该重试');
  } finally {
    await close();
  }
});

test('网络: 重定向次数超过限制会返回 TOO_MANY_REDIRECTS', async () => {
  const { url, close } = await startTestServer((req, res) => {
    const n = Number(new URL(req.url, 'http://x').searchParams.get('n') || '0');
    res.writeHead(302, { location: `/loop?n=${n + 1}` });
    res.end();
  });
  try {
    const result = await fetchSitemap(`${url}/loop?n=0`, {
      limits: fastLimits({ MAX_REDIRECTS: 3, MAX_RETRIES: 0 }),
      sleep: noSleep,
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, FETCH_ERROR_CODES.TOO_MANY_REDIRECTS);
  } finally {
    await close();
  }
});

test('网络: 响应体超过大小限制会返回 RESPONSE_TOO_LARGE', async () => {
  const { url, close } = await startTestServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end('x'.repeat(5000));
  });
  try {
    const result = await fetchSitemap(`${url}/huge.xml`, {
      limits: fastLimits({ MAX_DOWNLOAD_BYTES: 1000, MAX_RETRIES: 0 }),
      sleep: noSleep,
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, FETCH_ERROR_CODES.RESPONSE_TOO_LARGE);
  } finally {
    await close();
  }
});

test('正常路径：200 + 明文 XML 一次成功，attempts 为 1', async () => {
  const { url, close } = await startTestServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(XML_BODY);
  });
  try {
    const result = await fetchSitemap(`${url}/ok.xml`, { limits: fastLimits(), sleep: noSleep });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 1);
    assert.equal(result.text, XML_BODY);
  } finally {
    await close();
  }
});
