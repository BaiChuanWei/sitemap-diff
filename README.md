# Sitemap Trends — 本地小游戏 Sitemap 监控工具

监控约 100 个游戏网站的 sitemap，发现新增的游戏页面 URL，在本地生成可查看、可导出的报告。

> 当前目标以 [`CURRENT_GOAL.md`](./CURRENT_GOAL.md) 为准，开发规则见 [`CLAUDE.md`](./CLAUDE.md)。这两份文件与本 README 冲突时，以它们为准。
>
> 本项目基于 [Yangjia23/sitemap-diff](https://github.com/Yangjia23/sitemap-diff)（MIT License）二次开发，见 [LICENSE](./LICENSE)。

## 当前性质

**Windows 本地运行的单用户生产工具**，不是云端 SaaS：不用 Supabase、不用 Vercel、不用 GitHub Actions 定时采集、没有公网 Dashboard。数据存本地 SQLite，结果以 CSV/JSON/Markdown 报告形式输出到 `output/YYYY-MM-DD/`。

历史上项目经历过两次云端方向的实现（Cloudflare Workers + Discord/Telegram Bot，以及 GitHub Actions + Supabase + Vercel/Next.js），均已归档到 `legacy/`，不在当前实现范围内，但保留供未来参考。

## 当前状态：Milestone 1（本地项目基线）

按 `CLAUDE.md` 定义的 5 个 Milestone，当前完成到 Milestone 1：确认本地入口、建立 SQLite 存储框架、建立本地配置（站点清单）、建立测试框架和 fixture 基线、归档遗留云端代码。

**Milestone 2（Sitemap 采集器：robots 发现、Sitemap Index 递归、XML/GZ、超时重试、有限并发）尚未实现**，`bin/run.js` 目前只做"加载配置 → 初始化 SQLite → 同步站点清单"，不抓取任何站点。

## 目录结构

```
CURRENT_GOAL.md         # 当前目标，最高优先级
CLAUDE.md                # 开发规则与 5 个 Milestone
bin/run.js               # 本地入口（Milestone 1 骨架）
src/
  config.js              # 本地配置加载 + 站点清单 CSV 解析
  db/
    index.js             # SQLite 连接 + 迁移执行器
    migrations/           # 编号 up/down 迁移
config/
  sites.example.csv       # 站点清单模板（真实约 100 站清单待补）
test/
  *.test.js               # node:test 单元测试
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
npm test        # node --test，跑 test/ 下全部单元测试
npm start        # 运行本地入口（bin/run.js）
```

## 本地配置

- 站点清单：`config/sites.example.csv`（字段：`site_id,domain,priority,enabled,robots_url,sitemap_url,expected_game_path,notes`），目前只有模板示例行，正式使用前需要替换成约 100 个真实站点
- SQLite 数据库：默认 `data/local.db`（首次运行自动创建，已在 `.gitignore` 中排除，不提交到仓库）
- 报告输出：默认 `output/`（Milestone 4 才会开始写入，已在 `.gitignore` 中排除）

## 后续 Milestone

见 [`CLAUDE.md`](./CLAUDE.md)：Milestone 2（Sitemap 采集器）→ Milestone 3（基线和新增 URL）→ Milestone 4（游戏初筛和报告）→ Milestone 5（100 站生产验证）。每个 Milestone 独立提交、独立测试，完成后停止等待确认，不自动进入下一阶段。
