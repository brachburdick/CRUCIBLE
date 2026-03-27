const statusColors: Record<string, string> = {
  pending:     'bg-slate-500/20 text-slate-400 border-slate-500/30',
  in_progress: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  complete:    'bg-green-500/20 text-green-400 border-green-500/30',
  blocked:     'bg-orange-500/20 text-orange-400 border-orange-500/30',
  skipped:     'bg-slate-500/20 text-slate-500 border-slate-500/30',
  ready:       'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
  active:      'bg-amber-500/20 text-amber-400 border-amber-500/30',
  completed:   'bg-green-500/20 text-green-400 border-green-500/30',
  failed:      'bg-red-500/20 text-red-400 border-red-500/30',
}

const priorityColors: Record<string, string> = {
  critical: 'text-red-400',
  high:     'text-orange-400',
  medium:   'text-yellow-400',
  low:      'text-slate-400',
}

export function TaskStatusBadge({ status }: { status: string }) {
  const colors = statusColors[status] ?? 'bg-slate-500/20 text-slate-400 border-slate-500/30'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${colors}`}>
      {status === 'in_progress' && (
        <span className="w-1.5 h-1.5 rounded-full bg-orange-400 mr-1.5 animate-pulse" />
      )}
      {status}
    </span>
  )
}

export function PriorityBadge({ priority }: { priority: string }) {
  const color = priorityColors[priority] ?? 'text-slate-400'
  return <span className={`text-xs font-medium ${color}`}>{priority}</span>
}

export function RiskBadge({ risk }: { risk: string }) {
  const colors: Record<string, string> = {
    high: 'text-red-400', medium: 'text-yellow-400', low: 'text-green-400',
  }
  return <span className={`text-xs ${colors[risk] ?? 'text-slate-400'}`}>{risk}</span>
}
