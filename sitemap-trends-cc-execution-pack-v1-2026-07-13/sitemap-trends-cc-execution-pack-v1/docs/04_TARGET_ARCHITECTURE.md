# 04｜目标架构

## 100 站版本

```text
GitHub Actions
  ├─ 5 个 shard
  └─ 每个 shard 约 20 个站
          ↓
Node.js Sitemap Collector
  ├─ robots discovery
  ├─ sitemap index recursion
  ├─ xml / xml.gz parser
  ├─ timeout / retry / backoff
  └─ bounded concurrency
          ↓
Supabase PostgreSQL
  ├─ sites
  ├─ sitemap_endpoints
  ├─ crawl_runs
  ├─ site_urls
  ├─ url_events
  ├─ games
  ├─ game_aliases
  ├─ game_sources
  ├─ game_merge_reviews
  └─ daily_game_metrics
          ↓
Next.js Dashboard on Vercel
  ├─ /daily
  ├─ /trending
  ├─ /sites
  └─ /reviews
```

## GitHub Actions 建议

- 5 个 shard
- 每个 shard 约 20 个站
- shard 内并发 4～5
- 单请求超时 15～20 秒
- 最多重试 2 次
- 对 429 指数退避
- 单站失败不终止整个 shard
- 支持手动运行指定 shard
- 输出成功、部分成功、失败统计

## 不需要的架构

100 站阶段暂不需要：

- Redis
- BullMQ
- Kafka
- Kubernetes
- 多节点 Worker
- 常驻 VPS 集群
- 复杂分布式锁

## 备用采集

只有持续无法使用 Sitemap 的高价值站点才配置：

```text
RSS/API
→ 列表页
→ changedetection.io
→ 人工维护
```
