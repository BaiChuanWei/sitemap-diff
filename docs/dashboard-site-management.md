# Sitemap 监控本地控制面板 —— 站点可视化管理（M2）

状态：已实现。基准：分支 `claude/zealous-goldberg-5vdqhl`，M2 开发基准 Commit `440dcfe`（M0+M1）。

## 1. 这个里程碑做了什么

M1 的"站点管理"只能看（只读表格）。M2 让非技术用户能在浏览器里完成日常配置维护，不用再手工编辑 CSV：

- 新增站点、编辑站点基础信息。
- 暂停 / 恢复监控（不是删除——历史数据永远保留）。
- 查看并编辑单个站点的高级限制（`config/site-limits.csv` 对应的 6 个字段）。
- 查看并编辑单个站点的手工 Sitemap 声明（`config/site-sitemaps.csv`）。
- 从面板触发一次只读诊断（复用 Milestone 5A-P1 的 `diagnoseSite()`），不写任何数据库表。

**没有做的事（明确排除在本里程碑之外）**：真正触发一次采集、采集进度展示、取消采集、"当前快照"视图、缺失/恢复 URL 判定、AI 辅助功能、永久删除站点。这些留给 M3 及以后。

## 2. 配置文件仍然是唯一权威来源

面板**不**引入第二套配置存储。三份 CSV 文件的地位不变：

| 文件 | 内容 |
|---|---|
| `config/sites.csv` | 站点基础信息：site_id / domain / priority / enabled / robots_url / sitemap_url / expected_game_path / notes / site_category |
| `config/site-limits.csv` | 站点级限制覆盖（可选，留空字段=使用系统默认值） |
| `config/site-sitemaps.csv` | 手工 Sitemap 声明（可选，`merge` 模式与自动发现合并，`manual_only` 模式完全替代自动发现） |

面板的所有写操作最终都是"读三份 CSV → 在内存里生成新版本 → 原子写回三份 CSV → 同步进 SQLite `sites` 表"，具体机制见 `dashboard-security.md`。用户仍然可以直接用文本编辑器改这三份文件——面板服务重启后会重新读取；面板运行期间外部改动会在下次保存时通过 `configVersion` 冲突检测出来（见第 5 节）。

## 3. 数据模型：CSV 配置 + SQLite 运行状态

`GET /api/sites/:site_id` 把两部分合并返回：

- `config`：来自 CSV 的当前配置行。
- `runtime`：来自 SQLite `sites` 表的运行时状态（`last_status`/`last_success_at`/`last_error`/`baseline_completed_at` 等，由 CLI 采集运行时写入，面板只读不写）。
- `limits` / `sitemaps`：来自另外两份 CSV 中属于该站点的行。
- `configVersion`：当前三份 CSV 内容的版本号（见第 5 节）。

这两部分永远不会冲突，因为面板从不直接写 `runtime` 字段——那是 CLI 采集运行时的职责。

## 4. 站点字段与校验规则

新增/编辑站点接受以下字段（`POST /api/sites`、`PATCH /api/sites/:site_id`）：

| 字段 | 规则 |
|---|---|
| `site_id` | 仅小写字母/数字/下划线/连字符，1-64 位，必须以字母或数字开头；**创建后不可修改**（关联 SQLite baseline 与历史数据，重命名需要单独的迁移能力，本阶段不实现） |
| `domain` | 纯域名，不含协议/端口/路径/参数/空格；拒绝 `localhost`/内网 IP/链路本地地址（SSRF 防护，见 `dashboard-security.md`）；同一域名不能被两个站点同时使用 |
| `priority` | `high` / `medium` / `low` 之一，留空默认 `medium` |
| `enabled` | 严格布尔值 `true`/`false`，不接受字符串 `"true"`/`"1"`/`"yes"` |
| `robots_url` / `sitemap_url` | 可选，非空时必须是 `http(s)` URL 且不指向内网地址 |
| `expected_game_path` / `notes` / `site_category` | 自由文本，原样保存，前端渲染时一律用 `textContent`（不做服务端"净化"，见安全文档） |

未知字段一律拒绝（422），防止误传导致的"看起来保存成功、实际字段被忽略"。

## 5. 并发编辑保护（configVersion）

每次保存都必须带上 `expectedConfigVersion`——一个基于三份 CSV 当前内容算出的短哈希。服务端在真正写入前重新计算一次当前版本号，如果和调用方声明的不一致，返回 `409 CONFIG_VERSION_CONFLICT`，前端展示"配置已被其他操作修改，请刷新后重试"，**不做自动合并**。

