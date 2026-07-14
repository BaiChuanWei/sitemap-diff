import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSiteId,
  validateDomain,
  isPrivateOrLoopbackHost,
  validateHttpUrlField,
  validatePriority,
  validateEnabled,
  validateSiteInput,
  validateLimitsInput,
  validateSitemapsInput,
  ValidationError,
} from '../../src/dashboard/validation.js';

// ---- site_id ----
test('validateSiteId：合法值通过', () => {
  assert.equal(validateSiteId('poki'), 'poki');
  assert.equal(validateSiteId('a10'), 'a10');
  assert.equal(validateSiteId('brainrot_games'), 'brainrot_games');
});

test('validateSiteId：包含 ../ 或路径分隔符拒绝', () => {
  assert.throws(() => validateSiteId('../etc/passwd'), ValidationError);
  assert.throws(() => validateSiteId('a/b'), ValidationError);
  assert.throws(() => validateSiteId('a b'), ValidationError);
  assert.throws(() => validateSiteId(''), ValidationError);
  assert.throws(() => validateSiteId('.'), ValidationError);
  assert.throws(() => validateSiteId('..'), ValidationError);
});

// ---- domain / SSRF ----
test('isPrivateOrLoopbackHost：识别常见私网/本机地址', () => {
  assert.equal(isPrivateOrLoopbackHost('localhost'), true);
  assert.equal(isPrivateOrLoopbackHost('127.0.0.1'), true);
  assert.equal(isPrivateOrLoopbackHost('127.53.0.9'), true);
  assert.equal(isPrivateOrLoopbackHost('10.1.2.3'), true);
  assert.equal(isPrivateOrLoopbackHost('172.16.0.1'), true);
  assert.equal(isPrivateOrLoopbackHost('172.31.255.255'), true);
  assert.equal(isPrivateOrLoopbackHost('172.32.0.1'), false); // 超出 172.16.0.0/12 范围
  assert.equal(isPrivateOrLoopbackHost('192.168.1.1'), true);
  assert.equal(isPrivateOrLoopbackHost('169.254.169.254'), true); // 云元数据地址
  assert.equal(isPrivateOrLoopbackHost('::1'), true);
  assert.equal(isPrivateOrLoopbackHost('fc00::1'), true);
  assert.equal(isPrivateOrLoopbackHost('fe80::1'), true);
  assert.equal(isPrivateOrLoopbackHost('myinternal.local'), true);
  assert.equal(isPrivateOrLoopbackHost('poki.com'), false);
  assert.equal(isPrivateOrLoopbackHost('8.8.8.8'), false);
});

test('validateDomain：合法域名通过并规范化为小写', () => {
  assert.equal(validateDomain('Poki.COM'), 'poki.com');
  assert.equal(validateDomain('crazygames.org.'), 'crazygames.org');
});

test('validateDomain：拒绝 localhost/127.0.0.1/内网地址', () => {
  assert.throws(() => validateDomain('localhost'), ValidationError);
  assert.throws(() => validateDomain('127.0.0.1'), ValidationError);
  assert.throws(() => validateDomain('192.168.1.1'), ValidationError);
  assert.throws(() => validateDomain('169.254.169.254'), ValidationError);
});

test('validateDomain：拒绝含协议/路径/端口/空格的输入', () => {
  assert.throws(() => validateDomain('https://poki.com'), ValidationError);
  assert.throws(() => validateDomain('poki.com/path'), ValidationError);
  assert.throws(() => validateDomain('poki.com:8080'), ValidationError);
  assert.throws(() => validateDomain('po ki.com'), ValidationError);
});

test('validateDomain：拒绝格式错误的域名', () => {
  assert.throws(() => validateDomain('not a domain'), ValidationError);
  assert.throws(() => validateDomain(''), ValidationError);
});

// ---- URL 字段（SSRF） ----
test('validateHttpUrlField：合法 http(s) URL 通过', () => {
  assert.equal(validateHttpUrlField('https://poki.com/robots.txt', 'robots_url'), 'https://poki.com/robots.txt');
});

test('validateHttpUrlField：拒绝 file/data/javascript/ftp 协议', () => {
  assert.throws(() => validateHttpUrlField('file:///etc/passwd', 'sitemap_url'), ValidationError);
  assert.throws(() => validateHttpUrlField('data:text/html,<script>1</script>', 'sitemap_url'), ValidationError);
  assert.throws(() => validateHttpUrlField('javascript:alert(1)', 'sitemap_url'), ValidationError);
  assert.throws(() => validateHttpUrlField('ftp://example.com/x', 'sitemap_url'), ValidationError);
});

