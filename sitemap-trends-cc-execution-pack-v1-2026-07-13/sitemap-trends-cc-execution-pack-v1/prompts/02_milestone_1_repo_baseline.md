# Milestone 1：仓库基线与架构冻结

开始前重新阅读 CLAUDE.md 与 docs。

## 目标

统一当前生产架构和文档，建立可重复的安装、检查、构建基线。

## 允许修改

- README
- docs
- legacy 目录
- 测试与构建文档
- 不改变业务行为的配置修正

## 禁止修改

- 数据库业务 Schema
- Sitemap Diff 业务逻辑
- 游戏实体逻辑
- Dashboard 功能范围

## 必须完成

1. 确认 GitHub Actions + Supabase + Next.js + Vercel 为当前目标架构。
2. 搜索所有 V1/Cloudflare 遗留引用。
3. 仅在确认无生产引用后，把遗留代码移动至 legacy，不直接删除。
4. 更新 README。
5. 记录当前构建和运行命令。
6. 建立当前测试基线。
7. 输出未解决冲突。

## 验证

- 根目录安装
- 当前检查脚本可运行
- web 安装
- web build
- Secret 未进入日志

完成后停止，并按 milestone_report 模板报告。
