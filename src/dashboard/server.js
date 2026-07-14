import { createServer as createHttpServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, syncSites } from '../db/index.js';
import { parseSitesCsv } from '../config.js';
import { serveStatic } from './static.js';
import { generateSessionToken, isExpectedHost, isSameOriginRequest, isValidToken, readBodyWithLimit } from './security.js';
import { EventHub } from './routes/events.js';
import { getHealth, SERVICE_NAME } from './routes/health.js';
import { getOverview, listSites, listRuns, getRunDetail } from './routes/overview.js';
import { createSite, updateSite, setSiteEnabled, getSiteDetail, getSiteLimits, putSiteLimits, getSiteSitemaps, putSiteSitemaps, ApiError } from './routes/sites-write.js';
import { startDiagnosis, getDiagnosis } from './routes/diagnose-write.js';
import { createRunController } from './run-controller.js';
import { startRunRoute, cancelRunRoute } from './routes/runs-write.js';
import { getActiveRunRoute, getRunSitesRoute, getRunChangesRoute, getRunReportRoute, getRunReportFileRoute } from './routes/runs-read.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');
const publicDir = resolve(projectRoot, 'public', 'dashboard');

export { SERVICE_NAME };

/**
 * Dashboard M1+M2：本地面板 HTTP 服务器。
 *
 * M1 范围：只读查询（GET），不触发采集。
 * M2 新增：站点配置的增/改/启停/限制/手工Sitemap的安全写入，以及只读诊断
 * 的异步触发与轮询。写操作一律走 config-store.js 的原子写入路径，一律
 * 要求 CSRF token + 同源校验，一律不直接执行 shell、不接受任意文件路径。
 *
 * @param config     loadLocalConfig() 的返回值
 * @param port       监听端口（默认 8766，可用 SITEMAP_DASHBOARD_PORT 覆盖）
 * @param logDir     可选：审计日志目录覆盖（测试用）
 * @param collectSiteFn       Dashboard M3：可选，测试注入用的采集函数（默认真实 collectSite）
 * @param classifyFetchPagesFn Dashboard M3：可选，测试注入用的分类页面抓取函数（默认真实 fetchPages）
 */
