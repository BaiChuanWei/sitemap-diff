import { ReactNode, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'

interface LayoutProps {
  children: ReactNode
}

export default function Layout({ children }: LayoutProps) {
  const router = useRouter()

  const navItems = [
    { href: '/', label: 'Dashboard', icon: '📊' },
    { href: '/games', label: 'Games', icon: '🎮' },
    { href: '/sitemaps', label: 'Sitemaps', icon: '🗺️' },
  ]

  return (
    <div className="min-h-screen bg-cyber-darker">
      {/* Animated background */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-1/2 -left-1/2 w-full h-full bg-gradient-to-br from-cyber-blue/5 to-transparent rounded-full blur-3xl animate-pulse" />
        <div className="absolute -bottom-1/2 -right-1/2 w-full h-full bg-gradient-to-tl from-cyber-purple/5 to-transparent rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }} />
      </div>

      {/* Header */}
      <header className="relative border-b border-gray-800/50 backdrop-blur-md">
        <div className="container mx-auto px-4 py-6">
          <div className="flex items-center justify-between">
            {/* Logo */}
            <Link href="/" className="flex items-center space-x-3 group">
              <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-neon-cyan to-neon-magenta flex items-center justify-center text-2xl transform group-hover:scale-110 transition-transform duration-300">
                🎮
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight">
                  <span className="text-neon-cyan">Game</span>
                  <span className="text-neon-magenta">Monitor</span>
                </h1>
                <p className="text-xs text-gray-500 font-mono">CROSS-PLATFORM TRACKER</p>
              </div>
            </Link>

            {/* Navigation */}
            <nav className="flex space-x-2">
              {navItems.map((item) => {
                const isActive = router.pathname === item.href
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`
                      px-6 py-3 rounded-md font-semibold tracking-wider uppercase text-sm
                      transition-all duration-300 flex items-center space-x-2
                      ${isActive
                        ? 'bg-gradient-to-r from-cyber-blue to-cyber-purple text-white shadow-neon-glow'
                        : 'text-gray-400 hover:text-neon-cyan hover:bg-cyber-dark/50'
                      }
                    `}
                  >
                    <span className="text-xl">{item.icon}</span>
                    <span>{item.label}</span>
                  </Link>
                )
              })}
            </nav>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="relative container mx-auto px-4 py-8">
        {children}
      </main>

      {/* Footer */}
      <footer className="relative border-t border-gray-800/50 backdrop-blur-md mt-20">
        <div className="container mx-auto px-4 py-6">
          <div className="flex items-center justify-between text-sm text-gray-500">
            <p className="font-mono">
              GAME MONITOR v2.0 // POWERED BY{' '}
              <span className="text-neon-cyan">SUPABASE</span>
            </p>
            <p className="font-mono">
              © 2026 // ALL SYSTEMS OPERATIONAL
            </p>
          </div>
        </div>
      </footer>
    </div>
  )
}
