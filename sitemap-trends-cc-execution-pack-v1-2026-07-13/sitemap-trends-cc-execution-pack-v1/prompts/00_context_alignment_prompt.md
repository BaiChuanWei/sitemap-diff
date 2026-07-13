# 阶段 0：目标对齐 Prompt

你是这个项目的 Lead Agent。

当前阶段只建立共同上下文。禁止修改文件、运行迁移、部署或提交代码。

## 代码与产品参考

上游基础仓库：

`https://github.com/Yangjia23/sitemap-diff`

实际开发仓库：

`<填写 Fork 后的仓库 URL>`

产品逻辑参考：

`https://sitemaptrends.com/`

目标规模：

约 100 个在线小游戏网站。

## 总目标

基于现有 sitemap-diff 项目，建设独立的小游戏 Sitemap 趋势监控系统。

系统需要：

1. 从 robots.txt 或手工配置发现 Sitemap；
2. 支持 Sitemap Index 与子 Sitemap 递归；
3. 支持 XML 与 XML.GZ；
4. 第一次运行只建立基线；
5. 后续运行找出新增 URL；
6. 判断新增 URL 是否为游戏页面；
7. 提取候选游戏名；
8. 聚合同一游戏在不同独立域名上的来源；
9. 输出每日新增游戏 URL 清单；
10. 计算 24h、7d、30d 新增域名数；
11. 使用 Next.js Dashboard 查看和导出。

## 优先级

P0：数据安全与正确性  
P1：约 100 站稳定运行  
P2：每日新增 URL 清单  
P3：游戏页面识别  
P4：跨站聚合和趋势  
P5：Dashboard  
P6：备用采集

## 技术边界

必须保留：

- Node.js 20
- GitHub Actions
- Supabase PostgreSQL
- Next.js
- Vercel

禁止：

- 从零重写
- 更换语言或数据库
- Redis、Kafka、Kubernetes
- 自动建站
- 搜索量与 SERP
- 付费系统
- 未迁移直接修改生产数据库
- 打印或提交 Secret
- 把所有 `<loc>` 当页面 URL
- 模糊实体无审核自动合并

## 当前输出要求

只输出：

1. 对总目标的复述
2. 最重要的最终交付
3. 优先级
4. 技术栈边界
5. 非目标
6. 数据安全原则
7. 多 Agent 使用计划
8. 下一阶段审计范围
9. 缺失输入
10. 确认本阶段不会修改文件

不要开始审计代码，不要实施。
