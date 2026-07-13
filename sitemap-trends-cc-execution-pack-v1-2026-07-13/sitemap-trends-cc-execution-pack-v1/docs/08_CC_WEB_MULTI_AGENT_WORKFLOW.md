# 08｜CC Web 多 Agent 工作方式

## 总原则

一个 Lead Agent 负责总体顺序和最终合并。  
多个 Agent 只在任务独立时并行。  
强依赖任务按顺序完成。

## 阶段 0

只使用 Lead Agent，确认目标，不改代码。

## 阶段 1：并行只读审计

可创建三个只读 Agent：

### Repository Auditor

检查：

- 真实生产入口
- V1/V2 混杂
- 目录结构
- 构建与部署配置
- 旧文件引用

### Data & Security Auditor

检查：

- Supabase Schema
- RLS
- Service Key
- 数据污染
- 迁移风险
- 同域名 Sitemap 覆盖

### Crawler & Test Auditor

检查：

- robots
- Sitemap Index
- XML/GZ
- 并发
- baseline
- diff
- 失败行为
- 测试缺口

所有审计 Agent 禁止写文件。

## 实施阶段

数据库、事件模型和主采集链路存在强依赖，不建议多人同时改同一文件。

允许的并行：

- XML parser 与 fixtures
- Dashboard 不同独立页面
- 站点规则配置与审核 UI
- 最终安全、数据、测试独立复核

## 文件所有权

同一时间一个文件只归一个 Agent 修改。  
Lead Agent 负责最终 rebase、合并、测试和 commit。

## 不依赖 Agent Team

即使 CC Web 没有 Agent Team，也必须按相同审计维度顺序完成。  
多 Agent 是加速手段，不是验收前提。
