import { Link } from 'react-router-dom'
import { useFetch } from '../hooks/useApi'
import NavBar from '../components/NavBar'

interface GraphEntry {
  id: string
}

export default function GraphList() {
  const { data: graphs } = useFetch<GraphEntry[]>('/api/graphs')

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <NavBar />

      <div className="max-w-5xl mx-auto px-6 py-6">
        <h2 className="text-lg font-semibold mb-4">Decomposition Graphs</h2>

        <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
          {graphs && graphs.length > 0 ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400 text-left">
                  <th className="px-4 py-3 font-medium">Graph ID</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {graphs.map(g => (
                  <tr key={g.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                    <td className="px-4 py-3 font-mono text-sm text-orange-400">
                      <Link to={`/graphs/${g.id}`} className="hover:text-orange-300">
                        {g.id}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        to={`/graphs/${g.id}`}
                        className="text-xs text-slate-400 hover:text-slate-200"
                      >
                        View →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="px-4 py-8 text-center text-slate-500">
              {graphs === null ? 'Loading...' : 'No graphs found. Run a decomposition to create one.'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
