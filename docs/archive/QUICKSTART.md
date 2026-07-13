# 🚀 快速开始 - Web Dashboard

## 1️⃣ 本地开发

### 安装依赖
```bash
cd web
npm install
```

### 配置环境变量
创建 `web/.env.local` 文件：
```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

### 启动开发服务器
```bash
npm run dev
```

打开 http://localhost:3000 即可看到 Dashboard！

---

## 2️⃣ Vercel 部署

### 方式 A: 通过 Vercel CLI
```bash
# 安装 Vercel CLI
npm i -g vercel

# 部署
vercel

# 生产部署
vercel --prod
```

### 方式 B: 通过 GitHub 自动部署
1. 推送代码到 GitHub
2. 在 Vercel Dashboard 导入项目
3. 设置环境变量
4. 自动部署完成！

---

## 3️⃣ 环境变量获取

### Supabase 控制台
1. 打开 https://supabase.com/dashboard
2. 选择你的项目
3. 左侧菜单 → **Settings** → **API**
4. 复制：
   - **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **anon/public key** → `NEXT_PUBLIC_SUPABASE_ANON_KEY`

---

## 4️⃣ 数据库设置

确保 Supabase 数据库已执行 V2 schema：

```bash
# 在 Supabase SQL Editor 执行
cat supabase/migration.sql
```

---

## 5️⃣ 添加第一个 Sitemap

在 Dashboard 的 Sitemaps 页面：
1. 输入 sitemap URL（例如：`https://poki.com/en/sitemaps/games.xml`）
2. 点击 "ADD SITEMAP"
3. 完成！

---

## 🎨 预览效果

访问部署后的域名，你会看到：

### Dashboard 页面
- 📊 实时统计数字（带计数动画）
- 🎮 Top 跨平台游戏卡片
- ✨ 霓虹发光效果

### Games 页面
- 🔍 搜索和筛选功能
- 📋 游戏列表（网格布局）
- 🌐 每个游戏的平台链接

### Sitemaps 页面
- ➕ 添加新 sitemap
- 🗑️ 删除已有 sitemap
- 📋 sitemap 列表

---

## 🐛 常见问题

### 1. 页面显示空白
检查浏览器控制台，确认：
- ✅ 环境变量正确配置
- ✅ Supabase URL 可访问
- ✅ 数据库 schema 已执行

### 2. 无法添加 sitemap
确认：
- ✅ Supabase RLS 策略允许写入
- ✅ URL 格式正确（包含 http/https）

### 3. 游戏列表为空
- ✅ 运行爬虫：`npm run check`（在根目录）
- ✅ 等待 GitHub Actions 执行

---

## 📚 更多信息

- Web Dashboard README: `web/README.md`
- 项目文档: `.claude.md`
- 数据库 Schema: `supabase/schema.sql`

---

## 🎉 完成！

现在你有一个完整的跨平台游戏监控系统了！

**Dashboard**: 实时查看统计
**Games**: 浏览所有游戏
**Sitemaps**: 管理数据源

享受使用吧！ 🚀
