import { useEffect, useState } from 'react'
import Layout from '@/components/Layout'
import { getFeeds, addFeed, deleteFeed, Feed } from '@/lib/supabase'
import { motion } from 'framer-motion'

export default function SitemapsPage() {
  const [feeds, setFeeds] = useState<Feed[]>([])
  const [loading, setLoading] = useState(true)
  const [newUrl, setNewUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')

  async function loadFeeds() {
    try {
      const data = await getFeeds()
      setFeeds(data)
    } catch (error) {
      console.error('Error loading feeds:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadFeeds()
  }, [])

  async function handleAddFeed(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (!newUrl.trim()) {
      setError('Please enter a URL')
      return
    }

    try {
      new URL(newUrl) // Validate URL
    } catch {
      setError('Invalid URL format')
      return
    }

    setAdding(true)
    try {
      await addFeed(newUrl)
      setNewUrl('')
      await loadFeeds()
    } catch (error: any) {
      setError(error.message || 'Failed to add sitemap')
    } finally {
      setAdding(false)
    }
  }

  async function handleDeleteFeed(id: number) {
    if (!confirm('Are you sure you want to delete this sitemap?')) return

    try {
      await deleteFeed(id)
      await loadFeeds()
    } catch (error) {
      console.error('Error deleting feed:', error)
      alert('Failed to delete sitemap')
    }
  }

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="text-center">
            <div className="w-16 h-16 border-4 border-neon-cyan border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-gray-400 font-mono">LOADING SITEMAPS...</p>
          </div>
        </div>
      </Layout>
    )
  }

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
          <span className="text-neon-magenta text-glow">SITEMAP</span>{' '}
          <span className="text-white">MANAGEMENT</span>
        </h1>
        <p className="text-gray-400 font-mono text-lg">
          {feeds.length} SITEMAPS CONFIGURED // MANAGE YOUR DATA SOURCES
        </p>
      </motion.div>

      {/* Add New Sitemap */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.2 }}
        className="card-cyber p-6 mb-8"
      >
        <h2 className="text-xl font-bold text-neon-cyan mb-4 uppercase tracking-wider">
          Add New Sitemap
        </h2>
        <form onSubmit={handleAddFeed} className="flex gap-4">
          <input
            type="text"
            placeholder="https://example.com/sitemap.xml"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            className="input-cyber flex-1"
            disabled={adding}
          />
          <button
            type="submit"
            disabled={adding}
            className="btn-cyber disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {adding ? 'ADDING...' : 'ADD SITEMAP'}
          </button>
        </form>
        {error && (
          <p className="mt-3 text-neon-magenta text-sm font-mono">
            ⚠️ {error}
          </p>
        )}
      </motion.div>

      {/* Sitemap List */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.3 }}
      >
        <h2 className="text-2xl font-bold mb-6 uppercase tracking-wider">
          <span className="text-neon-cyan">CONFIGURED</span> SITEMAPS
        </h2>

        {feeds.length === 0 ? (
          <div className="card-cyber p-12 text-center">
            <p className="text-gray-500 text-lg font-mono">
              NO SITEMAPS CONFIGURED
            </p>
            <p className="text-gray-600 text-sm mt-2">
              Add your first sitemap above to start tracking games
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4">
            {feeds.map((feed, index) => (
              <motion.div
                key={feed.id}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3, delay: index * 0.05 }}
                className="card-cyber p-6 hover:border-neon-cyan/40 transition-all duration-300 group"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    {/* Domain badge */}
                    <div className="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold bg-gradient-to-r from-neon-cyan/20 to-neon-magenta/20 border border-neon-cyan/30 text-neon-cyan mb-3">
                      🌐 {feed.domain}
                    </div>

                    {/* URL */}
                    <p className="text-sm text-gray-300 font-mono break-all mb-3 group-hover:text-neon-cyan transition-colors">
                      {feed.url}
                    </p>

                    {/* Metadata */}
                    <div className="flex items-center space-x-6 text-xs text-gray-500 font-mono">
                      <span>
                        ADDED: {new Date(feed.created_at).toLocaleDateString()}
                      </span>
                      <span>
                        UPDATED: {new Date(feed.updated_at).toLocaleDateString()}
                      </span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="ml-6 flex items-center space-x-3">
                    <a
                      href={feed.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-4 py-2 rounded-md text-sm font-semibold border border-gray-700 text-gray-400 hover:border-neon-cyan hover:text-neon-cyan transition-all duration-300"
                    >
                      VIEW
                    </a>
                    <button
                      onClick={() => handleDeleteFeed(feed.id)}
                      className="px-4 py-2 rounded-md text-sm font-semibold border border-gray-700 text-gray-400 hover:border-neon-magenta hover:text-neon-magenta hover:bg-neon-magenta/10 transition-all duration-300"
                    >
                      DELETE
                    </button>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </motion.div>
    </Layout>
  )
}
