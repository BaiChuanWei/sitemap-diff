# Sitemap 监控本地控制面板 —— 网页运行控制（M3）

状态：已实现。基准：分支 `claude/zealous-goldberg-5vdqhl`，M3 开发基准 Commit `46788ad`（M2）。

## 1. 这个里程碑做了什么

M2 之前，"开始监控"只能在命令行执行 `node bin/run.js --collect --classify --report`。M3 让非技术用户能在浏览器里点一个按钮完成同样的事，并实时看到进度：

- 打开面板 → 点击"开始全部监控"（或在站点管理页勾选几个站点后"运行选中站点"）→ 后端依次执行采集 → 分类 → 生成报告，全过程在页面上实时可见 → 完成后直接在页面里查看新增 URL 和下载报告。
- 桌面快捷方式"运行 Sitemap 监控"现在是真正的一键启动，不再需要退回命令行。

**架构原则**：本里程碑不重新实现任何一行采集/分类/报告逻辑，只是给已有的 `runCollect()` / `classifyRun()` / `generateReport()` 加了一层编排（`src/dashboard/run-controller.js`）和事件回调。CLI（`bin/run.js`）完全不受影响，继续独立工作，两条路径共用同一套 `collector.lock`、同一个 SQLite。

## 2. RunController：单实例保护的两层设计

任何时刻只允许一个正式采集任务运行，用两层保护：

1. **进程内 `activeRun` 引用**：挡住同一个面板进程里的并发点击/双标签页——`POST /api/runs` 在还有 `activeRun` 时直接返回 `409 RUN_ALREADY_ACTIVE`（带 `activeRunId`，前端据此直接带用户去看那个正在进行的运行，而不是只报错）。这一层检查和随后设置 `activeRun` 之间没有任何 `await`，天然不会有并发竞态。
2. **真实的 `data/collector.lock` 文件锁**：挡住命令行 CLI 和面板之间的交叉运行——即使面板刚重启、内存里没有 `activeRun`，只要 CLI 正在跑（或者锁文件还没过期），`acquireLock()` 就会失败，面板返回 `503 COLLECTOR_LOCKED`。

`RunController` 用工厂函数 `createRunController({db, config, eventHub, collectSiteFn, classifyFetchPagesFn})` 创建，一个 Dashboard 服务进程一个实例（在 `createDashboardServer()` 里构造一次），不是模块级单例——这样多个测试用的 Dashboard 实例之间不会互相污染"活动运行"状态。

## 3. 运行生命周期

```
POST /api/runs 立刻返回 202（不等采集跑完）
  → preparing（内存态初始化 + 拿锁，同步完成）
  → collecting（调用 runCollect，逐站 site_started/site_finished 事件）
  → classifying（调用 classifyRun）—— 如果 collecting 阶段被取消，直接跳到 cancelled，不进入这一步
  → reporting（调用 generateReport）
  → completed
```

异常路径：
- `failed`：任一阶段抛出未预期异常。如果采集本身已经成功、失败发生在分类/报告阶段，`crawl_runs.status` 会被显式改写成 `failed`（不会停留在采集阶段写下的 `success`，那会让用户误以为整个流程都顺利完成了）。
- `cancelled`：见下节。

## 4. 安全停止（协作式取消）

"停止"不会杀进程、不会中断正在进行的网络请求：

- `POST /api/runs/:run_id/cancel` 只是把 `cancelRequested` 置为 `true`，广播 `run_cancel_requested`。
- `runCollect()` 内部的 `shouldCancel()` 检查只发生在**开始下一个站点之前**（`collect-runner.js` 的 for 循环顶部）——已经在 `await` 中的当前站点会正常跑完并正常写入历史，后面还没开始的站点不再被调度。
- 取消发生在采集阶段时，最终 `crawl_runs.status = 'cancelled'`，直接跳过分类和报告阶段——**不会**生成一份"看起来正常、其实什么都没分类"的报告。`GET /api/runs/:run_id/report` 对已取消的运行永远返回 `409 REPORT_NOT_READY`，即使运行早已结束、内存态已经清空（这个判断额外查了一次 `crawl_runs.status`，不只看内存里还在不在）。
- 取消发生在分类/报告阶段时（此时所有站点采集都已结束，请求会被接受、`cancelRequested` 会被置位），因为没有可以中途打断的逐条循环，运行会正常跑完变成 `completed`；前端在这两个阶段直接隐藏"安全停止"按钮，不展示一个点了也没有实际效果的按钮。
- 重复取消幂等：连续点两次不报错、不重复广播事件。
- 取消已经结束的运行返回 `409 RUN_ALREADY_FINISHED`；取消一个根本不存在的 `run_id` 返回 `404 RUN_NOT_FOUND`；取消一个存在于数据库但不是当前活动运行的"服务重启后遗留的 running 记录"返回 `409 RUN_CANCEL_NOT_ALLOWED`（没有真正在跑的进程可以响应）。

