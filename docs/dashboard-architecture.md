# Sitemap 监控本地控制面板 —— 架构设计（M0）

状态：设计阶段（M0），未修改任何生产代码。
基准：分支 `claude/zealous-goldberg-5vdqhl`，Commit `8b83df6d5136d8c4c31eb8ba860485d761232253`，177/177 测试通过。

## 1. 现状审计

### 1.1 CLI 入口（`bin/run.js`）
- 单文件 CLI，`parseArgs()` 手写参数解析，`main()` 按参数分支到各命令函数。
- 关键命令：`--collect [--site <id>] [--classify] [--report]`、`--classify-run <id>`、`--report-run <id>` / `--report-latest`、`--db-status`、`--inspect-site <id>` / `--inspect-url <url>`、`--diagnose-site <id>`。
- ESM 入口守卫：`const isMainModule = process.argv[1] && import.meta.url === \`file://${process.argv[1]}\`; if (isMainModule) { main(); }`，允许安全 `import` 供测试和面板复用，不会误触发真实采集。
- `loadRecords(config)`、`saveDiagnostics(config, siteId, diag)` 已导出，可直接复用。

### 1.2 配置加载（`src/config.js`）
- `loadLocalConfig(overrides)`：返回 `dbPath`、`sitesCsvPath`、`outputDir`、`lockPath`、`siteLimitsCsvPath`、`siteSitemapsCsvPath`，全部支持 `overrides` 覆盖（测试用临时目录的标准方式）。
- `parseSitesCsv(csvText)`：通用 CSV 解析（支持双引号转义），非 `sites.csv` 专用，`site-limits.csv`/`site-sitemaps.csv` 复用同一解析器。
- `loadSiteOverrides(config, { knownSiteIds })`：加载并校验站点级限制覆盖 + 手工 Sitemap 配置，文件不存在时返回空 Map，内容非法时直接抛错（不静默）。
- 面板的配置读取应直接复用这三个函数，不得重新实现 CSV 解析。

### 1.3 SQLite Schema（`src/db/migrations/*.up.sql`）
- `0001_baseline`：`sites` 表（site_id 主键、domain/priority/enabled/robots_url/sitemap_url/expected_game_path/notes）。
- `0002_url_history`：`sites` 增列（`last_attempt_at`/`last_success_at`/`last_status`/`last_error`/`baseline_completed_at`），新增 `sitemap_endpoints`、`seen_urls`（`UNIQUE(site_id, url_hash)`）、`crawl_runs`、`site_crawl_runs`（`UNIQUE(run_id, site_id)`）、`added_urls`（**`UNIQUE(site_id, url_hash)`，不含 run_id**——同一站点同一 URL 全生命周期只会被记为"新增"一次，这是"累计首次出现"语义，不是"逐轮快照对比"语义）。
- `0003_url_classification`：`url_classifications`（`UNIQUE(run_id, site_id, url_hash)`）。
- **对 M4（减少/恢复）的关键影响**：现有 `added_urls` 表结构无法直接支撑"本轮快照 vs 上一轮快照"的 missing/restored 判定，因为它只关心"历史上第一次出现"。M4 必须新增独立的"当前快照"表（如 `current_snapshot(site_id, url_hash, ...)`）和"变化事件"表（如 `url_changes(run_id, site_id, url_hash, change_type, detected_at)`），通过新迁移 `0004_snapshot_changes` 引入，不修改 `seen_urls`/`added_urls` 的既有唯一约束和语义。本轮（M0+M1）不涉及此迁移，仅在此记录设计结论。
- `openDb(dbPath)` 已经开启 `journal_mode = WAL` 和 `foreign_keys = ON`——满足"建议使用 WAL"的要求，无需改动，读写面板可直接复用同一个 `openDb()`。WAL 模式下，只读面板与 CLI 采集进程可以并发访问同一数据库文件而不互相阻塞（每次面板请求应短连接查询后立即释放，不得长期持有事务）。

