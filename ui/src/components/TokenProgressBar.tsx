export default function TokenProgressBar({ current, budget }: { current: number; budget: number }) {
  const pct = budget > 0 ? Math.min((current / budget) * 100, 100) : 0
  const color = pct >= 80 ? 'bg-red-500' : pct >= 50 ? 'bg-yellow-500' : 'bg-blue-500'

  return (
    <div className="w-full">
      <div className="flex justify-between text-xs text-slate-400 mb-1">
        <span>{current.toLocaleString()} tokens</span>
        <span>{budget.toLocaleString()} budget</span>
      </div>
      <div className="w-full bg-slate-700 rounded-full h-2">
        <div
          className={`${color} h-2 rounded-full transition-all duration-300`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
