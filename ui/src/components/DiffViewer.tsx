import { useState } from 'react'

interface DiffViewerProps {
  patch: string
}

export default function DiffViewer({ patch }: DiffViewerProps) {
  const [expanded, setExpanded] = useState(false)

  if (!patch) return null

  const lines = patch.split('\n')

  return (
    <div className="mt-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-xs text-orange-400 hover:text-orange-300 transition-colors"
      >
        {expanded ? 'Hide full diff' : 'View full diff'}
      </button>

      {expanded && (
        <pre className="mt-2 bg-slate-950 border border-slate-800 rounded-lg p-4 text-xs font-mono overflow-x-auto max-h-[600px] overflow-y-auto">
          {lines.map((line, i) => (
            <div key={i} className={lineClass(line)}>
              {line}
            </div>
          ))}
        </pre>
      )}
    </div>
  )
}

function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) {
    return 'text-slate-500'
  }
  if (line.startsWith('+')) {
    return 'text-emerald-400 bg-emerald-950/30'
  }
  if (line.startsWith('-')) {
    return 'text-red-400 bg-red-950/30'
  }
  if (line.startsWith('@@')) {
    return 'text-blue-400'
  }
  if (line.startsWith('diff --git')) {
    return 'text-slate-400 font-bold mt-2'
  }
  return 'text-slate-400'
}
