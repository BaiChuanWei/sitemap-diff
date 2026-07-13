# Milestone 6：Dashboard 与导出

## 目标

提供可操作的每日新增、趋势、站点健康和审核界面。

## 页面

- `/daily`
- `/trending`
- `/sites`
- `/reviews`

## /daily

- 日期筛选
- 域名筛选
- 游戏名搜索
- 只看跨站
- CSV
- JSON
- 复制全部 URL

## /trending

显示：

- domains_added_24h
- domains_added_7d
- domains_added_30d
- domains_total
- first_seen_at
- last_seen_at
- trend_score
- confidence

## /sites

- 最近成功
- 连续失败
- Endpoint 数
- URL 数
- 状态
- 手动重跑

## /reviews

- 游戏合并候选
- 证据
- approve / reject / split

## 验证

- build
- 空状态
- 大数据分页
- 筛选
- CSV/JSON 与数据库一致
- 未授权客户端不能读取内部 Secret 或私有表
