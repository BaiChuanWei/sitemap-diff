export const SERVICE_NAME = 'sitemap-dashboard';

/** GET /api/health：用于探测"这个端口是不是本项目自己的服务"。 */
export function getHealth({ port, dbPath, startedAt }) {
  return {
    status: 'ok',
    service: SERVICE_NAME,
    pid: process.pid,
    port,
    dbPath,
    startedAt,
    nowIso: new Date().toISOString(),
  };
}
