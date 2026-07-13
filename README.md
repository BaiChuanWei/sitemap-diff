# Sitemap Trends — 本地小游戏 Sitemap 监控工具

监控约 100 个游戏网站的 sitemap，发现新增的游戏页面 URL，在本地生成可查看、可导出的报告。

> 当前目标以 [`CURRENT_GOAL.md`](./CURRENT_GOAL.md) 为准，开发规则见 [`CLAUDE.md`](./CLAUDE.md)。这两份文件与本 README 冲突时，以它们为准。
>
> 本项目基于 [Yangjia23/sitemap-diff](https://github.com/Yangjia23/sitemap-diff)（MIT License）二次开发，见 [LICENSE](./LICENSE)。

## 当前性质

**Windows 本地运行的单用户生产工具**，不是云端 SaaS：不用 Supabase、不用 Vercel、不用 GitHub Actions 定时采集、没有公网 Dashboard。数据存本地 SQLite，结果以 CSV/JSON/Markdown 报告形式输出到 `output/YYYY-MM-DD/`。

历史上项目经历过两次云端方向的实现（Cloudflare Workers + Discord/Telegram Bot，以及 GitHub Actions + Supabase + Vercel/Next.js），均已归档到 `legacy/`，不在当前实现范围内，但保留供未来参考。

## 当前状态：Milestone 3（SQLite Baseline 与新增 URL）

按 `CLAUDE.md` 定义的 5 个 Milestone，当前完成到 Milestone 3：在 Milestone 2 采集器之上，把完整成功的采集结果落进本地 SQLite，并判断哪些页面 URL 是该站第一次出现。

- **首次完整成功运行**只建立 baseline（保存全部当前 URL，新增 = 0），不会把第一次看到的 URL 当成新增；
- **后续完整成功运行**用"本轮 URL − 该站已见 URL"算出新增 URL；
- **partial / failed / 被截断 / 空结果**一律拒绝写入正式 URL 历史，只记录运行诊断，保留之前的全部历史；
- 幂等：相同数据重复运行不会重复产生新增或重复行；
- 单站的一次完整成功在**单一 SQLite 事务**内写入，任一步失败整体回滚；
- **运行锁**（`data/collector.lock`）防止 Windows 任务计划程序重叠执行；
- 单站失败不影响其他站点。

采集器本身（`src/sitemap/`）仍然只做"这一轮能拿到哪些页面 URL"，**不写库**；`--inspect-site` / `--inspect-url` 也**不写正式 URL 历史**，只打印检查结果并写调试 JSON 到 `output/debug/`。写库只发生在 `--collect`。

### 采集结果完整性与写入准入契约

每次单站采集结果都带有完整性字段：

- `status`：`success` | `partial` | `failed`
- `complete`：仅当 `status === "success"`（有成功、无失败、无截断）时为 `true`
- `truncated`：数据是否被主动截断（达到递归深度 / Endpoint 数 / 页面 URL 数上限）
- `truncationReasons`：截断原因，如 `MAX_PAGE_URLS` / `MAX_SITEMAPS_ENDPOINTS` / `MAX_DEPTH`

任何截断都会把 `success` 降级为 `partial`，杜绝"被截断却标记为完整"的假完整结果（例如 itch.io 触发 50 万页面 URL 上限时会返回 `partial` + `complete=false` + `truncated=true`，而不是 `success`）。

**写入准入契约**：只有 `status === "success"` 且 `complete === true`（此时 `truncated` 必为 `false`）且页面 URL 数 > 0 的采集结果，才允许用于建立或更新正式 baseline / seen URL 历史 / 计算新增 URL。`partial`、`failed`、`complete=false`、`truncated=true` 或页面 URL 数为 0 的结果一律拒绝写入正式 URL 历史，只记录运行错误和诊断信息。该契约在 `src/sitemap/collector.js` 的函数注释里声明，由 `src/storage/index.js` 的 `isAdmissible()` 强制执行。

## 目录结构

```
CURRENT_GOAL.md         # 当前目标，最高优先级
CLAUDE.md                # 开发规则与 5 个 Milestone
bin/run.js               # 本地入口：--collect / --db-status / --inspect-site / --inspect-url
src/
  config.js              # 本地配置加载 + 站点清单 CSV 解析
  collect-runner.js       # 采集运行编排：遍历站点 → 采集 → 准入判定 → 写库 → 汇总
  lock.js                  # 运行锁（data/collector.lock），防任务计划程序重叠执行
  db/
    index.js             # SQLite 连接 + 迁移执行器
    migrations/           # 编号 up/down 迁移（0001 基线站点表，0002 URL 历史）
  sitemap/
    fetcher.js            # HTTP 请求：超时、重试、429/5xx 退避、重定向上限、大小上限、Gzip 检测解压
    parser.js              # 正式 XML 解析（fast-xml-parser）：urlset/sitemapindex、命名空间、CDATA、实体
    discovery.js            # robots.txt 发现 + 手工 sitemap_url + 常见路径探测
    recursive-loader.js      # Sitemap Index 递归：visited set、深度/数量上限、有限并发
    collector.js             # 站点级编排：discovery + recursive-loader → 结构化结果
    limits.js                # 集中的默认限制（超时/重试/并发/递归深度/数量上限）
    errors.js                 # 统一错误类型和错误码
  storage/
    normalize.js            # 保守 URL 标准化 + sha256 哈希
    index.js                 # baseline/新增判定、事务写入、拒绝写入、db-status 查询
config/
  sites.example.csv       # 站点清单模板（真实约 100 站清单待补）
test/
  *.test.js               # node:test 单元测试（含运行锁、编排、inspect 不写库）
  sitemap/                # Sitemap 采集器测试（解析器/抓取器/发现/递归/端到端）
  storage/                 # URL 标准化 + baseline/新增/幂等/事务回滚/拒绝写入测试
  helpers/                 # 测试用本地 HTTP Server
  fixtures/                # Sitemap 测试样本（含真实 gzip 文件）
docs/
  audit/                  # 只读审计报告存档
  archive/                 # 已暂停的云端方案文档，仅供参考
legacy/
  v1-cloudflare-workers/   # 已废弃：Cloudflare Workers + Discord/Telegram
  v2-cloud-supabase/       # 已暂停：GitHub Actions + Supabase + Vercel
```

## 开发命令

```bash
npm install
npm test                                     # node --test，跑 test/ 下全部单元测试
npm start                                     # 运行本地入口（bin/run.js），只做配置/SQLite 基线同步
node bin/run.js --collect                     # 采集全部启用站点，写入正式 URL 历史（带运行锁）
node bin/run.js --collect --site poki         # 只采集指定站点
node bin/run.js --db-status                   # 查看数据库状态（站点数/baseline/seen/added/最近运行）
node bin/run.js --inspect-site poki           # 只做 Sitemap 采集检查，不写正式 URL 历史
node bin/run.js --inspect-url https://example.com/sitemap.xml
```

## 本地配置

- 站点清单：`config/sites.example.csv`（字段：`site_id,domain,priority,enabled,robots_url,sitemap_url,expected_game_path,notes`），目前只有模板示例行，正式使用前需要替换成约 100 个真实站点
- SQLite 数据库：默认 `data/local.db`（首次运行自动创建，已在 `.gitignore` 中排除，不提交到仓库）
- 运行锁：默认 `data/collector.lock`（`--collect` 运行期间存在，正常/异常结束都会清理，已随 `data/` 一起被 `.gitignore` 排除）
- 报告输出：默认 `output/`（Milestone 4 才会开始写入正式日报，已在 `.gitignore` 中排除）；`--inspect-site`/`--inspect-url` 的调试结果会写到 `output/debug/`，与正式日报目录分开

## 后续 Milestone

见 [`CLAUDE.md`](./CLAUDE.md)：Milestone 2（Sitemap 采集器）→ Milestone 3（基线和新增 URL）→ Milestone 4（游戏初筛和报告）→ Milestone 5（100 站生产验证）。每个 Milestone 独立提交、独立测试，完成后停止等待确认，不自动进入下一阶段。
