const statusColors: Record<string, string> = {
  running: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  completed: 'bg-green-500/20 text-green-400 border-green-500/30',
  killed: 'bg-red-500/20 text-red-400 border-red-500/30',
  error: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
}

export default function RunStatusBadge({ status }: { status: string }) {
  const color = statusColors[status] ?? 'bg-gray-500/20 text-gray-400 border-gray-500/30'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${color}`}>
      {status === 'running' && (
        <span className="w-1.5 h-1.5 bg-orange-400 rounded-full mr-1.5 animate-pulse" />
      )}
      {status}
    </span>
  )
}
