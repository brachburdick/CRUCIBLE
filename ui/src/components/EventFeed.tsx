import { useEffect, useRef } from 'react'
import type { WsMessage } from '../hooks/useWebSocket'

const eventStyles: Record<string, string> = {
  run_started: 'text-orange-400',
  sandbox_created: 'text-orange-300',
  token_warning: 'text-yellow-400',
  loop_warning: 'text-orange-400',
  agent_thinking: 'text-blue-300',
  agent_tool_call: 'text-cyan-400',
  agent_tool_result: 'text-purple-400',
  agent_turn_complete: 'text-slate-500',
  agent_completed: 'text-green-400',
  kill: 'text-red-400',
  run_completed: 'text-slate-300',
  error: 'text-red-500',
  teardown_step_failed: 'text-red-500',
  flow_detected: 'text-slate-400',
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
    case 'agent_thinking': {
      const txt = String(data.content ?? '')
      const usage = data.usage as { promptTokens?: number; completionTokens?: number } | undefined
      const tokens = usage ? ` [${Number(usage.promptTokens ?? 0).toLocaleString()}→${Number(usage.completionTokens ?? 0).toLocaleString()}]` : ''
      return `Turn ${data.turn}: ${txt.length > 120 ? txt.slice(0, 120) + '...' : txt}${tokens}`
    }
    case 'agent_tool_call': {
      const input = data.toolInput as Record<string, unknown> | undefined
      let summary = ''
      if (data.toolName === 'read_file') summary = String(input?.path ?? '')
      else if (data.toolName === 'write_file') summary = String(input?.path ?? '')
      else if (data.toolName === 'exec') summary = String(input?.command ?? '').slice(0, 80)
      else if (data.toolName === 'task_complete') summary = String(input?.summary ?? '').slice(0, 80)
      else summary = JSON.stringify(input ?? {}).slice(0, 80)
      return `Turn ${data.turn}: ${data.toolName}(${summary})`
    }
    case 'agent_tool_result': {
      const res = String(data.content ?? '').slice(0, 80)
      const status = data.isError ? 'ERROR' : 'ok'
      return `Turn ${data.turn}: ${data.toolName} → ${status} ${res}`
    }
    case 'agent_turn_complete':
      return `Turn ${data.turn} complete — ${Number(data.cumulativeTokens).toLocaleString()} tokens`
    case 'flow_detected':
      return `${data.flowType} flow — phases: ${(data.phases as string[])?.join(', ') ?? ''}`
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