## 5. 运行模式与选中站点

`POST /api/runs` 接受两种请求体：

```json
{ "mode": "all" }
{ "mode": "selected", "siteIds": ["poki", "crazygames"] }
```

`selected` 模式的校验分两层：
1. **格式层**（`validateRunStartInput`，`src/dashboard/validation.js`）：`siteIds` 必须是非空数组、去重、每个 ID 必须匹配 `site_id` 格式（拒绝域名/URL/任意字符串）、数量不超过配置站点总数、有防御性数量上限（5000）。
2. **实时状态层**（`resolveSites`，`run-controller.js`）：即使格式校验通过，也要用**当前** SQLite 里的真实状态再确认一遍每个 `site_id` 存在且启用——不信任路由层传来的假设，因为两次请求之间站点状态可能已经变了（比如另一个标签页刚把某站点暂停）。不存在返回 `404 SITE_NOT_FOUND`，存在但已暂停返回 `422 SITE_DISABLED`。

`crawl_runs` 表新增了 `run_mode`（`'all'` | `'selected'` | `NULL`）和 `site_selection`（选中时是请求的 `site_id` JSON 数组，否则 `NULL`）两列（migration `0004_run_mode`），运行结束、内存态清空之后仍然能在 `GET /api/runs/:run_id` 里看到"这次运行的模式和范围"。CLI 触发的运行这两列永远是 `NULL`，不影响既有语义。

## 6. API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/runs/active` | 当前活动运行的快照（`null` 表示没有） |
| POST | `/api/runs` | 启动一次运行（`mode: all` \| `selected`），202 |
| POST | `/api/runs/:run_id/cancel` | 请求安全停止 |
| GET | `/api/runs/:run_id` | 运行总体详情（沿用 M1 的只读接口） |
| GET | `/api/runs/:run_id/sites` | 逐站状态表；活动运行给内存实时数据（含 waiting/running），结束后回落到 SQLite |
| GET | `/api/runs/:run_id/changes` | 分页查看本轮新增 URL，支持 `site_id`/`page`/`page_size` |
| GET | `/api/runs/:run_id/report` | 报告元数据（文件名、统计），只在报告已生成时可用 |
| GET | `/api/runs/:run_id/report/:filename` | 下载单个报告文件，`filename` 走固定白名单 |

新增错误码：`RUN_ALREADY_ACTIVE`(409)、`RUN_NOT_FOUND`(404)、`SITE_NOT_FOUND`(404)、`SITE_DISABLED`(422)、`INVALID_SITE_SELECTION`(422)、`RUN_CANCEL_NOT_ALLOWED`(409)、`RUN_ALREADY_FINISHED`(409)、`COLLECTOR_LOCKED`(503)、`REPORT_NOT_READY`(409)、`REPORT_FILE_NOT_FOUND`(404)、`INVALID_PAGE_PARAMS`(422)。所有写请求继续复用 M2 已有的 CSRF/Origin/Host 三层校验，`server.js` 的统一守卫对新路由自动生效，不需要每个路由单独实现。

## 7. 报告下载的路径安全

`GET /api/runs/:run_id/report/:filename` 的 `filename` 只允许命中固定的 5 个白名单基名（`new-urls.csv`/`new-urls.json`/`new-games.csv`/`unknown-urls.csv`/`report.md`）；实际读取的文件路径永远来自服务端自己调用 `generateReport()` 得到的 `report.files`，不会用请求里的字符串拼路径——即使 `filename` 是 `../../../etc/passwd`，也只是在 `Set.has()` 检查里被直接拒绝（404），从不接触文件系统。

## 8. 新增 URL 的分页查看

`GET /api/runs/:run_id/changes` 只读 `added_urls` LEFT JOIN `url_classifications`：

- 采集刚完成、分类阶段还没跑到某条 URL 时，`page_type` 返回"待分类"（不会伪装成 `unknown`——那是分类完成后的真实结论）。
- 分页参数 `page`（默认 1）/`page_size`（默认 50，上限 200），非法值（非正整数、超过上限）一律 422 `INVALID_PAGE_PARAMS`。
- `type` 参数目前只接受 `added`（或不传）——本里程碑没有 missing/removed/restored 的概念，明确不支持其它值，避免前端或未来开发者传别的值时静默返回空结果误以为"没有变化"。

## 9. 明确排除的范围

不实现 M4 的 missing/confirmed_removed/restored；不改变"新增 URL"的既有定义（仍然是 `added_urls` 的"首次出现"语义）；不引入 AI；不做取消已完成运行、不做永久删除运行记录；分类/报告阶段本身没有可中途打断的能力（见第 4 节）。
