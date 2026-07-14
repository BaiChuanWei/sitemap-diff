# Sitemap 监控本地控制面板 —— 实时进度与前端行为（M3）

状态：已实现。本文档说明"实时运行"页面的前端设计，是 `dashboard-run-control.md`（后端 API/状态机）的前端对应篇。

## 1. 核心原则：服务端快照是唯一事实来源

> 前端不得单纯通过事件累加统计。服务端快照和 SQLite 是最终事实来源。

SSE 事件在前端**只是"该刷新了"的信号**，不携带任何前端用来累加/拼装状态的数据本身。收到任意运行相关事件（`run_started`/`site_started`/`site_finished`/`run_finished`/...共 12 种）后，一律重新 `GET /api/runs/active` + `GET /api/runs/:run_id/sites` 拿权威状态再整体重渲染（`app.js` 的 `refreshRunView()` → `doRefreshRunView()`）。这样浏览器刷新、SSE 断线重连、同时开两个标签页都不会导致统计数字翻倍或漂移——因为前端从来不"加",只"读"。

刷新用一个协作式的"合并请求"包装（`state.run.refreshInFlight`/`refreshQueued`）：如果上一次刷新还没返回，新的刷新请求只是打个标记，等当前请求结束后再补一次，不会让大量并发的 SSE 事件（比如 101 个站点，每站至少 2 个事件）堆积出成百上千个并发的 `fetch()`。

## 2. 实时运行页面的三个面板

`#tab-run` 下有三个互斥展示的面板（`showRunPanel(id)` 负责切换）：

| 面板 | 何时展示 |
|---|---|
| `run-idle-panel` | 没有活动运行时。展示"上次运行异常中断"提示（如果有）+ "最近一次运行"摘要（不限模式，带"查看详情/报告"按钮）+ "开始全部监控"按钮 |
| `run-active-panel` | 有活动运行时（也复用来展示"刚结束/历史某次运行"的完整详情——见第 4 节） |
| `run-changes-panel` | 从站点表格点"查看新增"进入的分页新增 URL 列表 |

## 3. 站点实时表格

每站一行：顺序号、`site_id (domain)`、状态（文字 + 颜色徽标，不是只靠颜色区分）、页面 URL 数、新增数（有新增时加粗）、是否 baseline、耗时、错误摘要、操作（有新增时才显示"查看新增"按钮）。状态取值 `waiting`/`running`/`success`/`partial`/`failed`——前两个只在运行**进行中**才可能出现（`site_crawl_runs` 表本身不记录"还没开始"/"正在跑"这种瞬时状态，只有站点真正跑完才会有一行记录），来自 `RunController` 的内存态；运行结束后再查询同一个 `run_id`，会自动回落到从 SQLite 读（历史视图不再有 waiting/running，符合"已经结束的运行不该显示正在进行中"的直觉）。

支持按 `site_id`/域名搜索、按状态筛选、"只看有新增"筛选，全部是前端对已经拿到的数据做的过滤，不产生新的网络请求。

## 4. "活动运行"和"历史运行详情"复用同一套渲染

`renderRunActive(active, sites)` 处理进行中的运行；`renderRunFinished(runId)` 处理已经结束的运行（无论是这次会话里刚跑完的，还是通过"查看详情/报告"从空闲页翻出来的历史运行）——两者渲染出的 DOM 结构一致（同一批 `#run-header-cards`/`#run-sites-table`/`#run-report-block` 元素），只是数据来源不同（前者读内存快照，后者读 `GET /api/runs/:run_id` + `GET /api/runs/:run_id/sites` + `GET /api/runs/:run_id/report`）。报告区块的展示/隐藏完全由"这次调用 `GET /api/runs/:run_id/report` 成功还是 409"决定，不需要前端自己判断"这个运行是不是该有报告"——后端已经把"取消的运行不该有报告"这个规则封装在了 `REPORT_NOT_READY` 里（见 `dashboard-run-control.md` 第 4 节）。

## 5. 页面刷新与断线恢复

