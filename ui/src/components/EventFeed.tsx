import { useEffect, useRef } from 'react'
import type { WsMessage } from '../hooks/useWebSocket'

const eventStyles: Record<string, string> = {
  run_started: 'text-blue-400',
  sandbox_created: 'text-blue-300',
  token_warning: 'text-yellow-400',
  loop_warning: 'text-orange-400',
  agent_completed: 'text-green-400',
  kill: 'text-red-400',
  run_completed: 'text-slate-300',
  error: 'text-red-500',
  teardown_step_failed: 'text-red-500',
}

function formatEventData(event: string, data: Record<string, unknown>): string {
  switch (event) {
    case 'run_started':
      return `variant=${data.variant} agent=${data.agent} budget=${data.budget} ttl=${data.ttlSeconds}s`
    case 'token_warning':
      return `${data.threshold} — ${Number(data.currentCount).toLocaleString()}/${Number(data.budget).toLocaleString()} tokens`
    case 'loop_warning':
      return `similarity=${Number(data.meanSimilarity).toFixed(4)} consecutive=${data.consecutiveCount}`
    case 'agent_completed': {
      const msg = String(data.finalMessage ?? '')
      return msg.length > 120 ? msg.slice(0, 120) + '...' : msg
    }
    case 'kill': {
      const reason = data.killReason as Record<string, unknown> | undefined
      return `${reason?.type ?? 'unknown'} — ${Number(data.tokenCount).toLocaleString()} tokens, ${(Number(data.wallTimeMs) / 1000).toFixed(1)}s`
    }
    case 'run_completed': {
      const exitReason = data.exitReason as Record<string, unknown> | undefined
      return `exit=${exitReason?.type ?? 'unknown'} tokens=${Number(data.tokenCount).toLocaleString()} wall=${(Number(data.wallTimeMs) / 1000).toFixed(1)}s`
    }
    case 'error':
      return String(data.error ?? '')
    default:
      return JSON.stringify(data)
  }
}

export default function EventFeed({ events }: { events: WsMessage[] }) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [events.length])

  if (events.length === 0) {
    return (
      <div className="text-slate-500 text-sm py-8 text-center">
        Waiting for events...
      </div>
    )
  }

  return (
    <div className="space-y-1 font-mono text-xs overflow-y-auto max-h-[500px]">
      {events.map((evt, i) => (
        <div key={i} className="flex gap-3 py-1 px-2 rounded hover:bg-slate-800/50">
          <span className="text-slate-500 shrink-0">
            {new Date(evt.timestamp).toLocaleTimeString()}
          </span>
          <span className={`shrink-0 font-semibold ${eventStyles[evt.event] ?? 'text-slate-400'}`}>
            {evt.event}
          </span>
          <span className="text-slate-400 truncate">
            {formatEventData(evt.event, evt.data)}
          </span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
