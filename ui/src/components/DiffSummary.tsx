interface DiffFile {
  path: string
  insertions: number
  deletions: number
  status: string
}

interface DiffSummaryProps {
  filesChanged: number
  insertions: number
  deletions: number
  files: DiffFile[]
}

export default function DiffSummary({ filesChanged, insertions, deletions, files }: DiffSummaryProps) {
  return (
    <div>
      <div className="text-sm text-slate-300 mb-3">
        <span className="font-medium">{filesChanged} file{filesChanged !== 1 ? 's' : ''} changed</span>
        <span className="text-emerald-400 ml-2">+{insertions}</span>
        <span className="text-red-400 ml-2">-{deletions}</span>
      </div>

      <div className="space-y-1">
        {files.map((file) => (
          <div key={file.path} className="flex items-center justify-between text-xs font-mono">
            <div className="flex items-center gap-2 text-slate-300 min-w-0">
              {file.status === 'added' && (
                <span className="text-emerald-400 text-[10px] font-sans font-medium uppercase tracking-wider">new</span>
              )}
              {file.status === 'deleted' && (
                <span className="text-red-400 text-[10px] font-sans font-medium uppercase tracking-wider">del</span>
              )}
              <span className="truncate">{file.path}</span>
            </div>
            <div className="flex items-center gap-2 ml-4 shrink-0">
              <span className="text-emerald-400">+{file.insertions}</span>
              <span className="text-red-400">-{file.deletions}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
