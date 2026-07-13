import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'

interface StatCardProps {
  title: string
  value: number
  icon: string
  color: 'cyan' | 'magenta' | 'yellow' | 'green'
  delay?: number
}

export default function StatCard({ title, value, icon, color, delay = 0 }: StatCardProps) {
  const [displayValue, setDisplayValue] = useState(0)

  useEffect(() => {
    // 数字计数动画
    const duration = 1000
    const steps = 60
    const increment = value / steps
    let current = 0

    const timer = setInterval(() => {
      current += increment
      if (current >= value) {
        setDisplayValue(value)
        clearInterval(timer)
      } else {
        setDisplayValue(Math.floor(current))
      }
    }, duration / steps)

    return () => clearInterval(timer)
  }, [value])

  const colorClasses = {
    cyan: 'from-neon-cyan/20 to-cyber-blue/20 border-neon-cyan/30 text-neon-cyan',
    magenta: 'from-neon-magenta/20 to-cyber-purple/20 border-neon-magenta/30 text-neon-magenta',
    yellow: 'from-neon-yellow/20 to-neon-green/20 border-neon-yellow/30 text-neon-yellow',
    green: 'from-neon-green/20 to-cyber-blue/20 border-neon-green/30 text-neon-green',
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay }}
      className={`stat-card bg-gradient-to-br ${colorClasses[color]}`}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-gray-400 text-sm font-medium uppercase tracking-wider mb-2">
            {title}
          </p>
          <p className={`text-5xl font-bold font-mono ${colorClasses[color].split(' ')[2]}`}>
            {displayValue.toLocaleString()}
          </p>
        </div>
        <div className="text-5xl opacity-20">
          {icon}
        </div>
      </div>

      {/* Glow effect */}
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent -translate-x-full animate-[shimmer_3s_infinite]" />
    </motion.div>
  )
}
