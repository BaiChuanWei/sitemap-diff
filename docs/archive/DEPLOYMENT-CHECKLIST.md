# ✅ 部署检查清单

在部署前请确保以下所有项目都已完成：

## 📋 Supabase 设置

- [ ] 创建 Supabase 项目
- [ ] 执行 `supabase/migration.sql` 创建数据库表
- [ ] 获取 Project URL
- [ ] 获取 anon/public key
- [ ] 获取 service_role key（用于爬虫）
- [ ] 确认 RLS 策略已启用

## 🌐 Vercel 部署

- [ ] 代码推送到 GitHub
- [ ] 在 Vercel 导入项目
- [ ] 设置环境变量：
  - [ ] `NEXT_PUBLIC_SUPABASE_URL`
  - [ ] `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- [ ] 触发首次部署
- [ ] 验证部署成功（访问域名）
- [ ] 测试三个页面：Dashboard, Games, Sitemaps

## 🤖 GitHub Actions 设置

- [ ] 在 GitHub 仓库 Settings → Secrets 添加：
  - [ ] `SUPABASE_URL`
  - [ ] `SUPABASE_SERVICE_KEY`
- [ ] 验证 `.github/workflows/check-sitemaps.yml` 存在
- [ ] 手动触发一次 Action 测试
- [ ] 确认 Action 成功运行

## 🎮 初始化数据

- [ ] 通过 Web Dashboard 添加第一个 sitemap
- [ ] 手动触发 GitHub Action 或运行 `npm run check`
- [ ] 验证游戏数据已写入数据库
- [ ] 在 Dashboard 查看统计数字更新
- [ ] 在 Games 页面查看游戏列表

## 🔍 功能测试

### Dashboard 页面
- [ ] 统计卡片显示正确数字
- [ ] 数字计数动画正常
- [ ] Top 游戏列表显示
- [ ] 系统状态显示绿色

### Games 页面
- [ ] 游戏列表加载正常
- [ ] 搜索功能工作
- [ ] 平台数量筛选工作
- [ ] 域名筛选工作
- [ ] 游戏卡片悬浮效果
- [ ] 平台链接可点击

### Sitemaps 页面
- [ ] Sitemap 列表显示
- [ ] 添加新 sitemap 功能
- [ ] 删除 sitemap 功能
- [ ] URL 验证工作

## 🎨 UI/UX 检查

- [ ] 霓虹发光效果正常
- [ ] 动画流畅无卡顿
- [ ] 移动端响应式正常
- [ ] 字体加载正常（Rajdhani + JetBrains Mono）
- [ ] 配色符合赛博朋克风格
- [ ] 所有按钮悬浮效果正常

## 🔐 安全检查

- [ ] 环境变量不在代码中硬编码
- [ ] `.env` 文件已加入 `.gitignore`
- [ ] Supabase RLS 策略正确配置
- [ ] Service key 只在服务端使用
- [ ] Anon key 可以公开使用

## 📱 浏览器兼容性

- [ ] Chrome/Edge 测试通过
- [ ] Firefox 测试通过
- [ ] Safari 测试通过
- [ ] 移动端浏览器测试通过

## 🚀 性能优化

- [ ] 图片已优化
- [ ] 构建产物大小合理
- [ ] 页面加载速度 < 3秒
- [ ] Lighthouse 分数 > 80

## 📊 监控设置（可选）

- [ ] 设置 Vercel Analytics
- [ ] 设置错误监控（Sentry 等）
- [ ] 设置 Uptime 监控

---

## ✨ 部署完成后

1. 将部署域名分享给团队
2. 添加常用的 sitemap URLs
3. 观察第一次爬取结果
4. 根据需要调整 GitHub Actions 执行频率

---

## 🆘 遇到问题？

1. 检查浏览器控制台错误
2. 检查 Vercel 部署日志
3. 检查 GitHub Actions 日志
4. 检查 Supabase 日志
5. 参考 `QUICKSTART.md` 常见问题

---

**祝部署顺利！** 🎉
