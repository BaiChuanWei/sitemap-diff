import { useEffect, useState } from 'react'
import Layout from '@/components/Layout'
import StatCard from '@/components/StatCard'
import GameCard from '@/components/GameCard'
import { getStats, getGames, Game, Stats } from '@/lib/supabase'
import { motion } from 'framer-motion'

export default function Dashboard() {
  const [stats, setStats] = useState<Stats>({
    totalGames: 0,
    totalPlatforms: 0,
    crossPlatformGames: 0,
    highScoreGames: 0,
  })
  const [topGames, setTopGames] = useState<Game[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadData() {
      try {
        const [statsData, gamesData] = await Promise.all([
          getStats(),
          getGames({ minPlatforms: 2, limit: 6 }),
        ])
        setStats(statsData)
        setTopGames(gamesData)
      } catch (error) {
        console.error('Error loading data:', error)
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [])

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="text-center">
            <div className="w-16 h-16 border-4 border-neon-cyan border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-gray-400 font-mono">LOADING SYSTEM DATA...</p>
          </div>
        </div>
      </Layout>
    )
  }

  return (
    <Layout>
      {/* Hero Section */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="mb-12 text-center"
      >
        <h1 className="text-5xl font-bold mb-4">
          <span className="text-neon-cyan text-glow">SYSTEM</span>{' '}
          <span className="text-neon-magenta text-glow">DASHBOARD</span>
        </h1>
        <p className="text-gray-400 font-mono text-lg">
          REAL-TIME CROSS-PLATFORM GAME TRACKING SYSTEM
        </p>
      </motion.div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-12">
        <StatCard
          title="Total Games"
          value={stats.totalGames}
          icon="🎮"
          color="cyan"
          delay={0}
        />
        <StatCard
          title="Platforms"
          value={stats.totalPlatforms}
          icon="🌐"
          color="magenta"
          delay={0.1}
        />
        <StatCard
          title="Cross-Platform"
          value={stats.crossPlatformGames}
          icon="⭐"
          color="yellow"
          delay={0.2}
        />
        <StatCard
          title="High Score"
          value={stats.highScoreGames}
          icon="🏆"
          color="green"
          delay={0.3}
        />
      </div>

      {/* Top Cross-Platform Games */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.4 }}
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-3xl font-bold">
            <span className="text-neon-cyan">TOP</span>{' '}
            <span className="text-white">CROSS-PLATFORM GAMES</span>
          </h2>
          <a
            href="/games"
            className="px-6 py-3 rounded-md font-semibold tracking-wider uppercase text-sm
                     border-2 border-neon-cyan text-neon-cyan
                     hover:bg-neon-cyan hover:text-cyber-dark transition-all duration-300"
          >
            View All →
          </a>
        </div>

        {topGames.length === 0 ? (
          <div className="card-cyber p-12 text-center">
            <p className="text-gray-500 text-lg font-mono">
              NO CROSS-PLATFORM GAMES FOUND
            </p>
            <p className="text-gray-600 text-sm mt-2">
              Run the crawler to discover games across multiple platforms
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {topGames.map((game, index) => (
              <GameCard key={game.id} game={game} index={index} />
            ))}
          </div>
        )}
      </motion.div>

      {/* System Status */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.6 }}
        className="mt-12 card-cyber p-6"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-3 h-3 bg-neon-green rounded-full animate-glow-pulse" />
            <span className="font-mono text-gray-400">SYSTEM STATUS:</span>
            <span className="font-bold text-neon-green">OPERATIONAL</span>
          </div>
          <div className="font-mono text-sm text-gray-500">
            LAST UPDATE: {new Date().toLocaleString()}
          </div>
        </div>
      </motion.div>
    </Layout>
  )
}
