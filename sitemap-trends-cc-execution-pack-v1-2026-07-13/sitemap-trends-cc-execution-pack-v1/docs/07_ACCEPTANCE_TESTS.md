# 07｜分层验收

## Level 0｜静态验证

- lint
- 类型检查
- 构建
- SQL 语法
- RLS
- Secret 扫描
- 未引用代码
- 依赖检查

## Level 1｜单元测试

必须覆盖：

1. 普通 urlset
2. Sitemap Index
3. 两层嵌套 Index
4. XML.GZ
5. XML 命名空间
6. 重复 URL
7. 空 Sitemap
8. 截断 XML
9. HTML 冒充 XML
10. 循环 Index
11. 超过递归深度
12. URL 标准化
13. baseline
14. added
15. removed
16. restored
17. 幂等重跑
18. 同域名多个 Sitemap

## Level 2｜集成测试

```text
发现站点
→ 保存 Endpoint
→ 抓取 Sitemap
→ 建立 baseline
→ 修改 fixture
→ 再次抓取
→ 产生 added
→ 写入事件
→ 生成每日数据
```

## Level 3｜最小最优验证

3 个结构不同的测试源：

- 普通 XML
- Sitemap Index
- XML.GZ

第一次运行：

- baseline 成功
- added = 0

第二次运行：

- 新增一个 URL
- 只产生一条 added
- 重跑不重复

## Level 4｜10 站冒烟

- 10 站全部完成
- 单站失败不影响其他站
- Dashboard 可见
- CSV 与数据库一致
- 重跑不重复

## Level 5｜100 站预生产

连续两个完整周期，输出：

- 总站点数
- 成功数
- 部分成功数
- 失败数
- Endpoint 数
- URL 总数
- 新增 URL 数
- 疑似游戏数
- 审核数
- 总耗时

## Level 6｜最消极验证

必须测试：

- 403
- 404
- 429
- 超时
- DNS 失败
- 无限重定向
- 空响应
- HTML 冒充 XML
- Gzip 损坏
- 解压后超大
- XML 截断
- Index 循环
- 子 Sitemap 部分失败
- URL 数量下降 90%
- 数据库写入失败
- GitHub Actions 中途取消
- 同一任务执行两次
- 两个 shard 重复处理同一站
- 同一 URL 出现在多个 Sitemap
- 同游戏多个语言 URL
- 时区跨日
- 数据库回滚

通过标准：

> 即使所有外部抓取失败，最近一次成功数据仍然完整，不产生假新增、假删除或重复事件。
