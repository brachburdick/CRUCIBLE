import { Link, useLocation } from 'react-router-dom'
import { useState, useEffect } from 'react'

const NAV_ITEMS = [
  { path: '/', label: 'Dashboard' },
  { path: '/projects', label: 'Projects' },
  { path: '/session', label: 'Session' },
  { path: '/graphs', label: 'Graphs' },
]

export default function NavBar() {
  const location = useLocation()
  const [showToast, setShowToast] = useState(false)

  const handleCommitClick = () => {
    setShowToast(true)
  }

  useEffect(() => {
    if (showToast) {
      const timer = setTimeout(() => {
        setShowToast(false)
      }, 2000)

      return () => clearTimeout(timer)
    }
  }, [showToast])

  return (
    <>
      <header className="border-b border-slate-800 bg-slate-950 px-6 py-3 flex items-center gap-8">
        <Link to="/" className="flex items-center gap-2">
          <h1 className="text-lg font-bold tracking-tight text-orange-400">CRUCIBLE</h1>
        </Link>

        <nav className="flex gap-1">
          {NAV_ITEMS.map(item => {
            const isActive = item.path === '/'
              ? location.pathname === '/'
              : location.pathname.startsWith(item.path)

            return (
              <Link
                key={item.path}
                to={item.path}
                className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-orange-500/10 text-orange-400 border border-orange-500/20'
                    : 'text-slate-400 hover:text-orange-300 hover:bg-slate-800/50'
                }`}
              >
                {item.label}
              </Link>
            )
          })}
        </nav>

        <button
          onClick={handleCommitClick}
          className="px-3 py-1.5 rounded text-sm font-medium transition-colors text-slate-400 hover:text-orange-300 hover:bg-slate-800/50 flex items-center gap-2"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          Commit
        </button>

        <div className="ml-auto text-xs text-slate-600">
          Agent Evaluation Harness
        </div>
      </header>

      {/* Toast notification */}
      {showToast && (
        <div className="fixed bottom-6 left-1/2 transform -translate-x-1/2 z-50">
          <div className="bg-slate-800 border border-slate-700 text-orange-300 px-4 py-2 rounded-lg shadow-lg">
            Git commit — coming soon
          </div>
        </div>
      )}
    </>
  )
}