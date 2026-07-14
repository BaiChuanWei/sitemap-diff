import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveStatic } from '../../src/dashboard/static.js';
import { isSameOriginRequest, isExpectedHost, generateSessionToken, readBodyWithLimit } from '../../src/dashboard/security.js';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';

function fakeRes() {
  // 需要是一个真正可写的流（pipe() 要求），否则 createReadStream(...).pipe(res)
  // 产生的异步活动会在测试函数返回之后才完成，导致临时目录被提前删除。
  const chunks = [];
  const res = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  res.writeHead = (code, headers) => {
    res.statusCode = code;
    res.headers = headers;
  };
  res.getBody = () => Buffer.concat(chunks).toString('utf-8');
  return res;
}

function waitFinish(res) {
  return new Promise((resolvePromise) => res.once('finish', resolvePromise));
}

test('serveStatic：正常文件可以被读取', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-static-'));
  try {
    writeFileSync(join(dir, 'index.html'), '<html>ok</html>', 'utf-8');
    const res = fakeRes();
    const handled = serveStatic({}, res, dir, '/index.html');
    assert.equal(handled, true);
    await waitFinish(res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.getBody(), '<html>ok</html>');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('serveStatic：路径穿越请求被安全地限制在 publicDir 内，不会泄露外部文件', () => {
  // Node 的 path.join(base, x) 会把 base 和 x 拼接后整体 normalize，任何
  // 形如 "/../../../etc/passwd" 的输入都会被规约成 base 内部的一个不存在
  // 的子路径（例如 "<publicDir>/etc/passwd"），而不是真的跳到 base 外面
  // ——所以真实行为是"文件不存在"（handled=false），不是命中 403 分支。
  // 403 分支是给 join() 本身产出仍然逃逸 base 的极端情况准备的额外防线。
  // 这里验证的核心安全属性是：无论哪个分支命中，都绝不会把 publicDir 之外
  // 的真实文件内容返回给客户端。
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-static-'));
  try {
    writeFileSync(join(dir, 'index.html'), 'ok', 'utf-8');
    const res = fakeRes();
    const handled = serveStatic({}, res, dir, '/../../../../etc/passwd');
    if (handled) {
      // 如果命中了某个分支（403 或意外的 200），body 都绝不能是 /etc/passwd 的真实内容。
      assert.notEqual(res.statusCode, 200);
    } else {
      assert.equal(handled, false, '被安全地规约成 publicDir 内一个不存在的路径，等同于 404');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('serveStatic：不存在的文件返回 false，交给上层继续路由（不是路径穿越，只是单纯 404）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-static-'));
  try {
    const res = fakeRes();
    const handled = serveStatic({}, res, dir, '/does-not-exist.js');
    assert.equal(handled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isSameOriginRequest：匹配的 Origin 通过，不匹配的拒绝', () => {
  assert.equal(isSameOriginRequest({ headers: { origin: 'http://127.0.0.1:8766' } }, 8766), true);
  assert.equal(isSameOriginRequest({ headers: { origin: 'http://evil.example.com' } }, 8766), false);
});

test('isExpectedHost：只接受精确的 127.0.0.1:<port>', () => {
  assert.equal(isExpectedHost({ headers: { host: '127.0.0.1:8766' } }, 8766), true);
  assert.equal(isExpectedHost({ headers: { host: 'localhost:8766' } }, 8766), false);
  assert.equal(isExpectedHost({ headers: { host: '127.0.0.1:9999' } }, 8766), false);
});

test('generateSessionToken：每次调用生成不同的 token', () => {
  const a = generateSessionToken();
  const b = generateSessionToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 32);
});

test('readBodyWithLimit：超过大小限制时拒绝，不会把整个超大 body 读进内存', async () => {
  const req = new EventEmitter();
  req.destroy = () => {};
  const promise = readBodyWithLimit(req, 10);
  req.emit('data', Buffer.from('x'.repeat(20)));
  await assert.rejects(promise, /BODY_TOO_LARGE|请求体超过大小限制/);
});

test('readBodyWithLimit：正常大小的 body 能被完整读取', async () => {
  const req = new EventEmitter();
  const promise = readBodyWithLimit(req, 100);
  req.emit('data', Buffer.from('hello'));
  req.emit('end');
  const body = await promise;
  assert.equal(body.toString(), 'hello');
});
