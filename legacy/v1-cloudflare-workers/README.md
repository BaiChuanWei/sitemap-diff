# V1（已废弃）— Cloudflare Workers + Discord/Telegram Bot

最早的实现（2024），运行在 Cloudflare Workers 上，通过 Discord/Telegram Bot 推送 sitemap 变化通知，数据存储在 Cloudflare KV。

已确认在 V2（Supabase 云方案）阶段就已经是孤儿代码：没有任何 workflow、脚本或文档实际调用这里的 `wrangler deploy`，`package.json` 也没有 `wrangler` 依赖。

当前项目方向（见根目录 `CURRENT_GOAL.md`）是 Windows 本地单机工具，与这套代码更无关系。保留仅为不丢失历史实现，不代表可以直接部署使用。
