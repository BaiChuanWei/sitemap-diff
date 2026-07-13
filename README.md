# Sitemap Diff — 游戏 Sitemap 监控

监控多个网站的 sitemap，检测新增游戏页面，追踪同一款游戏在不同独立域名上的分布。提供 Web Dashboard 进行浏览和管理。

> 本项目基于 [Yangjia23/sitemap-diff](https://github.com/Yangjia23/sitemap-diff)（MIT License）二次开发，见 [LICENSE](./LICENSE)。

## 架构（V2，当前生产实际使用的架构）

```
┌─────────────────────┐     ┌─────────────────┐
│  GitHub Actions      │────▶│  Supabase        │
│  每 4 小时定时检查    │     │  Postgres 数据存储│
└─────────────────────┘     └────────┬─────────┘
                                      │
┌─────────────────────┐              │
│  Web Dashboard        │◀────────────┘
│  (Vercel + Next.js)   │
│  - 游戏浏览            │
│  - Sitemap 管理        │
│  - 统计面板            │
└─────────────────────┘
```

- **抓取**：GitHub Actions（`.github/workflows/check-sitemaps.yml`）定时触发 `lib/check-sitemaps.js`，对比每个域名 sitemap 的前后版本，只处理新增 URL，识别其中的游戏页面并写入 Supabase。
- **存储**：Supabase Postgres，表结构见 `supabase/migrations/`（历史散装脚本归档于 `supabase/legacy/`，不再使用）。
- **展示**：`web/` 是 Next.js Dashboard，部署在 Vercel，浏览器端只读访问 Supabase（`NEXT_PUBLIC_SUPABASE_ANON_KEY`），写操作（增/删 sitemap）经服务端 API route 用 service role key 执行，详见下方「安全模型」。

> ⚠️ 仓库里另有一套已废弃的 V1 实现（Cloudflare Workers + Discord/Telegram Bot 通知），已整体移到 [`legacy/v1-cloudflare-workers/`](./legacy/v1-cloudflare-workers/)，当前生产链路不使用，仅作历史存档。

## 目录结构

```
sitemap-diff/
├── lib/                          # 爬虫核心库
│   ├── supabase.js               # Supabase 服务端客户端（service role key）
│   ├── rss-manager.js            # sitemap 下载/对比/游戏名提取
│   ├── check-sitemaps.js         # GitHub Actions 定时入口
│   └── load-env.js               # 本地开发环境变量加载
├── web/                           # Web Dashboard (Next.js)
│   ├── src/
│   │   ├── components/           # React 组件
│   │   ├── pages/                # 页面 + pages/api（服务端写入入口）
│   │   ├── lib/                  # supabase.ts（只读，anon）/ supabase-admin.ts（写入，service role，仅服务端）
│   │   └── styles/
│   └── package.json
├── supabase/
│   ├── migrations/                # 编号 up/down 迁移，当前 schema 的唯一权威来源
│   └── legacy/                    # 历史散装 SQL 脚本，已归档不再使用
├── legacy/v1-cloudflare-workers/  # 已废弃的 V1 实现，仅存档
├── .github/workflows/
│   └── check-sitemaps.yml
├── vercel.json
└── package.json                   # 爬虫依赖（Node 20 + @supabase/supabase-js）
```

## 安全模型

- 五张业务表（`feeds/sitemaps/games/game_sources/update_logs`）开启 RLS：**anon 角色只读**，写操作仅限 **service_role**（见 `supabase/migrations/0001_tighten_rls_to_service_role.up.sql`）。
- 浏览器端 Dashboard 只使用公开的 `NEXT_PUBLIC_SUPABASE_ANON_KEY` 读数据；「增/删 sitemap」这类写操作经由 `web/src/pages/api/feeds.ts` 服务端 API route，用只在服务端可见的 `SUPABASE_SERVICE_KEY` 执行，浏览器端拿不到这个密钥。
- GitHub Actions 用 `SUPABASE_SERVICE_KEY`（存于仓库 Secrets）执行爬虫写入。

## 环境变量

### GitHub Actions Secrets（爬虫）
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`

### Vercel 环境变量（Web Dashboard）
- `NEXT_PUBLIC_SUPABASE_URL` — 公开
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — 公开，仅只读权限
- `SUPABASE_SERVICE_KEY` — **服务端专用，不要加 `NEXT_PUBLIC_` 前缀**，只配置在 Vercel 的服务端环境变量里

## 部署步骤

### 1. Supabase
1. 新建 Supabase 项目
2. 在 SQL Editor 依次执行 `supabase/migrations/` 下的迁移（细节和顺序见该目录的 `README.md`；对已有生产项目**不要**执行 `0000_baseline_v2_schema`，只需执行后续增量迁移）

### 2. Web Dashboard（Vercel）
```bash
cd web
npm install
npm run build
```
在 Vercel 项目设置中配置上述环境变量，然后部署。

### 3. GitHub Actions
在仓库 Settings → Secrets 添加 `SUPABASE_URL`、`SUPABASE_SERVICE_KEY`，`.github/workflows/check-sitemaps.yml` 会按 cron（每 4 小时）自动运行，也可以手动 `workflow_dispatch` 触发。

## 开发命令

```bash
# 爬虫：本地运行一次 sitemap 检查
npm run check

# Web Dashboard
cd web
npm install
npm run dev      # http://localhost:3000
npm run build
npm start
```

## 已知限制（详见项目审计记录）

当前 V2 实现是"域名级整份 sitemap 对比"，尚不支持：robots.txt 自动发现、sitemap index/子 sitemap 递归解析、每日新增 URL 的完整清单与导出、24h/7d/30d 趋势统计、带置信度的游戏识别、跨域名合并前的人工审核。这些能力正在按里程碑逐步补齐，进度和设计取舍见项目 issue / PR 描述。
