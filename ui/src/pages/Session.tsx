import { useState } from 'react'
import { useFetch } from '../hooks/useApi'
import NavBar from '../components/NavBar'
import QuestionForm from '../components/QuestionForm'
import { TaskStatusBadge, PriorityBadge, RiskBadge } from '../components/TaskStatusBadge'

type Tab = 'questions' | 'run-history' | 'snapshot' | 'tasks' | 'metrics'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'questions', label: 'Questions' },
  { id: 'run-history', label: 'Run History' },
  { id: 'snapshot', label: 'State Snapshot' },
  { id: 'tasks', label: 'Task Queue' },
  { id: 'metrics', label: 'Metrics' },
]

// ─── Types ─────────────────────────────────────────────────────────────

interface Question {
  id: string; task: string; question: string; options: string[]
  default: string; impact: string; status: string
  asked: string; answered: string | null; answer: string | null
}

interface RunRecord {
  runId: string; date: string; projectId: string; taskId: string
  taskType: string; result: string; summary: string
  filesTouched: string[]; humanTouches: { total: number }
}

interface StateSnapshot {
  sessionId: string; timestamp: string; branch: string; lastCommit: string
  activeTasks: string[]; modifiedFiles: string[]
  sessionKnowledge: {
    decisions: Array<{ timestamp: string; nodeId: string | null; decision: string; rationale: string }>
    keyLocations: Array<{ path: string; description: string }>
    deadEnds: Array<{ approach: string; reason: string }>
    openQuestions: string[]
  }
  sessionFriction: {
    mutationsSinceTest: number; totalMutations: number
    testCycles: number; uniqueFilesModified: string[]
  }
}

interface Task {
  id: string; description?: string; summary?: string; taskType?: string; status: string
  priority?: string; riskLevel?: string; blockedBy?: string[]; blockers?: string[]
}

// ─── Result Badges ─────────────────────────────────────────────────────