export function createDashboardServer({ config, port, logDir, diagnoseFetchImpl, collectSiteFn, classifyFetchPagesFn }) {
  const db = openDb(config.dbPath);
  // 启动时把 config/sites.csv 同步进 SQLite，和 CLI 的 runBaseline() 行为
  // 一致——config/sites.csv 才是正式配置源，站点列表/详情接口读的是 SQLite
  // 的 sites 表，两者必须先对齐一次，否则"CSV 里手工加了一行、面板还没
  // 同步过"这种场景会让新站点在面板里查不到。写操作路径（writeConfig）
  // 每次写完也会调用 syncSites，这里只补上"启动时/CSV 被外部修改后"这个
  // 缺口，不引入第二套配置存储。
  if (existsSync(config.sitesCsvPath)) {
    syncSites(db, parseSitesCsv(readFileSync(config.sitesCsvPath, 'utf-8')));
  }
  const startedAt = new Date().toISOString();
  const sessionToken = generateSessionToken();
  const eventHub = new EventHub();
  const auditLogDir = logDir || join(projectRoot, 'logs');
  const runController = createRunController({ db, config, eventHub, collectSiteFn, classifyFetchPagesFn, logDir: auditLogDir });

  const server = createHttpServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      // 技术错误细节写日志（服务端 stderr），前端只拿到通用错误码 + 消息，
      // 不把内部堆栈回显给页面。
      console.error(`[dashboard] ${req.method} ${req.url} ->`, err);
      if (!res.headersSent) {
        sendError(res, new ApiError('INTERNAL_ERROR', '服务器内部错误', { status: 500 }));
      }
    });
  });

  async function handleRequest(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    // DNS rebinding 防护：Host 必须精确匹配。静态资源和 API 都要过这一关。
    if (!isExpectedHost(req, port)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN_HOST', message: 'Host 不匹配' } }));
      return;
    }

    const isMutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method);
    if (isMutating && url.pathname.startsWith('/api/')) {
      const guardError = guardMutatingRequest(req, port, sessionToken);
      if (guardError) return sendError(res, guardError);
    }

    try {
      return await dispatch(req, res, url);
    } catch (err) {
      if (err instanceof ApiError) return sendError(res, err);
      throw err; // 非预期错误交给外层 catch，记完整堆栈后统一 500
    }
  }

  async function dispatch(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendData(res, 200, { ...getHealth({ port, dbPath: config.dbPath, startedAt }), sessionToken });
    }

    if (req.method === 'GET' && url.pathname === '/api/overview') {
      return sendData(res, 200, getOverview(db, config));
    }

    if (req.method === 'GET' && url.pathname === '/api/sites') {
      return sendData(res, 200, { sites: listSites(db) });
    }

    if (req.method === 'POST' && url.pathname === '/api/sites') {
      return withJsonBody(req, res, (body, expectedConfigVersion) => {
        const result = createSite(db, config, body, { expectedConfigVersion, auditLogDir });
        sendData(res, 201, result);
      });
    }

    const siteIdMatch = url.pathname.match(/^\/api\/sites\/([^/]+)$/);
    if (siteIdMatch && req.method === 'GET') {
      const result = getSiteDetail(db, config, decodeURIComponent(siteIdMatch[1]));
      return sendData(res, 200, result);
    }
    if (siteIdMatch && req.method === 'PATCH') {
      return withJsonBody(req, res, (body, expectedConfigVersion) => {
        const result = updateSite(db, config, decodeURIComponent(siteIdMatch[1]), body, { expectedConfigVersion, auditLogDir });
        sendData(res, 200, result);
      });
    }

    const enableMatch = url.pathname.match(/^\/api\/sites\/([^/]+)\/(enable|disable)$/);
    if (enableMatch && req.method === 'POST') {
      return withJsonBody(req, res, (body, expectedConfigVersion) => {
        const siteId = decodeURIComponent(enableMatch[1]);
        const enabled = enableMatch[2] === 'enable';
        const result = setSiteEnabled(db, config, siteId, enabled, { expectedConfigVersion, auditLogDir });
        sendData(res, 200, result);
      });
    }

    const limitsMatch = url.pathname.match(/^\/api\/sites\/([^/]+)\/limits$/);
    if (limitsMatch && req.method === 'GET') {
      return sendData(res, 200, getSiteLimits(config, decodeURIComponent(limitsMatch[1])));
    }
    if (limitsMatch && req.method === 'PUT') {
      return withJsonBody(req, res, (body, expectedConfigVersion) => {
        const result = putSiteLimits(config, decodeURIComponent(limitsMatch[1]), body, { expectedConfigVersion, auditLogDir });
        sendData(res, 200, result);
      });
    }

    const sitemapsMatch = url.pathname.match(/^\/api\/sites\/([^/]+)\/sitemaps$/);
    if (sitemapsMatch && req.method === 'GET') {
      return sendData(res, 200, getSiteSitemaps(config, decodeURIComponent(sitemapsMatch[1])));
    }
    if (sitemapsMatch && req.method === 'PUT') {
      return withJsonBody(req, res, (body, expectedConfigVersion) => {
        const result = putSiteSitemaps(config, decodeURIComponent(sitemapsMatch[1]), body, { expectedConfigVersion, auditLogDir });
        sendData(res, 200, result);
      });
    }

    const diagnoseMatch = url.pathname.match(/^\/api\/sites\/([^/]+)\/diagnose$/);
    if (diagnoseMatch && req.method === 'POST') {
      const result = startDiagnosis(config, decodeURIComponent(diagnoseMatch[1]), { fetchImpl: diagnoseFetchImpl });
      return sendData(res, 202, result);
    }

    const diagnosticMatch = url.pathname.match(/^\/api\/diagnostics\/([^/]+)$/);
    if (diagnosticMatch && req.method === 'GET') {
      const result = getDiagnosis(decodeURIComponent(diagnosticMatch[1]));
      return sendData(res, 200, result);
    }

    if (req.method === 'GET' && url.pathname === '/api/runs') {
      const limit = Number(url.searchParams.get('limit')) || 50;
      return sendData(res, 200, { runs: listRuns(db, { limit }) });
    }

    if (req.method === 'POST' && url.pathname === '/api/runs') {
      return withJsonBody(req, res, (body) => {
        const result = startRunRoute(db, runController, body, { logDir: auditLogDir });
        sendData(res, 202, result);
      });
    }

    // /api/runs/active 必须比下面的通用 /api/runs/:run_id 先匹配——
    // 'active' 本身也满足 [^/]+，不特殊处理会被当成一个 run_id 去查历史记录。
    if (req.method === 'GET' && url.pathname === '/api/runs/active') {
      return sendData(res, 200, getActiveRunRoute(runController));
    }

    const runCancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
    if (runCancelMatch && req.method === 'POST') {
      return withJsonBody(req, res, () => {
        const result = cancelRunRoute(runController, decodeURIComponent(runCancelMatch[1]));
        sendData(res, 200, result);
      });
    }

    const runSitesMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/sites$/);
    if (runSitesMatch && req.method === 'GET') {
      return sendData(res, 200, getRunSitesRoute(runController, decodeURIComponent(runSitesMatch[1])));
    }

    const runChangesMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/changes$/);
    if (runChangesMatch && req.method === 'GET') {
      const runId = decodeURIComponent(runChangesMatch[1]);
      const result = getRunChangesRoute(db, runController, runId, {
        siteId: url.searchParams.get('site_id') || undefined,
        type: url.searchParams.get('type') || undefined,
        page: url.searchParams.get('page') || undefined,
        pageSize: url.searchParams.get('page_size') || undefined,
      });
      return sendData(res, 200, result);
    }

    const runReportFileMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/report\/([^/]+)$/);
    if (runReportFileMatch && req.method === 'GET') {
      const runId = decodeURIComponent(runReportFileMatch[1]);
      const filename = decodeURIComponent(runReportFileMatch[2]);
      const { filePath, contentType } = getRunReportFileRoute(db, config, runController, runId, filename);
      const content = readFileSync(filePath);
      res.writeHead(200, { 'content-type': contentType, 'content-disposition': `attachment; filename="${filename}"` });
      res.end(content);
      return;
    }

    const runReportMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/report$/);
    if (runReportMatch && req.method === 'GET') {
      const runId = decodeURIComponent(runReportMatch[1]);
      return sendData(res, 200, getRunReportRoute(db, config, runController, runId));
    }

    if (req.method === 'GET' && /^\/api\/runs\/[^/]+$/.test(url.pathname)) {
      const runId = decodeURIComponent(url.pathname.split('/')[3]);
      const detail = getRunDetail(db, runId);
      if (!detail) return sendError(res, new ApiError('RUN_NOT_FOUND', '找不到该次运行', { status: 404 }));
      return sendData(res, 200, detail);
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const accepted = eventHub.handleRequest(req, res);
      if (!accepted) return sendError(res, new ApiError('TOO_MANY_SSE_CONNECTIONS', 'SSE 连接数已达上限', { status: 503 }));
      return;
    }

    if (req.method === 'GET') {
      const served = serveStatic(req, res, publicDir, url.pathname);
      if (served) return;
    }

    return sendError(res, new ApiError('NOT_FOUND', '未找到该接口', { status: 404 }));
  }

  /** 处理需要 JSON 请求体的写接口：解析、大小限制、错误统一映射。 */
  async function withJsonBody(req, res, handler) {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.startsWith('application/json')) {
      return sendError(res, new ApiError('INVALID_CONTENT_TYPE', 'Content-Type 必须是 application/json', { status: 415 }));
    }
    let raw;
    try {
      raw = await readBodyWithLimit(req);
    } catch (err) {
      return sendError(res, new ApiError('BODY_TOO_LARGE', '请求体超过大小限制', { status: 413 }));
    }
    let body;
    try {
      body = raw.length ? JSON.parse(raw.toString('utf-8')) : {};
    } catch {
      return sendError(res, new ApiError('INVALID_JSON', '请求体不是合法 JSON', { status: 400 }));
    }
    const expectedConfigVersion = body.expectedConfigVersion;
    const payload = { ...body };
    delete payload.expectedConfigVersion;
    try {
      handler(payload, expectedConfigVersion);
    } catch (err) {
      sendError(res, err instanceof ApiError ? err : new ApiError('INTERNAL_ERROR', err.message, { status: 500 }));
    }
  }

  function sendData(res, statusCode, data) {
    res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, data }));
  }

  function sendError(res, apiError) {
    console.error(`[dashboard] error ${apiError.code}: ${apiError.message}`);
    const headers = { 'content-type': 'application/json; charset=utf-8' };
    // 请求体过大时可能还有未读完的字节留在这个连接上，明确关闭连接，
    // 避免残留数据污染同一 keep-alive 连接上的下一次请求。
    if (apiError.code === 'BODY_TOO_LARGE') headers.connection = 'close';
    res.writeHead(apiError.status || 500, headers);
    res.end(
      JSON.stringify({
        ok: false,
        error: {
          code: apiError.code,
          message: apiError.message,
          fieldErrors: apiError.fieldErrors || undefined,
          ...(apiError.extra || {}),
        },
      }),
    );
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
      const closed = new Promise((resolvePromise) => server.close(() => resolvePromise()));
      // server.close() 只是不再接受新连接，已有的 keep-alive 连接（包括
      // 客户端明明已经读完响应、只是还没主动断开的空闲连接）会一直占着，
      // 导致 close() 迟迟不 resolve、端口迟迟不释放——本地单用户面板场景
      // 下没有必要保留这些连接等它们自然超时，主动强制断开更符合"关闭
      // 就是关闭"的预期（尤其是测试里频繁开关服务器、随机选端口的场景，
      // 端口释放不及时会导致下一个测试偶发端口冲突）。
      server.closeAllConnections?.();
      return closed;
    },
  };
}

/** 写接口统一安全前置检查：同源 + CSRF token。返回 null 表示通过。 */
function guardMutatingRequest(req, port, sessionToken) {
  if (!isSameOriginRequest(req, port)) {
    return new ApiError('FORBIDDEN_ORIGIN', 'Origin 校验失败', { status: 403 });
  }
  if (!isValidToken(req, sessionToken)) {
    return new ApiError('INVALID_CSRF_TOKEN', 'CSRF token 缺失或不正确', { status: 403 });
  }
  return null;
}
