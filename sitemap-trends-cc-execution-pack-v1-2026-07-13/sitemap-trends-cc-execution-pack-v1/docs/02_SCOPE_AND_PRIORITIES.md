# 02｜范围、优先级与非目标

## 优先级

### P0｜数据正确性与安全

任何失败都不能污染成功状态。  
首次运行不能报新增。  
重复任务必须幂等。  
Secret 不能进入日志、前端或 Git。

### P1｜约 100 个站稳定采集

必须支持：

- robots.txt 自动发现
- Sitemap Index 递归
- XML / XML.GZ
- 同域名多个 Sitemap
- 有限并发
- 超时、重试、429 退避
- 单站失败隔离

### P2｜每日新增 URL 清单

这是第一版最重要的用户结果：

- 日期筛选
- 域名筛选
- 游戏名搜索
- 跨站过滤
- CSV
- JSON
- 复制全部 URL

### P3｜游戏页面识别

- 排除分类页、标签页、博客、搜索页、静态资源
- 提取候选游戏名
- 输出置信度
- 低置信度进入审核

### P4｜跨站聚合与趋势

- 同一游戏跨域名聚合
- 24h 新增域名数
- 7d 新增域名数
- 30d 新增域名数
- 总域名数
- 首次与最近发现时间

### P5｜Dashboard

- `/daily`
- `/trending`
- `/sites`
- `/reviews`

### P6｜备用采集

- RSS
- JSON API
- 列表页
- changedetection.io

备用采集不得阻塞 Sitemap 主链路。

## 冲突处理规则

1. 数据准确性高于页面美观。
2. 每日新增清单高于趋势榜。
3. 主链路高于备用采集。
4. 可验证的简单规则高于复杂黑箱算法。
5. 100 站实际稳定高于为 1000 站过度设计。

## 技术栈冻结

保留：

- Node.js 20
- GitHub Actions
- Supabase PostgreSQL
- Next.js
- Vercel

允许：

- 增加 XML 流式解析依赖
- 增加测试框架
- 修改 Supabase Schema
- 增加迁移与回滚
- 调整 GitHub Actions 分片

禁止：

- 从零重写
- 改用 Python
- 更换数据库
- 引入 Redis、Kafka、Kubernetes
- 微服务化
- 自动建站
- 搜索量和 SERP 模块
- 付费系统