### 1.4 采集编排（`src/collect-runner.js`）
- `runCollect(db, { sites, runId, collectSiteFn, limits, siteLimitOverrides, siteSitemapOverrides, now })`：逐站顺序调用 `collectSiteFn`，按 `isAdmissible()` 决定写正式历史还是只写诊断，单站失败不终止批次。
- 面板要接入"实时事件"（M3 范围），最小侵入方式是给 `runCollect` 增加一个可选 `onEvent(type, payload)` 回调参数，在现有关键节点（每站开始/结束、run 开始/结束）调用，**不改变默认行为**（不传回调时行为与现在完全一致，177 个现有测试断言的返回值结构不变）。本轮不实现，仅记录设计方向。

### 1.5 分类与报告（`src/classify/*`、`src/report/*`）
- `classifyRun(db, { runId })`、`generateReport(db, { runId, outputDir })` 均为幂等、可重复调用的纯函数式接口，天然适合被面板的"查看最近结果"只读页面直接复用（读 DB，不重新触发采集）。

### 1.6 运行锁（`src/lock.js`）
- `acquireLock`/`releaseLock`/`readLock`，文件级 `wx` 独占创建 + PID/存活时间双重校验陈旧锁，已经是"防重复启动"和"防僵尸锁"的完整实现。面板的"开始全部监控"必须复用这套锁，不得重新发明进程间互斥机制。

### 1.7 现有测试（177/177）
- `node:test` 内置测试运行器，`npm test` = `node --test`（自动发现 `test/**/*.test.js`）。
- 全部使用临时目录/临时 DB/本地 HTTP 测试服务器（`test/helpers/http-server.js`），不依赖真实公网站点——面板新增测试必须延续这一约束。

### 1.8 Windows 路径处理现状
- 全部路径处理走 `node:path` 的 `resolve`/`join`/`dirname`，未见任何硬编码 `/` 分隔符或沙盒绝对路径。`loadLocalConfig()` 用 `fileURLToPath(import.meta.url)` 反推项目根目录，不依赖当前工作目录，Windows 下应可直接工作。中文路径的唯一现实风险点是 PowerShell 脚本本身的编码问题（见威胁模型文档）。

### 1.9 可复用模块清单
`loadLocalConfig`、`loadRecords`、`loadSiteOverrides`、`resolveSiteLimits`/`resolveSiteSitemaps`、`openDb`、`getDbStatus`、`diagnoseSite`、`saveDiagnostics`、`classifyRun`、`generateReport`、`acquireLock`/`releaseLock`/`readLock`、`runCollect`（M1 只读，不调用）。

### 1.10 必须新增的迁移（记录，不在本轮实现）
- `0004_snapshot_changes.up.sql`：`current_snapshot` + `url_changes`（M4）。

### 1.11 兼容性风险
- `runCollect` 的 `onEvent` 回调是唯一计划中的"侵入式"改动，必须保证不传回调时行为完全不变，用现有 collect-runner 测试 + 新增"事件回调可选"测试双重覆盖（M3 阶段处理）。
- 面板进程与 CLI 采集进程可能同时运行：面板只读页面查库不受影响（WAL 支持并发读），但面板发起"开始采集"必须走同一把 `collector.lock`，否则会破坏"防重叠执行"的现有保证。

## 2. 架构选择

### 2.1 技术栈
| 层 | 选择 | 理由 |
|---|---|---|
| HTTP 服务 | Node 内置 `node:http` | 零依赖，`npm install` 后无需 `npm run build`；项目本身已是 ESM + Node 20+，无需额外运行时 |
| 路由 | 手写最小路由表（Map + 正则），不引入 Express/Koa | 端点数量可控（~15 个），手写路由比引入框架更符合"最少组件"原则，且避免框架版本升级带来的兼容性负担 |
| 前端 | 原生 HTML + CSS + `<script>` 标签内联/独立 `.js`，无框架 | 无需 `npm run build`，`node bin/dashboard.js` 后浏览器直接加载静态文件即可运行 |
| 实时更新 | SSE（`EventSource`，`GET /api/events`） | 单向服务器推送场景下比 WebSocket 更简单（无需处理客户端消息、心跳/重连是浏览器原生行为），HTTP/1.1 长连接足够本地单用户场景 |
| 数据库 | 沿用现有 `better-sqlite3` + WAL | 已验证兼容，不新增依赖 |
| 桌面入口 | PowerShell 脚本 + 快捷方式，不用 Electron | 避免引入完整 Chromium 运行时（体积、更新、打包复杂度都不成比例地大于收益），本地工具用系统默认浏览器完全够用 |

