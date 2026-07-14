# Sitemap 监控本地控制面板 —— 安全实现说明（M2）

状态：已实现。本文档记录 M2 站点管理写接口的具体安全实现、已发现并修复的问题、以及有意不解决的残余风险。总体威胁模型见 `dashboard-threat-model.md` 第 5-6 节，本文档是它的实现细节补充。

## 1. 写接口的四层防护

每一个写请求（`POST`/`PATCH`/`PUT`/`DELETE` 且路径以 `/api/` 开头）依次经过：

1. **Host 校验**（`isExpectedHost`）：请求头 `Host` 必须精确等于 `127.0.0.1:<port>`，防 DNS rebinding——即使攻击页面把域名解析改成 127.0.0.1，浏览器发出的 `Host` 头仍是原域名，会被这里拒绝。这一层对**所有**请求生效（包括 GET），不只是写接口。
2. **Origin 校验**（`isSameOriginRequest`）：写请求的 `Origin`（或退化到 `Referer`）必须是 `http://127.0.0.1:<port>` 自身。
3. **CSRF token 校验**（`isValidToken`）：写请求必须带 `X-Dashboard-Token` header，值等于服务本次启动时生成的一次性 token（`crypto.randomBytes(24)`，只通过 `GET /api/health` 的响应体下发，不放在 cookie 里，因为本工具没有认证会话，用 token 是为了让"只有加载了本页面 JS 的浏览器标签页才知道这个值"）。
4. **字段级校验**（`src/dashboard/validation.js`）：site_id 格式、域名/URL 的 SSRF 检查、字段白名单、限制值硬上限等。

任一环节失败都返回结构化错误（403/422），不会执行到实际写入逻辑。

## 2. SSRF 防护实现与残余风险

`isPrivateOrLoopbackHost()` 在保存 `domain`/`robots_url`/`sitemap_url`/手工 Sitemap URL 时做静态检查，拒绝：

- `localhost`、`*.local`、`*.localhost`
- IPv4：`0.0.0.0/8`、`10.0.0.0/8`、`100.64.0.0/10`（CGNAT）、`127.0.0.0/8`、`169.254.0.0/16`（含云元数据 `169.254.169.254`）、`172.16.0.0/12`、`192.168.0.0/16`
- IPv6：`::1`、`::`、`fc00::/7`（唯一本地地址）、`fe80::/10`（链路本地）、以及 IPv4-mapped `::ffff:x.x.x.x`（解包后按 IPv4 规则再判一次）

**这不是完整的 SSRF 防护**，完整的残余风险清单（DNS rebinding、HTTP 重定向到内网、未改动的网络层）记录在 `dashboard-threat-model.md` 第 5 节"SSRF 残余风险"，此处不重复。核心结论：这是**保存配置时**的输入校验，不是**发起网络请求时**的运行时校验，真正堵住 SSRF 需要改造 `src/sitemap/fetcher.js` 的连接层，超出本里程碑范围，作为已知记录的风险，不是被忽略的风险。

## 3. 配置写入：原子性与备份

`src/dashboard/config-store.js` 的 `writeConfig()` 是所有配置写操作的唯一入口，流程：

```
读取当前三份 CSV + 计算 configVersion
  → 比对调用方声明的 expectedConfigVersion，不一致则 409 并中止
  → mutate() 生成新内容（纯函数，不直接碰文件系统）
  → 备份修改前的三份文件到 config/backups/<timestamp>-<uuid>/（含 manifest.json）
  → 对每份文件：写临时文件 → fsync → rename 替换正式文件
  → 任一环节失败：把三份文件整体恢复成写入前内容，向上抛错
  → 写入后重新读取三份文件，确认往返解析语义一致（行数比对）
  → 有 db 参数时调用 syncSites() 把 sites.csv 同步进 SQLite；失败则整体回滚配置文件
```

**不允许**任何接口绕过这个入口直接调用 `fs.writeFileSync` 改配置文件——`sites-write.js` 里的每一个写函数都是通过 `writeConfig()` 的 `mutate` 回调完成修改的。

进程内用一个模块级 `let writing = false` 做互斥：同一时刻只允许一个写操作在执行，第二个请求立刻收到 `503 CONFIG_LOCKED`（不是排队等待——本地单用户工具没有必要为写请求做队列，明确报错让用户重试即可）。

## 4. 已发现并修复的问题（本阶段开发中）

以下问题都是在编写针对真实 HTTP 服务器的端到端测试、以及用真实 Chromium 浏览器走一遍完整流程时发现的，不是纯靠代码走查发现的：

| 问题 | 现象 | 根因 | 修复 |
|---|---|---|---|
| 请求体过大时客户端只看到连接错误而不是 413 | `readBodyWithLimit()` 在超限时调用 `req.destroy()` | Node 里 `req`/`res` 共用底层 socket，`destroy()` 提前把连接拆了，服务端来不及把 413 响应写回去 | 去掉 `req.destroy()`，加 `settled` 标志防止重复 resolve/reject，改为在响应里显式加 `Connection: close` |
| PATCH 站点时尝试改 `site_id` 被静默忽略而不是拒绝 | 测试期望 422，实际返回 200 | `updateSite()` 在校验前就 `delete merged.site_id`，抹掉了"用户尝试改它"的证据 | 去掉这行 delete，让校验函数能看到并拒绝该尝试 |
| 面板启动后 `GET /api/sites` 返回空，即使 `sites.csv` 里已有内容 | 手工浏览器验证发现，需要先做一次任意写操作站点才会出现 | 服务启动时从未调用过 `syncSites()`——CLI 的 `runBaseline()` 每次运行都会同步，面板启动路径漏了这一步 | `createDashboardServer()` 里 `openDb()` 之后立即读取 `sites.csv` 并 `syncSites()`，和 CLI 行为对齐 |
| 站点新增/编辑表单的"预览"和"确认保存"之间，并发保护形同虚设 | 用真实浏览器模拟两个标签页同时编辑同一站点，第二个标签页保存时没有触发预期的 409 冲突提示，而是悄悄用最新版本覆盖 | 前端在"预览"步骤把 `configVersion` 存进 `state.formConfigVersion`，但"确认保存"点击时又重新调用 `currentSitesConfigVersion()` 拉取最新版本——等于永远拿到"当前"版本，永远不会和自己冲突 | 确认保存改为直接使用 `state.formConfigVersion`（预览时的快照），不再重新拉取；用真实浏览器重跑两标签页并发保存场景，确认第二个标签页正确收到并展示"配置已被其他操作修改，请刷新后重试" |

