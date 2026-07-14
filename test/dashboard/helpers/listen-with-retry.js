import { createDashboardServer } from '../../../src/dashboard/server.js';

// 故意和历史遗留的 28711(+500/+1000/+1500/+2500) 端口范围完全不重叠——
// 除了"监听时端口冲突"（listen() 直接抛 EADDRINUSE，下面会重试）之外，
// 还观测到另一类更隐蔽的冲突：Node fetch()（undici）按 host:port 缓存
// 连接池，如果端口号在短时间内被两个不同的 dashboard 实例先后复用，
// 客户端可能复用一个指向"已经关闭的旧服务器"的陈旧连接，表现为随机的
// "fetch failed"，而不是本次 listen() 失败——重试 listen() 本身治不好这
// 类问题，只有从源头上大幅降低"同一个端口号在同一次测试运行里被复用"
// 的概率才行。把这批测试整体挪到一段历史范围完全没用过的高位区间，
// 是成本最低、风险最小的做法（不用改动"要不要重试"这类共享判定逻辑）。
const PORT_BASE = 40000;
const PORT_SPAN = 10000;

/**
 * 测试专用：createDashboardServer + listen()，端口冲突时换一个端口重试。
 *
 * 背景：Host 校验（防 DNS rebinding）要求端口在构造时就确定，所以测试不能用
 * `listen(0)` 交给操作系统分配——只能自己挑一个"高位、不太可能被占用"的端口。
 * 但 `node --test` 默认并发跑多个测试文件（每个文件一个进程），当很多 dashboard
 * 测试文件同时从同一段数字里随机挑端口时，端口冲突的概率并不低（生日悖论），
 * 偶发导致某个测试的 fetch() 打到了别的文件的服务器上，或者本该拿到的端口已被
 * 占用——这不是应用代码的问题，是测试基础设施本身的可靠性问题，必须解决，
 * 不能留着变成一个"重跑一次就好了"的已知 flaky 测试。
 *
 * 真实 CLI 场景（bin/dashboard.js）不会用到这个函数——那里的端口在调用
 * createDashboardServer 之前已经用 probeExisting() 显式确认过是空闲的，
 * "端口被占用就报错、不静默换端口"这条硬性要求只约束那条路径，和这里的
 * 测试基础设施是两回事。
 */
export async function createAndListenDashboard(options, { maxAttempts = 8 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = PORT_BASE + Math.floor(Math.random() * PORT_SPAN);
    const dashboard = createDashboardServer({ ...options, port });
    try {
      await dashboard.listen();
      return { dashboard, port };
    } catch (err) {
      lastErr = err;
      await dashboard.close().catch(() => {});
      if (err?.code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error(`连续 ${maxAttempts} 次都没能找到空闲端口: ${lastErr?.message}`);
}
