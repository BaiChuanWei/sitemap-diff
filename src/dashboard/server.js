import { createServer as createHttpServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../db/index.js';
import { serveStatic } from './static.js';
import { generateSessionToken, isExpectedHost } from './security.js';
import { EventHub } from './routes/events.js';
import { getHealth, SERVICE_NAME } from './routes/health.js';
import { getOverview, listSites, listRuns, getRunDetail } from './routes/overview.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');
const publicDir = resolve(projectRoot, 'public', 'dashboard');

export { SERVICE_NAME };

/**
 * Milestone Dashboard M1：只读本地面板 HTTP 服务器。
 *
 * 只做只读查询（GET），不触发采集、不写配置、不改数据库历史——本文件里
 * 唯一对数据库的操作是 SELECT。运行控制、配置写入留给 M2/M3。
 *
 * @param config    loadLocalConfig() 的返回值
 * @param port      监听端口（默认 8766，可用 SITEMAP_DASHBOARD_PORT 覆盖）
 */
export function createDashboardServer({ config, port }) {
  const db = openDb(config.dbPath);
  const startedAt = new Date().toISOString();
  const sessionToken = generateSessionToken();
  const eventHub = new EventHub();

  const server = createHttpServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify({ error: 'INTERNAL_ERROR', message: err.message }));
    });
  });

  async function handleRequest(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    // DNS rebinding 防护：Host 必须精确匹配。静态资源和 API 都要过这一关。
    if (!isExpectedHost(req, port)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'FORBIDDEN_HOST' }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, { ...getHealth({ port, dbPath: config.dbPath, startedAt }), sessionToken });
    }

    if (req.method === 'GET' && url.pathname === '/api/overview') {
      return sendJson(res, 200, getOverview(db, config));
    }

    if (req.method === 'GET' && url.pathname === '/api/sites') {
      return sendJson(res, 200, { sites: listSites(db) });
    }

    if (req.method === 'GET' && url.pathname === '/api/runs') {
      const limit = Number(url.searchParams.get('limit')) || 50;
      return sendJson(res, 200, { runs: listRuns(db, { limit }) });
    }

    if (req.method === 'GET' && /^\/api\/runs\/[^/]+$/.test(url.pathname)) {
      const runId = decodeURIComponent(url.pathname.split('/')[3]);
      const detail = getRunDetail(db, runId);
      if (!detail) return sendJson(res, 404, { error: 'RUN_NOT_FOUND' });
      return sendJson(res, 200, detail);
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const accepted = eventHub.handleRequest(req, res);
      if (!accepted) return sendJson(res, 503, { error: 'TOO_MANY_SSE_CONNECTIONS' });
      return;
    }

    if (req.method === 'GET') {
      const served = serveStatic(req, res, publicDir, url.pathname);
      if (served) return;
    }

    return sendJson(res, 404, { error: 'NOT_FOUND' });
  }

  function sendJson(res, statusCode, body) {
    res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  return {
    server,
    db,
    eventHub,
    sessionToken,
    listen() {
      return new Promise((resolvePromise, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolvePromise();
        });
      });
    },
    close() {
      eventHub.close();
      db.close();
      return new Promise((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}