### 2.2 未选择的方案及理由
- **Electron**：会把项目从"一个 Node 脚本"变成"需要打包分发的桌面应用"，引入 `electron-builder`/签名/自动更新等一整套复杂度，且需要单独维护主进程/渲染进程的 IPC 边界。本项目是单用户本地工具，系统默认浏览器 + 一个本地 HTTP 服务已经能达到"点击快捷方式即用"的体验，不需要 Electron 的跨平台打包能力（目标平台就是 Windows 本地）。
- **React / 类似前端框架**：需要构建步骤（Webpack/Vite/esbuild），违反"不得要求独立 npm build 才能运行"的硬性约束。M1-M4 的页面复杂度（表格、表单、SSE 事件流）用原生 DOM API 完全可以维护，不需要虚拟 DOM 或组件框架。
- **Next.js**：同时引入了框架构建步骤和服务端渲染复杂度，与"最小组件"原则冲突，且本项目不需要 SSR（本地单用户，无 SEO 需求）。
- **Supabase / 云端数据库**：CLAUDE.md 明确禁止；且本工具的数据本来就应该留在用户本地磁盘。
- **Redis / 消息队列**：单进程、单用户、请求量极小（一次采集几十到上百个站点），内存中的 `Map`/`EventEmitter` 已经能满足运行状态跟踪和事件广播需求，引入 Redis 是过度工程。
- **Docker**：Windows 本地单用户工具的目标是"双击运行"，Docker Desktop 本身对非技术用户是巨大的额外安装/学习成本，与"方便非技术用户使用"的第一性原理直接冲突。

### 2.3 目录结构（规划）
```
bin/
  run.js            既有 CLI，不改动
  dashboard.js      新增：面板启动入口（node bin/dashboard.js）
src/
  dashboard/
    server.js       HTTP 服务器 + 路由表
    routes/
      health.js
      overview.js
      sites.js       （M2 起才有写操作）
      runs.js        （M3 起才有写操作）
      events.js      SSE endpoint
    security.js      Origin 校验、CSRF token、请求体大小限制
    static.js        静态文件服务（public/ 下的 html/css/js，只读）
public/
  dashboard/
    index.html
    app.js
    style.css
scripts/
  start-dashboard.ps1
  run-and-open-dashboard.ps1
  stop-dashboard.ps1
  create-desktop-shortcuts.ps1
docs/
  dashboard-architecture.md   本文档
  dashboard-threat-model.md
  dashboard-test-plan.md
test/
  dashboard/
    *.test.js
```

### 2.4 端口与单实例
- 默认 `127.0.0.1:8766`，可用 `SITEMAP_DASHBOARD_PORT` 覆盖。
- 启动时先探测端口：若响应 `/api/health` 且返回本项目的服务标识（如固定 JSON 字段 `service: "sitemap-dashboard"`），视为"本项目已运行"，直接打开浏览器，不重复启动第二个服务进程。若端口被占用但不是本项目的服务，直接报错退出，不静默切换到随机端口（用户要求的硬性行为）。

## 3. 本轮（M0+M1）范围边界
M1 只实现：`/api/health`、只读总览、只读站点列表、只读运行历史、只读最新结果、基础中文 UI、SSE 连接骨架（仅心跳，无真实采集事件）、PowerShell 启动/停止/创建快捷方式脚本。不涉及配置写入、不触发采集、不修改快照语义、不加 AI 接口、不修改现有数据库历史（面板对 DB 只做 `SELECT`）。
