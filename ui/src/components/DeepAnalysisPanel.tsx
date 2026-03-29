import { useState } from 'react'

export interface DeepCheck {
  heuristic: 'estimated_duration' | 'file_count' | 'change_entropy' | 'architectural_scope'
  value: string | number
  level: 'green' | 'amber' | 'red'
  detail: string
  evidence?: string
}

export interface CascadeResult {
  suggested: 'D0' | 'D4'
  reason: string
  flags: {
    humanReviewRecommended: boolean
    planningFirstSubtask: boolean
  }
}

interface DeepAnalysisState {
  status: 'ready' | 'loading' | 'results' | 'error'
  checks: DeepCheck[]
  strategy: CascadeResult | null
}

interface DeepAnalysisPanelProps {
  gatePassable: boolean
  description: string
  instructions: string
  seedDir?: string
  enrichments: Record<string, string>
  taskIntent: string
  onResults: (checks: DeepCheck[], strategy: CascadeResult | null) => void
}

const HEURISTIC_LABELS: Record<string, string> = {
  estimated_duration: 'Duration',
  file_count: 'Files',
  change_entropy: 'Entropy',
  architectural_scope: 'Scope',
}

const LEVEL_COLORS: Record<string, string> = {
  green: 'text-green-400',
  amber: 'text-amber-400',
  red: 'text-red-400',
}

export default function DeepAnalysisPanel({
  gatePassable,
  description,
  instructions,
  seedDir,
  enrichments,
  taskIntent,
  onResults,
}: DeepAnalysisPanelProps) {
  const [state, setState] = useState<DeepAnalysisState>({
    status: 'ready',
    checks: [],
    strategy: null,
  })

  // Reset to ready state (called by parent on edit)
  // Exposed via the state management pattern: parent clears by remounting or
  // we watch for prop changes and reset.
  // Actually: parent should reset us via key prop. Simpler.

  if (!gatePassable) return null

  const runDeepAnalysis = async () => {
    setState({ status: 'loading', checks: [], strategy: null })
    try {
      const res = await fetch('/api/readiness', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description,
          instructions: instructions || undefined,
          seedDir: seedDir || undefined,
          enrichments: Object.keys(enrichments).length > 0 ? enrichments : undefined,
          deep: true,
          taskIntent: taskIntent.toLowerCase(),
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const checks: DeepCheck[] = data.deepChecks ?? []
      const strategy: CascadeResult | null = data.strategy ?? null
      setState({ status: checks.length > 0 ? 'results' : 'error', checks, strategy })
      onResults(checks, strategy)
    } catch {
      setState({ status: 'error', checks: [], strategy: null })
      onResults([], null)
    }
  }

  return (
    <div className="px-4 py-3 border-t border-slate-800">
      {/* Section header */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-slate-500 uppercase tracking-wider">Deep Analysis</span>
        {state.status === 'ready' && (
          <button
            type="button"
            onClick={runDeepAnalysis}
            className="px-3 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs font-medium rounded transition-colors"
          >
            Run Deep Analysis &#9654;
          </button>
        )}
        {state.status === 'loading' && (
          <span className="flex items-center gap-1.5 text-xs text-slate-400">
            <span className="w-3 h-3 border-2 border-slate-500 border-t-orange-400 rounded-full animate-spin" />
            Analyzing...
          </span>
        )}
      </div>

      {/* Ready state description */}
      {state.status === 'ready' && (
        <p className="text-xs text-slate-500">Estimate task scope and suggest a strategy.</p>
      )}

      {/* Error state */}
      {state.status === 'error' && (
        <p className="text-xs text-slate-500">Analysis unavailable. You can proceed normally.</p>
      )}

      {/* Results */}
      {state.status === 'results' && state.checks.length > 0 && (
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {state.checks.map(check => (
            <span key={check.heuristic} className="text-xs text-slate-400 flex items-center gap-1.5">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                check.level === 'green' ? 'bg-green-400' :
                check.level === 'amber' ? 'bg-amber-400' : 'bg-red-400'
              }`} />
              <span className="text-slate-500">{HEURISTIC_LABELS[check.heuristic]}:</span>
              <span className={LEVEL_COLORS[check.level]}>{check.detail}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
