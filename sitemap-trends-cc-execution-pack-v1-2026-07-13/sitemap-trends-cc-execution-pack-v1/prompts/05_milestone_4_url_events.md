# Milestone 4：URL 事件系统

## 目标

在成功抓取数据基础上生成可靠、幂等的 URL 业务事件。

## 必须实现

- baseline
- added
- removed
- restored
- URL 标准化
- 事件幂等
- 同 URL 多 Endpoint 来源关系
- 连续两次成功缺失才 removed
- 抓取失败不产生 removed
- 异常数量下降不覆盖
- 数据库失败整站事务回滚
- 每日新增查询
- CSV / JSON 后端导出接口

## 验证

1. 首次运行 added = 0
2. 第二次新增一个 URL，只产生一条 added
3. 重跑不重复
4. 一次缺失不 removed
5. 两次成功缺失才 removed
6. 恢复后 restored
7. 空 Sitemap 不覆盖
8. 数据库失败不产生部分事件

完成后，系统应已经能提供可靠的每日新增 URL。
