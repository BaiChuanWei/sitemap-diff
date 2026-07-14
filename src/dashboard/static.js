import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * 只读静态文件服务，映射到单一目录（publicDir），拒绝任何路径穿越尝试。
 * 返回 true 表示已经处理了这个请求（无论成功还是 404/403），false 表示
 * 请求路径不属于静态资源范围，调用方应该继续尝试别的路由。
 */
export function serveStatic(req, res, publicDir, urlPath) {
  const relative = urlPath === '/' ? '/index.html' : urlPath;
  const normalized = normalize(relative).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(publicDir, normalized);

  // 规范化后必须仍然落在 publicDir 内部，否则视为路径穿越尝试，拒绝服务。
  if (!filePath.startsWith(publicDir + sep) && filePath !== publicDir) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('禁止访问');
    return true;
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return false;
  }

  const ext = filePath.slice(filePath.lastIndexOf('.'));
  res.writeHead(200, { 'content-type': MIME_TYPES[ext] || 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
  return true;
}
