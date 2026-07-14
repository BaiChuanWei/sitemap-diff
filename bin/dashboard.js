#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { loadLocalConfig } from '../src/config.js';
import { createDashboardServer, SERVICE_NAME } from '../src/dashboard/server.js';

/**
 * 本地面板启动入口：node bin/dashboard.js
 *
 * 端口默认 8766，可用环境变量 SITEMAP_DASHBOARD_PORT 覆盖。
 * 只监听 127.0.0.1，不提供局域网/公网访问。
 */
const DEFAULT_PORT = 8766;

async function main() {
  const port = Number(process.env.SITEMAP_DASHBOARD_PORT) || DEFAULT_PORT;
  const config = loadLocalConfig();

  const probe = await probeExisting(port);
  if (probe.status === 'self') {
    console.log(`检测到 ${SERVICE_NAME} 已经在 http://127.0.0.1:${port} 运行（pid=${probe.pid}），不重复启动。`);
    console.log(`请直接打开浏览器访问: http://127.0.0.1:${port}`);
    return;
  }
  if (probe.status === 'other') {
    console.error(`端口 ${port} 已被其它程序占用（不是本项目的服务）。`);
    console.error(`请通过环境变量 SITEMAP_DASHBOARD_PORT 指定一个空闲端口后重试，例如：`);
    console.error(`  SITEMAP_DASHBOARD_PORT=8899 node bin/dashboard.js`);
    process.exitCode = 1;
    return;
  }

  const dashboard = createDashboardServer({ config, port });
  try {
    await dashboard.listen();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`端口 ${port} 已被占用，且未能识别为本项目服务，启动失败。`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  console.log(`${SERVICE_NAME} 已启动: http://127.0.0.1:${port}`);
  console.log(`数据库: ${config.dbPath}`);
  console.log('按 Ctrl+C 停止服务。');

  const shutdown = async () => {
    console.log('\n正在停止服务...');
    await dashboard.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** 探测端口是否已经被本项目自己的面板服务占用（避免重复启动第二个实例）。 */
export async function probeExisting(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
      headers: { host: `127.0.0.1:${port}` },
    });
    if (!res.ok) return { status: 'other' };
    const body = await res.json();
    const data = body.data || body; // 兼容非本项目服务返回的非信封格式响应
    if (data.service === SERVICE_NAME) return { status: 'self', pid: data.pid };
    return { status: 'other' };
  } catch (err) {
    if (err.cause?.code === 'ECONNREFUSED' || err.name === 'TimeoutError') return { status: 'free' };
    return { status: 'free' };
  }
}

/**
 * 判断当前模块是不是被直接以 CLI 方式运行（而不是被测试 import）。
 *
 * 不能用 `file://${argv1}` 手拼 URL 字符串跟 metaUrl 比较——Windows 上
 * process.argv[1] 是反斜杠路径（如 D:\sitemap监控\bin\dashboard.js），
 * import.meta.url 却是正斜杠 file:// URL（如
 * file:///D:/sitemap监控/bin/dashboard.js），两种格式永远不相等，导致
 * isMainModule 恒为 false、main() 永远不会被调用——进程会立刻正常退出，
 * 不留任何错误堆栈或日志，非常难排查。pathToFileURL() 是 Node 内置的
 * 跨平台路径→file URL 转换，不需要手工处理分隔符差异，且在真实 Windows
 * 环境验证过能正确工作（本函数的 toFileUrl 参数只是为了让这条判断逻辑
 * 本身可以在任意平台上被单元测试覆盖，不代表运行时会用别的实现）。
 */
export function computeIsMainModule(argv1, metaUrl, toFileUrl = pathToFileURL) {
  return Boolean(argv1) && metaUrl === toFileUrl(argv1).href;
}

if (computeIsMainModule(process.argv[1], import.meta.url)) {
  main();
}
