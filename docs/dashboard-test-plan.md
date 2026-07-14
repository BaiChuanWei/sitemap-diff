# Sitemap 监控本地控制面板 —— 测试计划（M0）

状态：设计阶段（M0）。本文档列出 M1-M6 全部规划中的测试类别，并标注本轮（M1）实际落地的子集。

## 1. 测试原则
- 沿用项目现有原则：自动测试不依赖公网真实站点，一律用 `test/helpers/http-server.js` 起本地假 Sitemap 服务器，或直接注入 `fetchImpl`。
- 面板新增测试与现有 177 个测试共存于 `node --test` 体系下，不引入第二套测试框架（如 Jest/Vitest）。
- 每个新测试文件放在 `test/dashboard/` 下，命名延续现有 `*.test.js` 约定。
- 浏览器端到端测试：不引入 Playwright/Puppeteer 等重量级浏览器自动化依赖（与"最少组件"冲突）；改用"用 Node 内置 `fetch` 直接请求 HTTP 接口 + 断言返回的 HTML/JSON 内容"的轻量端到端方式覆盖"页面能正确渲染关键数据"这一诉求，真正的像素级/交互级浏览器验证归入"Windows 本地待验证"清单（见 M0/M1 报告）。

## 2. 测试类别（全量规划）

| 类别 | 覆盖里程碑 | 本轮(M1) |
|---|---|---|
| API 单元测试（每个 endpoint 的正常/异常路径） | M1 起 | ✅ 落地 `/api/health`、只读 overview/sites/runs |
| 配置原子写入测试 | M2 | 规划，不落地 |
| SSE 事件测试 | M1 骨架 + M3 真实事件 | ✅ 落地连接/心跳/断线，M3 前无真实业务事件 |
| 运行控制器测试（防重复启动等） | M3 | 规划，不落地 |
| 重复启动测试 | M3 | 规划，不落地 |
| 快照 diff 测试 | M4 | 规划，不落地 |
| missing/confirmed_removed/restored 测试 | M4 | 规划，不落地 |
| partial 不更新快照测试 | M4 | 规划，不落地 |
| 导出一致性测试 | M4/M5 | 规划，不落地 |
| 安全输入测试（XSS/路径穿越/超大 body） | M1 起 | ✅ 落地：静态文件路径穿越拒绝、请求体大小限制骨架、Origin/Host 校验 |
| 中文路径测试 | M1 起 | ✅ 落地：`loadLocalConfig` 覆盖到含中文的临时目录路径 |
| PowerShell 脚本静态测试 | M1 | ✅ 落地：语法/关键字符串静态检查（沙盒无 Windows PowerShell 运行时，只能做文本级校验，见风险清单） |
| 浏览器端到端测试 | M1 起（轻量版） | ✅ 落地：HTTP 请求 + HTML/JSON 内容断言 |
| 本地模拟 Sitemap 服务器测试 | 沿用现有 `test/helpers/http-server.js` | ✅ 已有基础设施可直接复用（M3+ 用到） |
| 服务重启恢复测试 | M1 起 | ✅ 落地：模拟"服务重启后总览数据从 DB 重新加载，不归零" |

## 3. M1 具体测试清单

### 3.1 `test/dashboard/server.test.js`
1. 服务只绑定 `127.0.0.1`（`server.address().address` 断言）。
2. `GET /api/health` 返回 200 + `{ status: 'ok', service: 'sitemap-dashboard', ... }`。
3. 端口被本项目自身占用时，第二次启动尝试能识别并复用（通过 health 探测逻辑单测，而非真的起两个进程）。
4. 端口被非本项目服务占用时，启动逻辑返回明确错误而非静默换端口。
5. 未知路由返回 404（不是未处理异常导致进程崩溃）。
6. Host header 不是 `127.0.0.1:<port>` 时拒绝（DNS rebinding 防护）。

### 3.2 `test/dashboard/overview.test.js`
1. 空数据库：总览接口返回全 0 状态，不抛错。
2. 有历史数据：`GET /api/overview` 返回的站点总数/成功数/最近运行与直接查库结果一致。
3. `GET /api/sites` 返回的字段与 `config/sites.csv` + DB 里的 `sites` 表状态一致（只读合并展示）。
4. `GET /api/runs` 按时间倒序返回，字段与 `crawl_runs` 表一致。
5. "服务重启恢复"：模拟先写入几条历史数据到临时 DB，再新建一个 server 实例指向同一 DB，断言总览接口立刻能看到这些历史数据（不依赖进程内存状态）。

### 3.3 `test/dashboard/events.test.js`（SSE 骨架）
1. `GET /api/events` 返回 `Content-Type: text/event-stream`。
2. 建立连接后能收到至少一次心跳事件。
3. 客户端断开后服务端正确清理连接（不泄漏），可通过"断开后再连接仍能正常收到心跳"间接验证。
4. 达到最大并发连接数后，新连接收到明确的拒绝而不是被挂起。

### 3.4 `test/dashboard/security.test.js`
1. 静态文件服务拒绝路径穿越请求（如 `GET /dashboard/../../../etc/passwd` 之类的尝试，实际以 URL 编码/相对路径变体测试，断言不会读到 `public/dashboard` 之外的文件）。
2. Origin 不匹配时，未来写接口（M2 起）会被拒绝——本轮先测试"校验函数本身"（纯函数单测，不依赖真实写接口存在）。
3. 请求体超过大小上限时中间件正确拒绝（用一个临时的测试专用 POST 路由验证限制逻辑本身）。

### 3.5 `test/dashboard/config-paths.test.js`（中文路径）
1. `loadLocalConfig({ outputDir: <含中文的临时目录> })` 能正常创建/写入文件（复用现有 `loadLocalConfig` 机制，验证面板场景下路径处理无额外假设）。
2. 面板 `server.js` 用含中文的项目根目录路径启动时，静态文件仍能正确定位并返回。

### 3.6 `scripts/*.ps1` 静态测试
- 沙盒环境没有 Windows PowerShell 运行时，无法真正执行 `.ps1`。改用文本级静态检查（Node 脚本读取 `.ps1` 内容，正则校验）：
  1. 文件以 UTF-8 BOM 开头（`EF BB BF`）。
  2. 不包含硬编码的绝对沙盒路径（如 `/home/user/...`、`/tmp/...`）。
  3. 不包含硬编码的用户桌面绝对路径（如写死的 `C:\Users\XXX\Desktop`），必须通过 `[Environment]::GetFolderPath('Desktop')` 等 API 动态获取。
  4. 使用 `$PSScriptRoot` 或等效方式定位项目根目录，不依赖脚本调用时的当前工作目录。
  5. 找不到 `node` 命令时有中文错误提示分支（正则匹配脚本中存在这一段逻辑）。
- **明确标注**：这只是静态文本校验，不等于脚本在真实 PowerShell 5.1/7 环境下语法正确或行为正确，真实运行验证列入"Windows 本地待验证清单"。

## 4. 明确不在本轮测试范围
配置写入、采集触发、SSE 真实业务事件、快照/missing/restored、导出、AI 审查包、任何需要真实 Windows PowerShell 运行时执行的验证。
