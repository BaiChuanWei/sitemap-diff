import { randomBytes } from 'node:crypto';

/**
 * Milestone Dashboard M1：本地面板安全基础设施骨架。
 *
 * M1 只有只读 GET 接口，本文件里的写保护（token/Origin/Host/请求体大小）
 * 暂时没有任何写接口会用到，但按照威胁模型文档的要求提前建好，供 M2 起的
 * 写接口直接复用，避免"先上线写接口、后补安全检查"的顺序风险。
 */

/** 每次服务启动生成一次性 token，前端页面通过 /api/health 拿到后放在写请求的 header 里。 */
export function generateSessionToken() {
  return randomBytes(24).toString('hex');
}

/** Origin/Referer 必须是本服务自己（127.0.0.1:<port>），否则视为跨站请求。 */
export function isSameOriginRequest(req, port) {
  const expected = `http://127.0.0.1:${port}`;
  const origin = req.headers['origin'];
  if (origin) return origin === expected;
  const referer = req.headers['referer'];
  if (referer) return referer.startsWith(`${expected}/`) || referer === `${expected}/`;
  // 同源的顶层导航请求（比如浏览器直接打开页面）通常不带 Origin/Referer，
  // 这类请求只会命中 GET 静态资源，不会走到需要写权限的接口，因此在没有
  // Origin/Referer 时不视为跨站——真正的写接口还会额外校验 Host + token。
  return true;
}

/** Host 必须精确等于 127.0.0.1:<port>，防 DNS rebinding 类攻击。 */
export function isExpectedHost(req, port) {
  return req.headers['host'] === `127.0.0.1:${port}`;
}

/** 校验一次性 token（写接口用，M1 暂无实际调用方）。 */
export function isValidToken(req, sessionToken) {
  return req.headers['x-dashboard-token'] === sessionToken;
}

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1MB

/**
 * 读取请求体并限制大小；超过上限时拒绝，不把超大 body 读进内存后再校验。
 *
 * 注意：这里刻意不调用 req.destroy()——HTTP 请求和响应共用同一个底层
 * socket，销毁 req 会连带断开整个连接，导致服务端来不及把 413 响应写
 * 回给客户端，浏览器端只会看到一个原始的连接错误而不是 413 状态码。
 * 调用方负责正常写完错误响应；未读完的多余请求体交给 Node 在响应结束、
 * 连接关闭时一并丢弃（写错误响应时应带上 Connection: close，避免残留
 * 的请求体字节污染同一 keep-alive 连接上的下一个请求）。
 */
export function readBodyWithLimit(req, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let settled = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        reject(Object.assign(new Error('请求体超过大小限制'), { code: 'BODY_TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}