function ResultBadge({ result }: { result: string }) {
  const colors: Record<string, string> = {
    success:   'bg-green-500/20 text-green-400 border-green-500/30',
    partial:   'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    failed:    'bg-red-500/20 text-red-400 border-red-500/30',
    escalated: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  }
  const c = colors[result] ?? 'bg-slate-500/20 text-slate-400 border-slate-500/30'
  return <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium border ${c}`}>{result}</span>
}

// ─── Tab: Questions ────────────────────────────────────────────────────

function QuestionsTab() {
  const { data: questions, refetch } = useFetch<Question[]>('/api/session/questions')

  if (!questions) return <p className="text-slate-500 text-sm">Loading...</p>

  const pending = questions.filter(q => q.status === 'pending')
  const answered = questions.filter(q => q.status === 'answered')

  return (
    <div className="space-y-4">
      {pending.length > 0 ? (
        <>
          <h3 className="text-sm font-semibold text-slate-300">
            Pending ({pending.length})
          </h3>
          {pending.map(q => (
            <QuestionForm key={q.id} question={q} onAnswered={refetch} />
          ))}
        </>
      ) : (
        <p className="text-sm text-slate-500">No pending questions.</p>
      )}

      {answered.length > 0 && (
        <>
          <h3 className="text-sm font-semibold text-slate-400 mt-6">
            Answered ({answered.length})
          </h3>
          <div className="space-y-2">
            {answered.map(q => (
              <div key={q.id} className="bg-slate-800/30 rounded p-3 text-sm">
                <p className="text-slate-400">{q.question}</p>
                <p className="text-slate-300 mt-1">Answer: <strong>{q.answer}</strong></p>
                <p className="text-xs text-slate-500 mt-1">
                  Answered {q.answered ? new Date(q.answered).toLocaleString() : ''}
                </p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ─── Tab: Run History ──────────────────────────────────────────────────

function RunHistoryTab() {
  const { data: records } = useFetch<RunRecord[]>('/api/session/run-records?last=50')

  if (!records) return <p className="text-slate-500 text-sm">Loading...</p>
  if (records.length === 0) return <p className="text-sm text-slate-500">No run records yet.</p>

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-slate-800 text-slate-400 text-left">
          <th className="px-3 py-2 font-medium">Date</th>
          <th className="px-3 py-2 font-medium">Task</th>
          <th className="px-3 py-2 font-medium">Type</th>
          <th className="px-3 py-2 font-medium">Result</th>
          <th className="px-3 py-2 font-medium">Summary</th>
          <th className="px-3 py-2 font-medium text-right">Files</th>
        </tr>
      </thead>
      <tbody>
        {records.map(r => (
          <tr key={r.runId} className="border-b border-slate-800/50 hover:bg-slate-800/30">
            <td className="px-3 py-2 text-xs text-slate-500">
              {new Date(r.date).toLocaleString()}
            </td>
            <td className="px-3 py-2 font-mono text-xs text-slate-300">{r.taskId}</td>
            <td className="px-3 py-2 text-slate-400">{r.taskType}</td>
            <td className="px-3 py-2"><ResultBadge result={r.result} /></td>
            <td className="px-3 py-2 text-slate-400 max-w-xs truncate">{r.summary}</td>
            <td className="px-3 py-2 text-right text-slate-500">{r.filesTouched?.length ?? 0}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ─── Tab: State Snapshot ───────────────────────────────────────────────

function SnapshotTab() {
  const { data: snapshot } = useFetch<StateSnapshot>('/api/session/snapshot')

  if (!snapshot) return <p className="text-slate-500 text-sm">Loading...</p>

  const { sessionKnowledge: k, sessionFriction: f } = snapshot

  return (
    <div className="space-y-6">
      {/* Friction Summary */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: 'Mutations Since Test', value: f.mutationsSinceTest },
          { label: 'Total Mutations', value: f.totalMutations },
          { label: 'Test Cycles', value: f.testCycles },
          { label: 'Unique Files', value: f.uniqueFilesModified.length },
        ].map(s => (
          <div key={s.label} className="bg-slate-800/50 rounded-lg p-3">
            <p className="text-xs text-slate-500">{s.label}</p>
            <p className="text-xl font-bold text-slate-200">{s.value}</p>
          </div>
        ))}
      </div>

      {/* Decisions */}
      {k.decisions.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-300 mb-2">Decisions ({k.decisions.length})</h3>
          <div className="space-y-2">
            {k.decisions.map((d, i) => (
              <div key={i} className="bg-slate-800/30 rounded p-3 text-sm">
                <p className="text-slate-200">{d.decision}</p>
                <p className="text-xs text-slate-500 mt-1">{d.rationale}</p>
                <p className="text-xs text-slate-600 mt-1">
                  {d.nodeId && `Node: ${d.nodeId} · `}
                  {new Date(d.timestamp).toLocaleString()}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Key Locations */}
      {k.keyLocations.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-300 mb-2">Key Locations ({k.keyLocations.length})</h3>
          <table className="w-full text-sm">
            <tbody>
              {k.keyLocations.map((l, i) => (
                <tr key={i} className="border-b border-slate-800/50">
                  <td className="px-3 py-2 font-mono text-xs text-orange-400">{l.path}</td>
                  <td className="px-3 py-2 text-slate-400">{l.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Dead Ends */}
      {k.deadEnds.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-300 mb-2">Dead Ends ({k.deadEnds.length})</h3>
          <div className="space-y-2">
            {k.deadEnds.map((d, i) => (
              <div key={i} className="bg-red-500/5 border border-red-500/20 rounded p-3 text-sm">
                <p className="text-slate-200">{d.approach}</p>
                <p className="text-xs text-slate-500 mt-1">{d.reason}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Info */}
      <div className="text-xs text-slate-600">
        Session: {snapshot.sessionId.slice(0, 8)} · Branch: {snapshot.branch || '—'} ·
        Last updated: {new Date(snapshot.timestamp).toLocaleString()}
      </div>
    </div>
  )
}

// ─── Tab: Task Queue ───────────────────────────────────────────────────

function TaskQueueTab() {
  const { data: tasks } = useFetch<Task[]>('/api/session/tasks')
  const [filter, setFilter] = useState<string>('all')

  if (!tasks) return <p className="text-slate-500 text-sm">Loading...</p>
  if (tasks.length === 0) return <p className="text-sm text-slate-500">No tasks in queue.</p>

  const filtered = filter === 'all' ? tasks : tasks.filter(t => t.status === filter)

  return (
    <div>
      {/* Filter bar */}
      <div className="flex gap-2 mb-4">
        {['all', 'pending', 'in_progress', 'complete', 'blocked'].map(s => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
              filter === s
                ? 'bg-slate-700 text-slate-200'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {s === 'all' ? 'All' : s.replace('_', ' ')}
          </button>
        ))}
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-800 text-slate-400 text-left">
            <th className="px-3 py-2 font-medium">ID</th>
            <th className="px-3 py-2 font-medium">Description</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Priority</th>
            <th className="px-3 py-2 font-medium">Risk</th>
            <th className="px-3 py-2 font-medium">Blocked By</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map(t => {
            const desc = t.description ?? t.summary ?? t.id
            const deps = t.blockedBy ?? t.blockers ?? []
            return (
              <tr key={t.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                <td className="px-3 py-2 font-mono text-xs text-orange-400">{t.id}</td>
                <td className="px-3 py-2 text-slate-300 max-w-sm truncate">{desc}</td>
                <td className="px-3 py-2 text-slate-400">{t.taskType ?? '—'}</td>
                <td className="px-3 py-2"><TaskStatusBadge status={t.status} /></td>
                <td className="px-3 py-2">{t.priority ? <PriorityBadge priority={t.priority} /> : <span className="text-slate-600">—</span>}</td>
                <td className="px-3 py-2">{t.riskLevel ? <RiskBadge risk={t.riskLevel} /> : <span className="text-slate-600">—</span>}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-500">
                  {deps.length > 0 ? deps.join(', ') : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Tab: Metrics ─────────────────────────────────────────────────────

interface SessionMetrics {
  session_id: string
  project: string
  title: string
  first_timestamp: string
  total_input_tokens: number
  total_output_tokens: number
  total_cache_read: number
  total_cache_creation: number
  peak_context: number
  peak_context_pct: number
  turn_count: number
  mtime: number
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function TokenBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-slate-400">{label}</span>
        <span className="text-slate-300 font-mono">{formatTokens(value)}</span>
      </div>
      <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function ContextGauge({ pct }: { pct: number }) {
  const clampedPct = Math.min(pct, 100)
  const color = clampedPct > 80 ? 'text-red-400' : clampedPct > 50 ? 'text-yellow-400' : 'text-green-400'
  const barColor = clampedPct > 80 ? 'bg-red-500' : clampedPct > 50 ? 'bg-yellow-500' : 'bg-green-500'
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-slate-400">Peak Context</span>
        <span className={`font-mono font-bold ${color}`}>{clampedPct.toFixed(1)}%</span>
      </div>
      <div className="h-3 bg-slate-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${clampedPct}%` }} />
      </div>
    </div>
  )
}

