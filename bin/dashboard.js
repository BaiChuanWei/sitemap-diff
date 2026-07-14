#!/usr/bin/env node
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
    if (body.service === SERVICE_NAME) return { status: 'self', pid: body.pid };
    return { status: 'other' };
  } catch (err) {
    if (err.cause?.code === 'ECONNREFUSED' || err.name === 'TimeoutError') return { status: 'free' };
    return { status: 'free' };
  }
}

// 只有直接以 CLI 方式运行才启动服务；被测试 import 时不会触发 main()，
// 与 bin/run.js 的既有约定保持一致。
const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main();
}
