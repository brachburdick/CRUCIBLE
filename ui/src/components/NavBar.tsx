import { Link, useLocation } from 'react-router-dom'

const NAV_ITEMS = [
  { path: '/', label: 'Dashboard' },
  { path: '/projects', label: 'Projects' },
  { path: '/session', label: 'Session' },
  { path: '/graphs', label: 'Graphs' },
]

export default function NavBar() {
  const location = useLocation()

  return (
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

      <div className="ml-auto text-xs text-slate-600">
        Agent Evaluation Harness
      </div>
    </header>
  )
}
