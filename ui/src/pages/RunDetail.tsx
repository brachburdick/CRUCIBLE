import { useEffect, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useFetch } from '../hooks/useApi'
import { useWebSocket, type WsMessage } from '../hooks/useWebSocket'
import RunStatusBadge from '../components/RunStatusBadge'
import TokenProgressBar from '../components/TokenProgressBar'
import EventFeed from '../components/EventFeed'
import NavBar from '../components/NavBar'

interface RunDetail {
  id: string
  agent: string
  variant: string
  status: string
  task_file: string
  task_json: string
  budget: number
  ttl_seconds: number
  token_count: number
  wall_time_ms: number | null
  exit_reason: string | null
  started_at: string
  completed_at: string | null
  events: Array<{
    event: string
    data: string
    timestamp: string
  }>
}

export default function RunDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { data: run, refetch } = useFetch<RunDetail>(`/api/runs/${id}`, [id])
  const { messages, subscribe } = useWebSocket()

  // Subscribe to this run's events
  useEffect(() => {
    if (id) subscribe(id)
  }, [id, subscribe])

  // Refetch when run completes
  useEffect(() => {
    const completed = messages.find(m => m.runId === id && m.event === 'run_completed')
    if (completed) refetch()
  }, [messages, id, refetch])

  // Combine historical events (from DB) with live events (from WebSocket)
  const allEvents: WsMessage[] = useMemo(() => {
    const historical: WsMessage[] = (run?.events ?? []).map(e => ({
      type: 'event' as const,
      runId: id!,
      event: e.event,
      data: JSON.parse(e.data),
      timestamp: e.timestamp,
    }))
    const live = messages.filter(m => m.runId === id)

    // Deduplicate by timestamp+event
    const seen = new Set(historical.map(e => `${e.timestamp}:${e.event}`))
    const merged = [...historical]
    for (const evt of live) {
      const key = `${evt.timestamp}:${evt.event}`
      if (!seen.has(key)) {
        merged.push(evt)
        seen.add(key)
      }
    }
    return merged
  }, [run?.events, messages, id])

  // Derive live token count from events
  const liveTokenCount = useMemo(() => {
    for (let i = allEvents.length - 1; i >= 0; i--) {
      const evt = allEvents[i]
      if (evt.event === 'agent_turn_complete') {
        const count = evt.data.cumulativeTokens
        if (typeof count === 'number') return count
      }
      if (evt.event === 'token_warning' || evt.event === 'kill' || evt.event === 'run_completed') {
        const count = evt.data.tokenCount ?? evt.data.currentCount
        if (typeof count === 'number') return count
      }
    }
    return run?.token_count ?? 0
  }, [allEvents, run])

  const exitReason = run?.exit_reason ? JSON.parse(run.exit_reason) : null

  if (!run) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-200 flex items-center justify-center">
        Loading...
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <NavBar />

      {/* Run Header */}
      <div className="max-w-5xl mx-auto px-6 pt-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/" className="text-slate-500 hover:text-orange-300 text-sm">&larr; Back</Link>
          <div>
            <h1 className="text-lg font-bold tracking-tight font-mono text-orange-400">{run.id.slice(0, 8)}</h1>
            <p className="text-sm text-slate-500">{run.variant} / {run.agent}</p>
          </div>
        </div>
        <RunStatusBadge status={run.status} />
      </div>

      <div className="max-w-5xl mx-auto px-6 py-6 space-y-6">
        {/* Config Summary */}
        <div className="grid grid-cols-4 gap-4">
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
            <div className="text-xs text-slate-500 mb-1">Agent</div>
            <div className="font-medium">{run.agent}</div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
            <div className="text-xs text-slate-500 mb-1">Variant</div>
            <div className="font-medium">{run.variant}</div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
            <div className="text-xs text-slate-500 mb-1">Budget</div>
            <div className="font-medium font-mono">{run.budget.toLocaleString()}</div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
            <div className="text-xs text-slate-500 mb-1">TTL</div>
            <div className="font-medium font-mono">{run.ttl_seconds}s</div>
          </div>
        </div>

        {/* Token Progress */}
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
          <TokenProgressBar current={liveTokenCount} budget={run.budget} />
        </div>

        {/* Result (if completed) */}
        {exitReason && (
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
            <h2 className="text-sm font-semibold text-slate-300 mb-2">Result</h2>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <span className="text-slate-500">Exit Reason: </span>
                <span className="font-mono">{exitReason.type}</span>
              </div>
              <div>
                <span className="text-slate-500">Tokens: </span>
                <span className="font-mono">{run.token_count.toLocaleString()}</span>
              </div>
              <div>
                <span className="text-slate-500">Wall Time: </span>
                <span className="font-mono">
                  {run.wall_time_ms != null ? `${(run.wall_time_ms / 1000).toFixed(1)}s` : '—'}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Event Feed */}
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-slate-300 mb-3">Events</h2>
          <EventFeed events={allEvents} />
        </div>
      </div>
    </div>
  )
}