页面加载（`init()`）：
1. 拿 CSRF token（`/api/health`）。
2. 如果 URL 带 `?action=start-all`，走桌面快捷方式流程（见第 7 节）。
3. 否则调用 `initialRunCheck()`：查 `GET /api/runs/active`，如果有活动运行，自动切换到"实时运行" tab 并展示——用户不需要自己去找，符合"浏览器刷新后不能显示'没有运行'"的要求。如果没有活动运行，停留在默认的"总览" tab（这时如果用户自己点进"实时运行" tab，会看到空闲页 + 上次运行摘要，见第 2 节）。

SSE 断线重连：浏览器原生 `EventSource` 自动重连，重连后会重新收到一次 `connected` 事件——前端记录"是否发生过断线"（`everDisconnected`），如果发生过，下一次 `connected` 事件会触发一次 `refreshRunView()`，补上断线期间可能错过的事件，不依赖"恰好下一个事件很快到达"这种运气。

## 6. 服务重启后的异常中断记录

如果面板服务重启时数据库里有 `status='running'` 但明显是旧记录的 `crawl_runs` 行（内存里已经没有对应的 `activeRun`），这是 M1 就有的 `staleRunningRun` 检测（`GET /api/overview`）在 M3 场景下的直接应用：空闲页会展示"上次运行异常中断（run_id=...，开始于...）。该记录不会自动继续，也不会被当作已完成"，并提供"开始全部监控"按钮开始新的运行。旧记录本身不会被删除或改写，只是不参与任何自动恢复逻辑——这是明确的设计决定，不是遗漏。

## 7. 桌面快捷方式的一键启动

"运行 Sitemap 监控"快捷方式执行 `run-and-open-dashboard.ps1`：确保面板服务运行（复用 `start-dashboard.ps1` 的健康检查/启动逻辑，加 `-NoBrowser` 避免打开两个浏览器窗口）→ 打开浏览器到 `http://127.0.0.1:<port>/?action=start-all`。

真正"点一下就开始"的逻辑在前端（`handleStartAllQueryParam()`），不在 PowerShell 里——这样只有一套 CSRF token 获取/请求发送逻辑，不需要在 PowerShell 里重新实现一遍认证：

1. 页面正常加载，拿到 CSRF token。
2. 从 URL 上把 `?action=start-all` 摘掉（`history.replaceState`），确保用户之后刷新页面不会重复触发启动。
3. 查询 `GET /api/runs/active`：如果已经有活动运行（比如用户手快点了两次快捷方式），直接展示那个运行，不重复启动、不报错。
4. 否则调用 `POST /api/runs {mode:'all'}`——点击桌面快捷方式本身就是用户的明确意图，这里不再弹二次确认框（和"总览"页里手工点击"开始全部监控"按钮需要二次确认不同，那个按钮点击本身不足以确认"用户真的想现在开始"）。

## 8. 安全要求延续

所有新增写接口（`POST /api/runs`、`POST /api/runs/:id/cancel`）自动获得和 M2 完全相同的 Host/Origin/CSRF 三层校验（在 `server.js` 的请求分发最外层统一处理，新路由不需要也不应该重新实现）。`GET /api/runs/:id/report/:filename` 的路径安全见 `dashboard-run-control.md` 第 7 节。前端渲染新增 URL 的原始链接/域名时同样一律用 `textContent`/DOM API 赋值，不使用 `innerHTML`（沿用 M2 的静态检查约束，`test/dashboard/e2e.test.js` 对 `app.js` 做了正则校验，任何后续修改都不能引入 `innerHTML =`）。

## 9. 已验证但不属于本里程碑范围的边界

以下场景已经过真实 Chromium 浏览器验证（脚本未提交仓库）：站点管理页勾选/全选/暂停站点不可选、运行选中站点的确认摘要、进度条与"已完成 X/Y"实时更新、站点表格里"进行中"状态的实时展示、报告文件真实可下载、路径穿越/非白名单文件拒绝、刷新页面后从空闲页找回最近一次运行、安全停止的完整流程（含"已提交停止请求"提示与被取消运行不生成报告）。

以下场景明确保留给未来里程碑，本阶段不实现：分类/报告阶段的真正中途取消（技术上没有可中断的逐条循环，见 `dashboard-run-control.md` 第 4 节）；"运行选中站点"里预先按优先级/上次失败原因智能推荐选择；多个面板窗口/多用户协作提示（当前多标签页场景靠 `RUN_ALREADY_ACTIVE` 的 409 兜底，不做更复杂的多端同步 UI）。