## 5. 审计日志

`config/../logs/config-audit.jsonl`（追加写，每行一个 JSON 对象），记录每一次写操作（成功和失败都记）：

```
{ "at": "...", "action": "create_site" | "update_site" | "update_site_limits" | "update_site_sitemaps",
  "site_id": "...", "changed_fields": [...], "result": "success" | "failed",
  "errorCode": "...", "configVersionBefore": "...", "configVersionAfter": "..." }
```

**明确不记录**：CSRF token、完整请求头、请求体原文、完整配置文件内容——字段是显式白名单，不是"排除敏感字段"的黑名单（黑名单容易漏）。

## 6. 前端安全约定

- 所有来自服务端的数据一律用 `textContent`/DOM API 赋值，禁止 `innerHTML` 拼接（自动测试对 `app.js` 做静态检查，确保这条约定不会被后续修改破坏）。
- 写操作的提交按钮在请求进行中禁用（`btn.disabled = true`），防止连点触发重复提交；服务端的写互斥锁是最终防线，前端禁用是第一层减少无意义请求。
- 从不在服务端确认成功前展示"已保存"的乐观提示——所有成功提示都在 `apiMutate()` 的 `await` 完成之后才渲染。
- 409/422/500 各自有明确的中文错误提示路径，不会被吞掉或和其它错误混淆。

## 7. 对抗性场景验证情况

以下场景已通过自动化测试（`test/dashboard/*.test.js`）或真实浏览器手工验证（Playwright + Chromium，脚本未提交仓库，仅用于本轮验证）确认：

| 场景 | 验证方式 | 结果 |
|---|---|---|
| site_id 含 `../` 或路径分隔符 | 自动测试 | 拒绝（422） |
| domain 为 localhost / 内网 IP | 自动测试 | 拒绝（422） |
| Sitemap URL 指向 127.0.0.1 / 内网 | 自动测试 | 拒绝（422） |
| 两个标签页同时保存（同一站点） | 真实浏览器 | 后保存者收到 409，前端展示冲突提示，未静默覆盖 |
| 用户手工编辑 CSV 后面板仍用旧版本提交 | 自动测试（直接改写 CSV 文件模拟手工编辑） | 拒绝（409），手工编辑内容未被覆盖 |
| 备份目录不可写 | 自动测试（用文件占位目录路径模拟） | 写入整体失败，不留半份配置 |
| 写入中途失败（磁盘/文件系统错误） | 自动测试（注入失败的 `fsImpl`） | 整体回滚到写入前内容 |
| SQLite 同步失败 | 自动测试（注入失败的 db 句柄） | 配置文件回滚，不会出现"CSV 已更新但 SQLite 未同步"的中间态 |
| 请求体过大（2MB） | 自动测试 | 413，服务进程不崩溃，后续请求正常 |
| 非法 JSON / 错误 Content-Type | 自动测试 | 400 / 415 |
| 极长 notes 字段（约 40KB） | 自动测试 | 正常保存，CSV 往返不截断 |
| 1000 条手工 Sitemap Endpoint | 自动测试 | 正常保存并原样往返，无崩溃无截断 |
| 服务重启后旧 CSRF token 复用 | 自动测试（起第二个服务实例模拟"重启前的旧 token"） | 拒绝（403 INVALID_CSRF_TOKEN） |
| 客户端在响应返回前中止请求 | 自动测试（`AbortController`） | 服务进程不崩溃，后续请求正常处理 |
| notes 含 `<script>` | 自动测试 | 原样存储（服务端不做"净化"假设，安全边界在前端渲染层） |
| 10 次连续点击保存 | 代码走查（前端 `disabled` 标志）+ 后端并发锁自动测试 | 前端第 2 次起的点击被 `if (btn.disabled) return` 直接忽略；即使前端逻辑被绕过，服务端并发写入锁也会让第二个真正到达的请求收到 503 |
| 进程在两次 `rename` 之间被杀死 | 未自动化（无法在测试里可靠模拟"进程突然消失"），设计层面用备份目录兜底 | 记录为残余风险，见 `dashboard-threat-model.md` 第 5 节 |
| Windows 下配置文件被其它程序独占打开 | 未在 Linux 环境复现（Windows 专属文件锁语义），设计层面已有 try/catch + 回滚兜底 | 记录为残余风险，见 `dashboard-threat-model.md` 第 6 节 |
| 诊断请求长时间无响应 | 依赖底层 `request_timeout_ms` 硬上限（≤60 秒），继承自 Milestone 5A 的抓取层测试 | 不会无限期挂起，`inFlightBySite` 会在诊断结束（成功/失败/超时）后正确清除 |