前端的"新增/编辑站点"表单是两步流程：填写 → 预览 → 确认保存。版本号在**预览这一步**被拍下快照，"确认保存"复用这个快照，不会在提交那一刻重新拉取最新版本——这保证了"两个标签页同时基于各自看到的旧数据保存"时，后保存的一方一定会收到冲突提示，而不是悄悄覆盖对方的修改。这个行为已经用真实 Chromium 浏览器验证过（两个页面并发保存的场景）。

站点级限制表单和手工 Sitemap 表单是单步表单（没有单独的"预览"阶段），版本号在点击"保存"的那一刻获取，同样会在保存瞬间发生的并发冲突下正确返回 409。

## 6. 暂停 vs 删除

"暂停监控"（`POST /api/sites/:site_id/disable`）只是把 `enabled` 改成 `false`：

- SQLite 里的 `baseline_completed_at`、`seen_urls`、`added_urls`、历史运行记录**全部保留**。
- 随时可以"启用监控"（`POST /api/sites/:site_id/enable`）恢复，不需要重新建立 baseline。
- 前端在暂停前用 `confirm()` 弹窗提示"暂停不会删除任何历史数据"，用户确认后才提交。

**本阶段不实现永久删除**——删除涉及"这些历史数据到底要不要一起清掉"这类需要更谨慎设计的决策，留给未来单独的里程碑。

## 7. 站点级限制

`GET/PUT /api/sites/:site_id/limits` 对应 6 个可选字段，留空表示"使用系统默认值"：

| 字段 | 含义 | 硬上限 |
|---|---|---|
| `max_download_bytes` | 单文件下载大小上限 | 100 MB |
| `max_decompressed_bytes` | Gzip 解压后大小上限 | 250 MB |
| `max_page_urls` | 页面 URL 数量上限 | 1,500,000 |
| `max_sitemap_endpoints` | Sitemap Endpoint 数量上限 | 1,000 |
| `max_depth` | 递归深度上限 | 10 |
| `request_timeout_ms` | 单次请求超时 | 60,000 ms |

这些硬上限和 Milestone 5A-P1 的 CSV 解析路径（`src/site-overrides.js` 的 `LIMIT_HARD_CAPS`）完全共用同一份规则（`validateLimitFieldValue()`），不存在"CSV 手工改允许、界面不允许"的不一致。前端把字节数换算成可读单位（如"约 10.0 MB"）实时展示。

## 8. 手工 Sitemap

`GET/PUT /api/sites/:site_id/sitemaps` 管理 `mode`（`merge` / `manual_only`）+ 一组 Endpoint（`sitemap_url` + `enabled` + `notes`）：

- `merge`：手工声明的 Endpoint 和自动发现（robots.txt + 常见路径）的结果合并使用。
- `manual_only`：完全跳过自动发现，只用手工声明的 Endpoint——因此**必须至少有一个已启用的合法 Endpoint**，否则拒绝保存（422），防止把站点意外配置成"什么都发现不了"。
- 重复的 Endpoint URL 静默去重，不报错。
- 每个 URL 必须是合法 `http(s)` 地址且不指向内网（同样的 SSRF 校验）。

## 9. 只读诊断

站点详情页的"运行诊断"按钮触发 `POST /api/sites/:site_id/diagnose`：

- 立即返回 `202 { diagnosticId, status: 'running' }`，前端轮询 `GET /api/diagnostics/:diagnostic_id` 直到状态变为 `done`/`failed`。
- 诊断本身完全只读——`diagnoseSite()` 不 import 任何数据库写入模块，结构上保证不可能意外写库。
- 同一站点同时只允许一个诊断在跑；重复触发返回 `409 DIAGNOSIS_IN_PROGRESS`（前端和服务端两层都做了防抖）。
- 诊断结果只保存在服务进程内存里（重启面板会丢失），因为诊断本身是"重新点一次就能再跑"的操作，不需要持久化。

## 10. API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/sites` | 站点列表（CSV+SQLite 合并） |
| POST | `/api/sites` | 新增站点 |
| GET | `/api/sites/:id` | 单站详情 |
| PATCH | `/api/sites/:id` | 编辑站点（不含 site_id） |
| POST | `/api/sites/:id/enable` \| `/disable` | 启用/暂停 |
| GET/PUT | `/api/sites/:id/limits` | 站点级限制 |
| GET/PUT | `/api/sites/:id/sitemaps` | 手工 Sitemap |
| POST | `/api/sites/:id/diagnose` | 触发只读诊断（202 异步） |
| GET | `/api/diagnostics/:id` | 轮询诊断结果 |

所有响应统一信封：成功 `{ ok: true, data }`，失败 `{ ok: false, error: { code, message, fieldErrors? } }`。状态码映射：400 请求体非法 JSON、403 CSRF/Origin/Host 校验失败、404 资源不存在、409 版本冲突/诊断进行中、413 请求体过大、415 Content-Type 错误、422 字段校验失败、500 内部错误、503 并发写入被拒绝。
