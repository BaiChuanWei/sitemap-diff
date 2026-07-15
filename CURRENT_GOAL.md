# 当前有效目标

本文件是本项目当前最高优先级的目标说明。

如本文件与 README、旧执行包、历史设计、Supabase 方案、Vercel 方案或其他文档发生冲突，以本文件为准。

## 一、实际使用场景

本项目只需要在 Windows 本地运行，由单个使用者使用。

当前不建设公开 SaaS，不需要多用户、登录、权限系统或公网 Dashboard。

## 二、总目标

基于现有 `sitemap-diff` 代码，建设一个可以在本地稳定监控约 100 个游戏网站或相关站点的新增游戏 URL 采集工具。

每次运行必须：

1. 读取本地站点清单；
2. 从 robots.txt 或手工配置发现 Sitemap；
3. 支持普通 Sitemap；
4. 支持 Sitemap Index 及多层子 Sitemap；
5. 支持 XML 和 XML.GZ；
6. 首次运行只建立基线；
7. 后续运行找出从未见过的新增 URL；
8. 初步判断新增 URL 是否为游戏页面；
9. 提取候选游戏名和置信度；
10. 把全部新增 URL 保存到本地 SQLite；
11. 输出 CSV、JSON 和 Markdown 报告；
12. 单个站点失败不能影响其他站点；
13. 失败不能清空或覆盖历史成功数据；
14. 支持约 100 个站点稳定运行；
15. 将本轮可靠结果与该站点上一次可靠 Sitemap 结果比较，判断每个已见 URL 是本轮缺失（missing）、连续两轮缺失（consecutive_missing）还是恢复（restored）——这三种状态均已实现（当前本地 v1 范围内），不代表页面被永久删除；
16. 为每次运行生成本地 AI 审查包：结构化 JSON（manifest.json / ai-review.json）+ 纯文本任务说明（ai-review.txt）+ 全部报告文件打包的 zip（ai-review-package.zip）。AI 审查包只整理本地已有数据，供用户自行上传给外部 AI 工具使用，本工具自身不调用任何 AI API。

## 三、第一版最重要的产物

每天或每次运行后，在该次运行自己的报告目录生成：

```text
output/YYYY-MM-DD/<run_id>/
├── manifest.json               AI 审查包元数据（运行信息 / 统计 / 文件清单 / 警告）
├── ai-review.json              AI 审查包结构化数据（合并新增/缺失/连续两轮缺失/恢复四类条目）
├── ai-review.txt               AI 审查包纯文本任务说明（可直接粘贴给 ChatGPT/Claude/Gemini）
├── report.md
├── new-urls.csv
├── new-urls.json
├── new-games.csv
├── unknown-urls.csv
├── missing-urls.csv            本轮缺失
├── consecutive-missing-urls.csv 连续两轮缺失
├── restored-urls.csv           恢复
├── changes.json
└── ai-review-package.zip       以上 12 个文件打包，AI 审查包正式落盘位置（不含数据库/配置/日志）
```

CSV 至少包含：

```text
detected_at
site_id
domain
sitemap_url
url
page_type
game_name
confidence
```

## 四、优先级

P0：数据正确性

* 首次运行不能把已有 URL 当新增；
* 抓取失败不能覆盖历史数据；
* 空 Sitemap 不能产生假变化；
* 部分子 Sitemap 失败不能清空数据；
* 重复运行不能重复记录同一新增 URL；
* 所有新增 URL 都必须保留，不能因为游戏名识别失败而丢弃。

P1：Sitemap 正确采集

* robots.txt 自动发现；
* Sitemap Index 递归；
* XML.GZ；
* 同一域名多个 Sitemap；
* 循环引用保护；
* 请求超时；
* 重试；
* 有限并发。

P2：新增 URL 输出

* SQLite 保存历史；
* CSV；
* JSON；
* Markdown 报告。

P3：游戏页面初筛

* 排除分类、标签、博客、搜索、隐私和静态资源；
* 提取 slug 和页面标题；
* 输出 high、medium、low 置信度。

P4：约 100 站稳定运行

验证顺序：

```text
fixture
→ 3 个真实站
→ 10 个真实站
→ 20 个真实站
→ 100 个真实站
```

## 五、当前技术栈

保留：

* Node.js 20；
* JavaScript 或 TypeScript；
* 本地文件；
* SQLite；
* Windows 任务计划程序。

允许增加：

* SQLite 依赖；
* XML 流式解析依赖；
* 并发限制依赖；
* 测试框架。

## 六、当前明确不做

第一版不做：

* Supabase；
* Vercel；
* GitHub Actions 定时采集；
* Redis；
* Kafka；
* Kubernetes；
* 多用户；
* 登录；
* RLS；
* 公网 Dashboard；
* 付费系统；
* 自动建站；
* 搜索量分析；
* SERP 分析；
* 复杂趋势评分；
* 复杂游戏实体人工合并系统；
* changedetection.io 全面接入；
* OpenAI / Claude / Gemini 等 AI API 集成（AI 审查包只在本地整理、打包已有数据，供用户自行上传给外部 AI 工具，本工具自身不调用任何 AI API、不需要任何 API Key）。

这些能力只能作为未来第二阶段规划，不能阻塞本地生产工具。

## 七、关键行为

首次运行

```text
保存全部当前 URL
新增 URL 数量 = 0
```

后续运行

```text
当前 URL - SQLite 已见 URL = 本轮新增 URL
```

抓取失败

```text
记录错误
不修改已有 URL 历史
不产生假新增
继续处理其他站点
```

无法识别游戏名

```text
仍然保存新增 URL
page_type = unknown
confidence = low
```

重复执行

```text
不重复产生相同新增记录
```

## 八、生产完成标准

只有同时满足以下条件，才算第一版完成：

* 约 100 个站可配置；
* Sitemap Index 可递归；
* XML.GZ 可处理；
* 首次运行新增为 0；
* 后续可准确发现新增 URL；
* 单站失败不影响其他站；
* 请求有超时和重试；
* SQLite 重启后数据保留；
* 每次运行输出 CSV、JSON 和 Markdown；
* 全部新增 URL 可追溯；
* 连续两个完整运行周期没有数据污染。
