# 🎮 GameMonitor Dashboard

A cyberpunk-themed web dashboard for tracking cross-platform games.

## ✨ Features

- **Dashboard**: Real-time statistics and top cross-platform games
- **Games Database**: Browse, search, and filter all tracked games
- **Sitemap Management**: Add/remove sitemap sources
- **Cross-Platform Detection**: Automatic game matching across platforms
- **Scoring System**: Games ranked by platform presence

## 🎨 Design

- Cyberpunk/neon aesthetic with霓虹色调
- Rajdhani + JetBrains Mono fonts
- Smooth animations with Framer Motion
- Fully responsive design

## 🚀 Getting Started

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env.local`:

```bash
cp .env.example .env.local
```

Edit `.env.local` with your Supabase credentials:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
```

### 3. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## 📦 Build for Production

```bash
npm run build
npm start
```

## 🌐 Deploy to Vercel

1. Push code to GitHub
2. Import project in Vercel
3. Add environment variables:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
4. Deploy!

## 🗂️ Project Structure

```
web/
├── src/
│   ├── components/       # React components
│   │   ├── Layout.tsx
│   │   ├── StatCard.tsx
│   │   └── GameCard.tsx
│   ├── pages/           # Next.js pages
│   │   ├── index.tsx    # Dashboard
│   │   ├── games.tsx    # Games list
│   │   └── sitemaps.tsx # Sitemap management
│   ├── lib/             # Utilities
│   │   └── supabase.ts  # Supabase client
│   └── styles/          # Global styles
│       └── globals.css
├── public/              # Static assets
├── tailwind.config.js   # Tailwind configuration
└── package.json
```

## 🎯 Tech Stack

- **Framework**: Next.js 14
- **Styling**: TailwindCSS
- **Animations**: Framer Motion
- **Database**: Supabase
- **Language**: TypeScript
- **Deployment**: Vercel

## 📝 Notes

- Make sure your Supabase database has the correct schema (see `../supabase/schema.sql`)
- The dashboard uses public read-only access to Supabase
- For write operations (add/delete sitemaps), ensure RLS policies allow it
