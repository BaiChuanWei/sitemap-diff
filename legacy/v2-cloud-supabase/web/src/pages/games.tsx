import { useEffect, useState } from 'react'
import Layout from '@/components/Layout'
import GameCard from '@/components/GameCard'
import { getGames, getFeeds, Game, Feed } from '@/lib/supabase'
import { motion } from 'framer-motion'

export default function GamesPage() {
  const [games, setGames] = useState<Game[]>([])
  const [domains, setDomains] = useState<string[]>([])
  const [loading, setLoading] = useState(true)

  // Filters
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedDomain, setSelectedDomain] = useState('')
  const [minPlatforms, setMinPlatforms] = useState<number | undefined>()

  useEffect(() => {
    async function loadDomains() {
      try {
        const feeds = await getFeeds()
        const uniqueDomains = [...new Set(feeds.map((f: Feed) => f.domain))]
        setDomains(uniqueDomains)
      } catch (error) {
        console.error('Error loading domains:', error)
      }
    }
    loadDomains()
  }, [])

  useEffect(() => {
    async function loadGames() {
      setLoading(true)
      try {
        const filters: any = {}
        if (searchTerm) filters.search = searchTerm
        if (selectedDomain) filters.domain = selectedDomain
        if (minPlatforms) filters.minPlatforms = minPlatforms

        const data = await getGames(filters)
        setGames(data)
      } catch (error) {
        console.error('Error loading games:', error)
      } finally {
        setLoading(false)
      }
    }

    const debounce = setTimeout(loadGames, 300)
    return () => clearTimeout(debounce)
  }, [searchTerm, selectedDomain, minPlatforms])

  return (
    <Layout>
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="mb-8"
      >
        <h1 className="text-5xl font-bold mb-4">
          <span className="text-neon-cyan text-glow">GAME</span>{' '}
          <span className="text-white">DATABASE</span>
        </h1>
        <p className="text-gray-400 font-mono text-lg">
          {games.length.toLocaleString()} GAMES TRACKED ACROSS MULTIPLE PLATFORMS
        </p>
      </motion.div>

      {/* Filters */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.2 }}
        className="card-cyber p-6 mb-8"
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Search */}
          <div>
            <label className="block text-sm font-semibold text-gray-400 mb-2 uppercase tracking-wider">
              Search Games
            </label>
            <input
              type="text"
              placeholder="Enter game name..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="input-cyber w-full"
            />
          </div>

          {/* Platform Filter */}
          <div>
            <label className="block text-sm font-semibold text-gray-400 mb-2 uppercase tracking-wider">
              Platform Count
            </label>
            <select
              value={minPlatforms || ''}
              onChange={(e) => setMinPlatforms(e.target.value ? Number(e.target.value) : undefined)}
              className="input-cyber w-full"
            >
              <option value="">All Games</option>
              <option value="2">2+ Platforms</option>
              <option value="3">3+ Platforms</option>
              <option value="4">4+ Platforms</option>
            </select>
          </div>

          {/* Domain Filter */}
          <div>
            <label className="block text-sm font-semibold text-gray-400 mb-2 uppercase tracking-wider">
              Filter by Domain
            </label>
            <select
              value={selectedDomain}
              onChange={(e) => setSelectedDomain(e.target.value)}
              className="input-cyber w-full"
            >
              <option value="">All Domains</option>
              {domains.map((domain) => (
                <option key={domain} value={domain}>
                  {domain}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Active filters badge */}
        {(searchTerm || selectedDomain || minPlatforms) && (
          <div className="mt-4 flex items-center space-x-2">
            <span className="text-sm text-gray-500">ACTIVE FILTERS:</span>
            {searchTerm && (
              <span className="badge-platform">
                Search: {searchTerm}
              </span>
            )}
            {minPlatforms && (
              <span className="badge-platform">
                {minPlatforms}+ Platforms
              </span>
            )}
            {selectedDomain && (
              <span className="badge-platform">
                {selectedDomain}
              </span>
            )}
            <button
              onClick={() => {
                setSearchTerm('')
                setSelectedDomain('')
                setMinPlatforms(undefined)
              }}
              className="text-sm text-neon-cyan hover:text-neon-magenta transition-colors"
            >
              Clear All
            </button>
          </div>
        )}
      </motion.div>

      {/* Games Grid */}
      {loading ? (
        <div className="flex items-center justify-center min-h-[40vh]">
          <div className="text-center">
            <div className="w-16 h-16 border-4 border-neon-cyan border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-gray-400 font-mono">LOADING GAMES...</p>
          </div>
        </div>
      ) : games.length === 0 ? (
        <div className="card-cyber p-12 text-center">
          <p className="text-gray-500 text-lg font-mono">NO GAMES FOUND</p>
          <p className="text-gray-600 text-sm mt-2">
            Try adjusting your filters or run the crawler
          </p>
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.3 }}
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
        >
          {games.map((game, index) => (
            <GameCard key={game.id} game={game} index={index} />
          ))}
        </motion.div>
      )}
    </Layout>
  )
}
