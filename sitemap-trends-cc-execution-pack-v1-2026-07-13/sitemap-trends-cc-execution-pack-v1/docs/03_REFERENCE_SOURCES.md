# 03｜参考来源

## 上游基础仓库

`https://github.com/Yangjia23/sitemap-diff`

用途：

- 作为代码改造基础
- 保留已有 `.gz`、首次基线、异常保护、游戏提取、Supabase、Dashboard 和 GitHub Actions 能力
- 遵守仓库实际许可证和署名要求
- 不应在没有审计的情况下盲目复制旧版与新版混杂代码

## 产品参考

`https://sitemaptrends.com/`

用途：

- 产品逻辑参考
- 趋势指标参考
- Dashboard 信息架构参考
- 每日新增清单与来源时间线参考

它不是后台源码来源，不要求像素级复制。

## 备用采集参考

`https://github.com/dgtlmoon/changedetection.io`

用途：

- 没有公开 Sitemap 的高价值站点
- 监控 New Games、Latest、分类页中的新增链接
- 仅作为 fallback，不进入第一阶段主链路

## 目标站点清单

文件：`data/seed-sites.csv`

至少包含：

- `site_id`
- `domain`
- `priority`
- `enabled`
- `robots_url`
- `sitemap_url`
- `expected_game_path`
- `notes`

## 还应由项目所有者补充

- Sitemap Trends 登录后页面截图
- 期望字段清单
- 一份示例日报
- 一份示例 CSV
- 排行榜指标定义
- 约 100 个目标站点真实清单
