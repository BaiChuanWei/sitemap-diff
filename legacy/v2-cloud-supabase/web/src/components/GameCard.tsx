import { Game, GameSource } from '@/lib/supabase'
import { motion } from 'framer-motion'

interface GameCardProps {
  game: Game
  index: number
}

export default function GameCard({ game, index }: GameCardProps) {
  const scoreColor = (score: number) => {
    if (score >= 2.5) return 'text-neon-magenta'
    if (score >= 2.0) return 'text-neon-yellow'
    if (score >= 1.5) return 'text-neon-cyan'
    return 'text-gray-400'
  }

  const platformBadgeColor = (count: number) => {
    if (count >= 4) return 'from-neon-magenta/30 to-neon-yellow/30 border-neon-magenta text-neon-magenta'
    if (count >= 3) return 'from-neon-yellow/30 to-neon-green/30 border-neon-yellow text-neon-yellow'
    if (count >= 2) return 'from-neon-cyan/30 to-cyber-blue/30 border-neon-cyan text-neon-cyan'
    return 'from-gray-700/30 to-gray-600/30 border-gray-600 text-gray-400'
  }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.3, delay: index * 0.05 }}
      className="game-card group"
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1 min-w-0">
          <h3 className="text-xl font-bold text-white truncate group-hover:text-neon-cyan transition-colors duration-300">
            {game.name}
          </h3>
          <p className="text-xs text-gray-500 font-mono mt-1">
            ID: {game.clean_name}
          </p>
        </div>

        {/* Platform count badge */}
        <div className={`
          ml-4 px-4 py-2 rounded-full text-sm font-bold
          bg-gradient-to-r ${platformBadgeColor(game.platform_count)}
          border flex items-center space-x-2
        `}>
          <span>🌐</span>
          <span>{game.platform_count}</span>
        </div>
      </div>

      {/* Score */}
      <div className="flex items-center space-x-2 mb-4">
        <span className="text-gray-500 text-sm">SCORE:</span>
        <span className={`text-2xl font-bold font-mono ${scoreColor(game.score)}`}>
          {game.score.toFixed(1)}
        </span>
        <div className="flex-1 h-2 bg-cyber-dark rounded-full overflow-hidden">
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${(game.score / 2.5) * 100}%` }}
            transition={{ duration: 1, delay: index * 0.05 }}
            className={`h-full bg-gradient-to-r ${
              game.score >= 2.5 ? 'from-neon-magenta to-neon-yellow' :
              game.score >= 2.0 ? 'from-neon-yellow to-neon-green' :
              game.score >= 1.5 ? 'from-neon-cyan to-cyber-blue' :
              'from-gray-600 to-gray-500'
            }`}
          />
        </div>
      </div>

      {/* Platforms */}
      <div className="space-y-2">
        <p className="text-xs text-gray-500 uppercase tracking-wider font-semibold">
          Available on:
        </p>
        <div className="space-y-1 max-h-32 overflow-y-auto scrollbar-cyber">
          {game.game_sources?.map((source: GameSource, idx: number) => (
            <a
              key={idx}
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between p-2 rounded bg-cyber-dark/50 hover:bg-cyber-dark border border-gray-800 hover:border-neon-cyan/30 transition-all duration-300 group/link"
            >
              <span className="text-sm text-gray-400 group-hover/link:text-neon-cyan transition-colors truncate font-mono">
                {source.domain}
              </span>
              <span className="text-neon-cyan opacity-0 group-hover/link:opacity-100 transition-opacity ml-2">
                →
              </span>
            </a>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="mt-4 pt-4 border-t border-gray-800 flex items-center justify-between text-xs text-gray-500 font-mono">
        <span>
          FIRST SEEN: {new Date(game.first_seen).toLocaleDateString()}
        </span>
        {game.platform_count >= 2 && (
          <span className="text-neon-cyan animate-glow-pulse">
            ⭐ CROSS-PLATFORM
          </span>
        )}
      </div>
    </motion.div>
  )
}
