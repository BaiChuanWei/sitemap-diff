# Milestone 3：Sitemap 主采集链路

## 目标

实现可测试、可限制、可递归的 Sitemap 发现和解析。

## 必须实现

- robots.txt 自动发现
- 手工 Endpoint
- 区分 urlset 与 sitemapindex
- Sitemap Index 递归
- XML / XML.GZ
- 最大递归深度
- 循环引用保护
- 单站最大 Endpoint 数
- 最大下载和解压大小
- 重定向
- 超时
- 最多两次重试
- 429 指数退避
- 同域名多个 Sitemap
- 有限并发

## 禁止

- 使用单一正则作为主 XML 解析器
- 把 Sitemap URL 当游戏页面
- 直接连接 100 站验证
- 改 Dashboard

## 验证

先用 fixtures：

- urlset
- nested index
- gz
- empty
- truncated
- circular
- duplicate

再做 3 个测试站最小验证。

完成后停止。
