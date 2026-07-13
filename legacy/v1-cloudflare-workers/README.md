# V1（已废弃）— Cloudflare Workers + Discord/Telegram Bot

这是本项目最早的实现（2024），运行在 Cloudflare Workers 上，通过 Discord/Telegram Bot 推送 sitemap 变化通知，数据存储在 Cloudflare KV。

**当前生产架构（V2）已不使用这套代码**：生产链路是 GitHub Actions（`.github/workflows/check-sitemaps.yml`）+ Supabase + Vercel/Next.js，入口是仓库根目录的 `lib/check-sitemaps.js`，与本目录下的代码没有任何引用关系。`package.json` 的依赖、脚本也均针对 V2。

保留这份代码只是为了不丢失历史实现，不代表可以直接部署使用（`wrangler.toml` 里的 KV namespace id 等配置可能已失效）。如需了解当前系统的真实架构，请看仓库根目录的 `README.md` 和 `.claude.md`。
