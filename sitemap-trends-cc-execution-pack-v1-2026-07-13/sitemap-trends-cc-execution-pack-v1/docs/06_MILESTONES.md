# 06｜7 个 Milestone

## Milestone 0｜目标对齐

只确认：

- 总目标
- 优先级
- 技术边界
- 非目标
- 多 Agent 使用方式
- 缺失输入

禁止修改代码。

## Milestone 1｜只读审计与仓库基线

输出：

- 当前真实架构
- V1/V2 混杂清单
- 当前数据流
- 能力与缺口
- 数据风险
- 安全风险
- 修改建议
- 基线构建结果

禁止业务重构。

## Milestone 2｜数据库 V3

实现：

- sites
- sitemap_endpoints
- crawl_runs
- site_urls
- url_events
- game_aliases
- game_merge_reviews
- daily_game_metrics

交付：

- schema
- migration
- rollback
- verification

## Milestone 3｜Sitemap 主采集链路

实现：

- robots.txt 自动发现
- Sitemap Index 递归
- XML / XML.GZ
- 循环保护
- 最大深度和大小
- 同域名多个 Sitemap
- 有限并发
- 超时、重试和 429 退避

## Milestone 4｜URL 事件系统

实现：

- baseline
- added
- removed
- restored
- 幂等
- 失败隔离
- 异常数量保护
- 每日新增查询

此阶段完成后应能交付可靠的每日新增地址清单。

## Milestone 5｜游戏识别与实体聚合

实现：

- 站点 URL 规则配置化
- 游戏页面分类
- 标题与 slug 提取
- 别名
- 精确、高、中、低置信度
- 跨域名聚合
- 人工审核

## Milestone 6｜Dashboard 与导出

页面：

- /daily
- /trending
- /sites
- /reviews

支持：

- 日期和域名筛选
- 搜索
- 跨站过滤
- CSV
- JSON
- 复制 URL
- 站点健康

## Milestone 7｜100 站稳定化

- 5 个 shard
- 每 shard 约 20 站
- shard 内并发 4～5
- 3 站测试
- 10 站冒烟
- 20 站测试
- 100 站连续两个周期
- 运维文档
- 回滚演练
- 独立审查
