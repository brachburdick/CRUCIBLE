import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useFetch } from '../hooks/useApi'
import { useWebSocket } from '../hooks/useWebSocket'
import RunStatusBadge from '../components/RunStatusBadge'
import LaunchForm from '../components/LaunchForm'

interface RunRow {
  id: string
  agent: string
  variant: string
  status: string
  token_count: number
  wall_time_ms: number | null
  budget: number
  started_at: string
}

export default function Dashboard() {
  const navigate = useNavigate()
  const { data: runs, refetch } = useFetch<RunRow[]>('/api/runs')
  const { messages } = useWebSocket()
  const [showLaunch, setShowLaunch] = useState(false)

  // Refetch run list when status changes come in
  useEffect(() => {
    const statusEvents = messages.filter(m =>
      m.event === 'run_started' || m.event === 'run_completed'
    )
    if (statusEvents.length > 0) {
      refetch()
    }
  }, [messages.length, refetch])

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      {/* Header */}
      <header className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">CRUCIBLE</h1>
          <p className="text-sm text-slate-500">Agent Evaluation Harness</p>
        </div>
        <button
          onClick={() => setShowLaunch(!showLaunch)}
          className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium py-2 px-4 rounded transition-colors"
        >
          {showLaunch ? 'Cancel' : 'New Run'}
        </button>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-6">
        {/* Launch Form */}
        {showLaunch && (
          <div className="mb-6 bg-slate-900 border border-slate-800 rounded-lg p-6">
            <h2 className="text-lg font-semibold mb-4">Launch Run</h2>
            <LaunchForm onLaunched={(runId) => {
              setShowLaunch(false)
              navigate(`/runs/${runId}`)
            }} />
          </div>
        )}

        {/* Run Table */}
        <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 text-left">
                <th className="px-4 py-3 font-medium">Run ID</th>
                <th className="px-4 py-3 font-medium">Agent</th>
                <th className="px-4 py-3 font-medium">Variant</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-right">Tokens</th>
                <th className="px-4 py-3 font-medium text-right">Time</th>
                <th className="px-4 py-3 font-medium text-right">Started</th>
              </tr>
            </thead>
            <tbody>
              {runs && runs.length > 0 ? (
                runs.map(run => (
                  <tr key={run.id} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                    <td className="px-4 py-3">
                      <Link to={`/runs/${run.id}`} className="text-blue-400 hover:text-blue-300 font-mono text-xs">
                        {run.id.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-300">{run.agent}</td>
                    <td className="px-4 py-3 text-slate-300">{run.variant}</td>
                    <td className="px-4 py-3"><RunStatusBadge status={run.status} /></td>
                    <td className="px-4 py-3 text-right font-mono text-slate-400">
                      {run.token_count.toLocaleString()}/{run.budget.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-400">
                      {run.wall_time_ms != null ? `${(run.wall_time_ms / 1000).toFixed(1)}s` : '—'}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-500 text-xs">
                      {new Date(run.started_at).toLocaleString()}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    {runs === null ? 'Loading...' : 'No runs yet. Click "New Run" to get started.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
