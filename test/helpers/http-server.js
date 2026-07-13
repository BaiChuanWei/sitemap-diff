import { createServer } from 'node:http';

/**
 * 启动一个本地 HTTP 测试服务器，供 fetcher/recursive-loader 的集成测试使用，
 * 不依赖不稳定的外网。handler 签名与 node:http 的 (req, res) 一致。
 * 返回 { url, close }，url 是形如 http://127.0.0.1:PORT 的 base URL。
 */
export function startTestServer(handler) {
  const server = createServer(handler);
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        // 主动销毁所有连接（包括被 abort 但底层 socket 仍被连接池保留的），
        // 避免测试卡在 Node 默认 keep-alive 超时（5s）上。
        close: () =>
          new Promise((r) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

export function noSleep() {
  return Promise.resolve();
}

/** 按 pathname 分发到静态或动态（函数）响应，未匹配路径返回 404。 */
export function createRouter(routes) {
  return (req, res) => {
    const { pathname } = new URL(req.url, 'http://placeholder');
    const entry = routes[pathname];
    if (!entry) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const result = typeof entry === 'function' ? entry(req) : entry;
    res.writeHead(result.status || 200, result.headers || { 'content-type': 'application/xml' });
    res.end(result.body ?? '');
  };
}

export function urlsetXml(locs) {
  return `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((l) => `<url><loc>${l}</loc></url>`)
    .join('')}</urlset>`;
}

export function indexXml(locs) {
  return `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((l) => `<sitemap><loc>${l}</loc></sitemap>`)
    .join('')}</sitemapindex>`;
}