function SessionCard({ s, isCurrent }: { s: SessionMetrics; isCurrent: boolean }) {
  const totalTokens = s.total_input_tokens + s.total_output_tokens + s.total_cache_read + s.total_cache_creation
  const maxBar = Math.max(s.total_input_tokens, s.total_output_tokens, s.total_cache_read, s.total_cache_creation, 1)

  return (
    <div className={`rounded-lg p-4 space-y-3 ${
      isCurrent ? 'bg-orange-500/10 border border-orange-500/30' : 'bg-slate-800/40 border border-slate-800'
    }`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {isCurrent && (
              <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold bg-orange-500/20 text-orange-400 border border-orange-500/30">
                CURRENT
              </span>
            )}
            <p className="text-sm text-slate-200 truncate">{s.title}</p>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            {s.first_timestamp ? new Date(s.first_timestamp).toLocaleString() : '—'}
            {' · '}{s.turn_count} turns
            {' · '}{formatTokens(totalTokens)} total tokens
          </p>
        </div>
        <span className="text-xs text-slate-600 font-mono shrink-0">{s.session_id.slice(0, 8)}</span>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-2">
        <TokenBar label="Input Tokens" value={s.total_input_tokens} max={maxBar} color="bg-blue-500" />
        <TokenBar label="Output Tokens" value={s.total_output_tokens} max={maxBar} color="bg-purple-500" />
        <TokenBar label="Cache Read" value={s.total_cache_read} max={maxBar} color="bg-cyan-500" />
        <TokenBar label="Cache Creation" value={s.total_cache_creation} max={maxBar} color="bg-teal-500" />
      </div>

      <ContextGauge pct={s.peak_context_pct} />
    </div>
  )
}

function MetricsTab() {
  const { data: sessions, loading, error } = useFetch<SessionMetrics[]>('/api/sessions/metrics?limit=20')
  const [showAll, setShowAll] = useState(false)

  if (loading) return <p className="text-slate-500 text-sm">Loading metrics...</p>
  if (error) return <p className="text-red-400 text-sm">Error loading metrics: {error}</p>
  if (!sessions || sessions.length === 0) return <p className="text-sm text-slate-500">No session transcripts found.</p>

  const current = sessions[0]
  const rest = sessions.slice(1)
  const visible = showAll ? rest : rest.slice(0, 4)

  return (
    <div className="space-y-6">
      {/* Aggregate summary */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: 'Sessions', value: sessions.length },
          { label: 'Total Turns', value: sessions.reduce((a, s) => a + s.turn_count, 0) },
          { label: 'Total Output', value: formatTokens(sessions.reduce((a, s) => a + s.total_output_tokens, 0)) },
          { label: 'Avg Peak Context', value: `${(sessions.reduce((a, s) => a + s.peak_context_pct, 0) / sessions.length).toFixed(1)}%` },
        ].map(s => (
          <div key={s.label} className="bg-slate-800/50 rounded-lg p-3">
            <p className="text-xs text-slate-500">{s.label}</p>
            <p className="text-xl font-bold text-slate-200">{s.value}</p>
          </div>
        ))}
      </div>

      {/* Current session */}
      <div>
        <h3 className="text-sm font-semibold text-slate-300 mb-2">Current Session</h3>
        <SessionCard s={current} isCurrent={true} />
      </div>

      {/* Recent sessions */}
      {rest.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-slate-400">Recent Sessions ({rest.length})</h3>
            {rest.length > 4 && (
              <button
                onClick={() => setShowAll(!showAll)}
                className="text-xs text-orange-400 hover:text-orange-300"
              >
                {showAll ? 'Show less' : `Show all ${rest.length}`}
              </button>
            )}
          </div>
          <div className="space-y-3">
            {visible.map(s => (
              <SessionCard key={s.session_id} s={s} isCurrent={false} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Main Page ─────────────────────────────────────────────────────────

export default function Session() {
  const [activeTab, setActiveTab] = useState<Tab>('questions')

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <NavBar />

      <div className="max-w-6xl mx-auto px-6 py-6">
        {/* Tab Bar */}
        <div className="flex gap-1 border-b border-slate-800 mb-6">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-orange-500 text-orange-400'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-6">
          {activeTab === 'questions' && <QuestionsTab />}
          {activeTab === 'run-history' && <RunHistoryTab />}
          {activeTab === 'snapshot' && <SnapshotTab />}
          {activeTab === 'tasks' && <TaskQueueTab />}
          {activeTab === 'metrics' && <MetricsTab />}
        </div>
      </div>
    </div>
  )
}
