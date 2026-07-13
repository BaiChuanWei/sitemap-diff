# 10｜安全与回滚

## Secret

以下变量只能进入 Secret 管理，不得写入代码、日志或前端：

- SUPABASE_URL
- SUPABASE_SERVICE_KEY
- NEXT_PUBLIC_SUPABASE_URL
- NEXT_PUBLIC_SUPABASE_ANON_KEY

其中 Service Key 绝不能进入浏览器端。

## 数据库迁移

每次 Schema 修改必须交付：

- schema 文件
- migration
- rollback
- verification 查询
- 迁移前备份说明
- 迁移失败处理

## 事务边界

一个站点一次成功抓取及其事件写入应尽量处于同一事务边界。

写入失败时：

- 不更新最近成功时间
- 不覆盖成功快照
- 不产生部分业务事件
- 记录失败原因

## 代码回滚

每个 Milestone 独立 commit。  
不得把多个 Milestone 压成一个不可拆分提交。

## 业务数据保护

- 首次运行只 baseline
- 空 Sitemap 不覆盖
- 数量异常下降不覆盖
- 部分子 Sitemap 失败不确认删除
- removed 至少连续两次成功抓取缺失
- 重跑幂等
- 同站失败不影响其他站