test('validateHttpUrlField：拒绝指向 127.0.0.1 或内网地址的 URL（SSRF 防护）', () => {
  assert.throws(() => validateHttpUrlField('http://127.0.0.1/sitemap.xml', 'sitemap_url'), ValidationError);
  assert.throws(() => validateHttpUrlField('http://192.168.1.1/sitemap.xml', 'sitemap_url'), ValidationError);
  assert.throws(() => validateHttpUrlField('http://169.254.169.254/latest/meta-data', 'sitemap_url'), ValidationError);
});

// ---- priority / enabled ----
test('validatePriority：只允许 high/medium/low，空值默认 medium', () => {
  assert.equal(validatePriority('high'), 'high');
  assert.equal(validatePriority(undefined), 'medium');
  assert.throws(() => validatePriority('urgent'), ValidationError);
});

test('validateEnabled：只接受布尔值，拒绝字符串', () => {
  assert.equal(validateEnabled(true), true);
  assert.equal(validateEnabled(false), false);
  assert.throws(() => validateEnabled('true'), ValidationError);
  assert.throws(() => validateEnabled('1'), ValidationError);
  assert.throws(() => validateEnabled('yes'), ValidationError);
});

// ---- validateSiteInput ----
test('validateSiteInput：新增合法站点通过', () => {
  const result = validateSiteInput(
    { site_id: 'newsite', domain: 'newsite.com', priority: 'high', enabled: true },
    { isCreate: true, knownSiteIds: new Set(['poki']), knownDomains: new Map() },
  );
  assert.equal(result.site_id, 'newsite');
  assert.equal(result.domain, 'newsite.com');
});

test('validateSiteInput：重复 site_id 拒绝', () => {
  assert.throws(
    () => validateSiteInput({ site_id: 'poki', domain: 'x.com' }, { isCreate: true, knownSiteIds: new Set(['poki']) }),
    /ValidationError/,
  );
});

test('validateSiteInput：未知字段拒绝', () => {
  assert.throws(
    () => validateSiteInput({ site_id: 'x', domain: 'x.com', evil_field: 1 }, { isCreate: true, knownSiteIds: new Set() }),
    ValidationError,
  );
});

test('validateSiteInput：编辑时不允许修改 site_id', () => {
  assert.throws(
    () => validateSiteInput({ site_id: 'renamed', domain: 'x.com' }, { isCreate: false, currentSiteId: 'x' }),
    ValidationError,
  );
});

test('validateSiteInput：域名重复且属于其它站点时拒绝', () => {
  const knownDomains = new Map([['taken.com', 'other-site']]);
  assert.throws(
    () => validateSiteInput({ site_id: 'x', domain: 'taken.com' }, { isCreate: true, knownSiteIds: new Set(), knownDomains }),
    ValidationError,
  );
});

// ---- validateLimitsInput ----
test('validateLimitsInput：合法值通过', () => {
  const result = validateLimitsInput({ max_download_bytes: 62914560 });
  assert.equal(result.max_download_bytes, '62914560');
});

test('validateLimitsInput：超硬上限拒绝', () => {
  assert.throws(() => validateLimitsInput({ max_page_urls: 2000000 }), ValidationError);
});

test('validateLimitsInput：未知字段拒绝', () => {
  assert.throws(() => validateLimitsInput({ max_retries: 5 }), ValidationError);
});

// ---- validateSitemapsInput ----
test('validateSitemapsInput：manual_only 且没有启用 Endpoint 时拒绝', () => {
  assert.throws(
    () => validateSitemapsInput({ mode: 'manual_only', urls: [{ sitemap_url: 'https://x.com/a.xml', enabled: false }] }),
    ValidationError,
  );
});

test('validateSitemapsInput：合法多 Endpoint 通过且去重', () => {
  const result = validateSitemapsInput({
    mode: 'merge',
    urls: [
      { sitemap_url: 'https://x.com/a.xml', enabled: true },
      { sitemap_url: 'https://x.com/a.xml', enabled: true },
      { sitemap_url: 'https://x.com/b.xml', enabled: true },
    ],
  });
  assert.equal(result.urls.length, 2);
});

test('validateSitemapsInput：非法 Sitemap URL 拒绝', () => {
  assert.throws(
    () => validateSitemapsInput({ mode: 'merge', urls: [{ sitemap_url: 'not-a-url', enabled: true }] }),
    ValidationError,
  );
});
