import { useState } from 'react'

interface ApplyButtonProps {
  runId: string
  applied: boolean
  appliedMode?: string | null
  onApplied?: () => void
}

type ApplyMode = 'working-tree' | 'branch' | 'commit'

export default function ApplyButton({ runId, applied, appliedMode, onApplied }: ApplyButtonProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showDropdown, setShowDropdown] = useState(false)
  const [result, setResult] = useState<{ mode: string; branch?: string; commitHash?: string } | null>(null)

  if (applied || result) {
    const mode = result?.mode ?? appliedMode ?? 'working-tree'
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400 bg-emerald-950/50 border border-emerald-800/50 rounded px-2 py-1">
          Applied ({mode})
        </span>
        {result?.branch && (
          <span className="text-xs text-slate-400 font-mono">{result.branch}</span>
        )}
        {result?.commitHash && (
          <span className="text-xs text-slate-400 font-mono">{result.commitHash.slice(0, 8)}</span>
        )}
      </div>
    )
  }

  const handleApply = async (mode: ApplyMode) => {
    setShowDropdown(false)
    setLoading(true)
    setError(null)

    try {
      const body: Record<string, string> = { mode }
      if (mode === 'commit') {
        body.commitMessage = `crucible: apply run ${runId.slice(0, 8)}`
      }

      const res = await fetch(`/api/runs/${runId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Apply failed')
        return
      }

      setResult(data)
      onApplied?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Apply failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative inline-flex items-center gap-2">
      {/* Primary button */}
      <button
        onClick={() => handleApply('working-tree')}
        disabled={loading}
        className="bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white text-xs font-medium py-1.5 px-3 rounded-l transition-colors"
      >
        {loading ? 'Applying...' : 'Apply to working tree'}
      </button>

      {/* Dropdown trigger */}
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        disabled={loading}
        className="bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white text-xs font-medium py-1.5 px-2 rounded-r border-l border-orange-700 transition-colors"
      >
        <span className="text-[10px]">&#9660;</span>
      </button>

      {/* Dropdown menu */}
      {showDropdown && (
        <div className="absolute top-full right-0 mt-1 bg-slate-800 border border-slate-700 rounded-lg shadow-xl z-10 min-w-[180px]">
          <button
            onClick={() => handleApply('working-tree')}
            className="block w-full text-left px-3 py-2 text-xs text-slate-200 hover:bg-slate-700 rounded-t-lg"
          >
            Apply to working tree
          </button>
          <button
            onClick={() => handleApply('commit')}
            className="block w-full text-left px-3 py-2 text-xs text-slate-200 hover:bg-slate-700"
          >
            Apply &amp; commit
          </button>
          <button
            onClick={() => handleApply('branch')}
            className="block w-full text-left px-3 py-2 text-xs text-slate-200 hover:bg-slate-700 rounded-b-lg"
          >
            Apply to branch
          </button>
        </div>
      )}

      {error && (
        <span className="text-xs text-red-400 ml-2">{error}</span>
      )}
    </div>
  )
}
