import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useFetch } from '../hooks/useApi'
import NavBar from '../components/NavBar'
import { TaskStatusBadge, PriorityBadge } from '../components/TaskStatusBadge'

// ─── Types ─────────────────────────────────────────────────────────────

interface ProjectInfo {
  name: string
  displayName: string
  path: string
  hasClaudeMd: boolean
  taskCount: number
  pendingTaskCount: number
  pendingQuestionCount: number
  isGroup: boolean
  children: ProjectInfo[]
}

interface ProjectTask {
  project: string
  projectPath: string
  id: string
  description?: string
  summary?: string
  taskType?: string
  status: string
  priority?: string
  riskLevel?: string
  blockedBy?: string[]
  flowPhase?: string
  layer?: 'pipeline' | 'meta-project' | 'project'
}

interface ProjectQuestion {
  project: string
  id: string
  task: string
  question: string
  options: string[]
  status: string
  default?: string
  impact?: string
}

type Tab = 'overview' | 'all-tasks' | 'questions'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Projects' },
  { id: 'all-tasks', label: 'All Tasks' },
  { id: 'questions', label: 'Pending Questions' },
]

// ─── Project Row (recursive) ───────────────────────────────────────────

function ProjectRow({ project, depth = 0 }: { project: ProjectInfo; depth?: number }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <>
      <div
        className="border border-slate-800 rounded-lg overflow-hidden"
        style={{ marginLeft: depth * 16 }}
      >
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full px-4 py-3 flex items-center justify-between hover:bg-slate-800/30 transition-colors text-left"
        >
          <div className="flex items-center gap-3">
            {project.isGroup && (
              <span className="text-xs text-slate-600 w-4">{expanded ? '▼' : '▶'}</span>
            )}
            {!project.isGroup && <span className="w-4" />}
            <span className={`text-sm font-semibold ${project.isGroup ? 'text-slate-300' : 'text-orange-400'}`}>
              {project.name}
            </span>
            {project.isGroup && (
              <span className="text-xs text-slate-600 border border-slate-700 rounded px-1.5 py-0.5">
                group
              </span>
            )}
            {project.hasClaudeMd && (
              <span className="text-xs text-slate-500 border border-slate-700 rounded px-1.5 py-0.5">
                CLAUDE.md
              </span>
            )}
          </div>
          <div className="flex items-center gap-4 text-xs">
            {project.pendingQuestionCount > 0 && (
              <span className="text-yellow-400">{project.pendingQuestionCount} questions</span>
            )}
            <span className="text-slate-400">
              {project.pendingTaskCount} active / {project.taskCount} total
            </span>
          </div>
        </button>

        {/* Expanded content */}
        {expanded && !project.isGroup && (
          <ProjectTaskList
            projectName={project.displayName}
            projectPath={project.path}
          />
        )}
      </div>

      {/* Render children (for groups) */}
      {expanded && project.isGroup && (
        <div className="mt-1 space-y-1">
          {project.children.map(child => (
            <ProjectRow key={child.displayName} project={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </>
  )
}

// ─── Overview Tab ──────────────────────────────────────────────────────

function OverviewTab() {
  const { data: projects } = useFetch<ProjectInfo[]>('/api/projects')

  if (!projects) return <p className="text-slate-500 text-sm">Loading projects...</p>

  return (
    <div className="space-y-2">
      {projects.map(p => (
        <ProjectRow key={p.displayName} project={p} />
      ))}
    </div>
  )
}

// ─── Task List for a single project ────────────────────────────────────

function ProjectTaskList({ projectName, projectPath }: { projectName: string; projectPath: string }) {
  const navigate = useNavigate()
  const { data: tasks } = useFetch<Record<string, unknown>[]>(`/api/projects/tasks-for/${projectName}`)

  if (!tasks) return <div className="px-4 py-2 text-slate-500 text-sm">Loading...</div>
  if (tasks.length === 0) return <div className="px-4 py-2 text-slate-500 text-sm">No tasks.</div>

  const handleRun = async (task: Record<string, unknown>) => {
    // Fetch project CLAUDE.md for system prompt
    let systemPrompt = ''
    try {
      const res = await fetch(`/api/projects/context/${projectName}`)
      if (res.ok) {
        const data = await res.json()
        systemPrompt = data.claudeMd ?? ''
      }
    } catch { /* no context available */ }

    const desc = (task.description ?? task.summary ?? task.id) as string

    navigate('/', {
      state: {
        preFill: {
          projectName,
          description: desc,
          instructions: desc,
          seedDir: projectPath,
          systemPrompt,
          variant: `${projectName}-${task.id as string}`,
          agent: 'coder',
        },
      },
    })
  }

  return (
    <div className="border-t border-slate-800">
      <table className="w-full text-sm">
        <tbody>
          {tasks.map(t => (
            <tr key={t.id as string} className="border-b border-slate-800/30 hover:bg-slate-800/20">
              <td className="px-4 py-2 font-mono text-xs text-slate-400 w-24">{t.id as string}</td>
              <td className="px-4 py-2 text-slate-300 max-w-md truncate">
                {(t.description ?? t.summary ?? '') as string}
              </td>
              <td className="px-4 py-2 w-24">
                <TaskStatusBadge status={t.status as string} />
              </td>
              <td className="px-4 py-2 w-20 text-xs text-slate-500">{(t.flowPhase ?? '') as string}</td>
              <td className="px-4 py-2 w-16 text-right">
                {((t.status as string) === 'pending' || (t.status as string) === 'in_progress') && (
                  <button
                    onClick={() => handleRun(t)}
                    className="text-xs text-orange-400 hover:text-orange-300 font-medium"
                  >
                    Run →
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Layer Badge ───────────────────────────────────────────────────────

type LayerValue = 'pipeline' | 'meta-project' | 'project'

const LAYER_STYLES: Record<LayerValue, string> = {
  pipeline:      'bg-slate-500/20 text-slate-400 border-slate-500/30',
  'meta-project': 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  project:       'bg-green-500/20 text-green-400 border-green-500/30',
}

function LayerBadge({ layer }: { layer?: LayerValue }) {
  const l = layer ?? 'project'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${LAYER_STYLES[l]}`}>
      {l}
    </span>
  )
}

// ─── All Tasks Tab ─────────────────────────────────────────────────────

function AllTasksTab() {
  const [filter, setFilter] = useState('pending')
  const [layerFilter, setLayerFilter] = useState<Set<LayerValue>>(new Set(['meta-project', 'project']))
  const { data: tasks } = useFetch<ProjectTask[]>(`/api/projects/tasks?status=${filter}`, [filter])

  function toggleLayer(layer: LayerValue) {
    setLayerFilter(prev => {
      const next = new Set(prev)
      next.has(layer) ? next.delete(layer) : next.add(layer)
      return next
    })
  }

  const visibleTasks = tasks?.filter(t => layerFilter.has((t.layer ?? 'project') as LayerValue))

  return (
    <div>
      {/* Layer filter */}
      <div className="flex gap-2 mb-3">
        {(['pipeline', 'meta-project', 'project'] as LayerValue[]).map(l => (
          <button
            key={l}
            onClick={() => toggleLayer(l)}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors border ${
              layerFilter.has(l)
                ? LAYER_STYLES[l]
                : 'text-slate-600 border-slate-700 hover:text-slate-400'
            }`}
          >
            {l}
          </button>
        ))}
      </div>

      {/* Status filter */}
      <div className="flex gap-2 mb-4">
        {['pending', 'in_progress', 'complete', 'blocked'].map(s => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
              filter === s
                ? 'bg-orange-500/10 text-orange-400 border border-orange-500/20'
                : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {s.replace('_', ' ')}
          </button>
        ))}
      </div>

      {!tasks ? (
        <p className="text-slate-500 text-sm">Loading...</p>
      ) : !visibleTasks || visibleTasks.length === 0 ? (
        <p className="text-slate-500 text-sm">No {filter.replace('_', ' ')} tasks in selected layers.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-slate-400 text-left">
              <th className="px-3 py-2 font-medium">Project</th>
              <th className="px-3 py-2 font-medium">ID</th>
              <th className="px-3 py-2 font-medium">Description</th>
              <th className="px-3 py-2 font-medium">Layer</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Priority</th>
              <th className="px-3 py-2 font-medium">Phase</th>
            </tr>
          </thead>
          <tbody>
            {visibleTasks.map(t => (
              <tr key={`${t.project}-${t.id}`} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                <td className="px-3 py-2 text-orange-400 text-xs font-medium">{t.project}</td>
                <td className="px-3 py-2 font-mono text-xs text-slate-400">{t.id}</td>
                <td className="px-3 py-2 text-slate-300 max-w-sm truncate">{t.description ?? t.summary}</td>
                <td className="px-3 py-2"><LayerBadge layer={t.layer} /></td>
                <td className="px-3 py-2 text-slate-500 text-xs">{t.taskType}</td>
                <td className="px-3 py-2">{t.priority && <PriorityBadge priority={t.priority} />}</td>
                <td className="px-3 py-2 text-slate-500 text-xs">{t.flowPhase}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ─── Questions Tab ─────────────────────────────────────────────────────

function QuestionsTab() {
  const { data: questions } = useFetch<ProjectQuestion[]>('/api/projects/questions')

  if (!questions) return <p className="text-slate-500 text-sm">Loading...</p>
  if (questions.length === 0) return <p className="text-slate-500 text-sm">No pending questions across any project.</p>

  return (
    <div className="space-y-3">
      {questions.map(q => (
        <div key={`${q.project}-${q.id}`} className="bg-slate-800/50 border border-slate-700 rounded-lg p-4">
          <div className="flex items-start justify-between mb-2">
            <p className="text-sm font-medium text-slate-200">{q.question}</p>
            <span className="text-xs text-orange-400 ml-2 whitespace-nowrap">{q.project}</span>
          </div>
          <p className="text-xs text-slate-500 mb-2">Task: {q.task} · Impact: {q.impact ?? '—'}</p>
          <div className="flex gap-2 flex-wrap">
            {q.options.map(opt => (
              <span key={opt} className="text-xs bg-slate-700/50 px-2 py-1 rounded text-slate-300">
                {opt}{opt === q.default ? ' (default)' : ''}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Main Page ─────────────────────────────────────────────────────────

export default function Projects() {
  const [activeTab, setActiveTab] = useState<Tab>('overview')

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <NavBar />

      <div className="max-w-6xl mx-auto px-6 py-6">
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

        <div className="bg-slate-900 border border-slate-800 rounded-lg p-6">
          {activeTab === 'overview' && <OverviewTab />}
          {activeTab === 'all-tasks' && <AllTasksTab />}
          {activeTab === 'questions' && <QuestionsTab />}
        </div>
      </div>
    </div>
  )
}
