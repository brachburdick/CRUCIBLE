import { useState, useEffect } from 'react'
import { useFetch, postRun } from '../hooks/useApi'

interface Task { name: string; path: string }
interface Agent { name: string }

export interface LaunchPreFill {
  projectName?: string
  description?: string
  instructions?: string
  seedDir?: string
  systemPrompt?: string
  variant?: string
  agent?: string
}

interface LaunchFormProps {
  onLaunched: (runId: string) => void
  preFill?: LaunchPreFill
}

export default function LaunchForm({ onLaunched, preFill }: LaunchFormProps) {
  const { data: tasks } = useFetch<Task[]>('/api/tasks')
  const { data: agents } = useFetch<Agent[]>('/api/agents')

  const isProjectLaunch = !!preFill?.projectName

  const [taskFile, setTaskFile] = useState('')
  const [agent, setAgent] = useState(preFill?.agent ?? 'coder')
  const [variant, setVariant] = useState(preFill?.variant ?? 'default')
  const [budget, setBudget] = useState(100000)
  const [ttl, setTtl] = useState(300)
  const [description, setDescription] = useState(preFill?.description ?? '')
  const [instructions, setInstructions] = useState(preFill?.instructions ?? '')
  const [launching, setLaunching] = useState(false)

  // Set defaults when data loads (only for file-based mode)
  useEffect(() => {
    if (!isProjectLaunch && tasks && tasks.length > 0 && !taskFile) {
      setTaskFile(tasks[0].path)
    }
  }, [tasks, taskFile, isProjectLaunch])

  // Update from preFill changes
  useEffect(() => {
    if (preFill?.description) setDescription(preFill.description)
    if (preFill?.instructions) setInstructions(preFill.instructions)
    if (preFill?.variant) setVariant(preFill.variant)
    if (preFill?.agent) setAgent(preFill.agent)
  }, [preFill])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLaunching(true)
    try {
      const result = await postRun(
        isProjectLaunch
          ? {
              agent,
              variant,
              budget,
              ttl,
              projectName: preFill?.projectName,
              description,
              instructions,
              seedDir: preFill?.seedDir,
              systemPrompt: preFill?.systemPrompt,
            }
          : { taskFile, agent, variant, budget, ttl }
      )
      if (result.runId) {
        onLaunched(result.runId)
      }
    } finally {
      setLaunching(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Project context banner */}
      {isProjectLaunch && (
        <div className="bg-orange-500/10 border border-orange-500/20 rounded-lg px-4 py-3">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-orange-400 text-sm font-semibold">{preFill?.projectName}</span>
            {preFill?.seedDir && (
              <span className="text-xs text-slate-500">+ project files via seedDir</span>
            )}
            {preFill?.systemPrompt && (
              <span className="text-xs text-slate-500">+ CLAUDE.md context</span>
            )}
          </div>
          <p className="text-xs text-slate-400">
            Agent will receive project context and file access.
          </p>
        </div>
      )}

      {/* Task source */}
      {isProjectLaunch ? (
        <div className="space-y-3">
          <div>
            <label className="block text-sm text-slate-400 mb-1">Description</label>
            <input
              type="text"
              value={description}
              onChange={e => setDescription(e.target.value)}
              className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-400 mb-1">Instructions</label>
            <textarea
              value={instructions}
              onChange={e => setInstructions(e.target.value)}
              rows={3}
              className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200 resize-y"
            />
          </div>
        </div>
      ) : (
        <div>
          <label className="block text-sm text-slate-400 mb-1">Task File</label>
          <select
            value={taskFile}
            onChange={e => setTaskFile(e.target.value)}
            className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200"
          >
            {tasks?.map(t => (
              <option key={t.path} value={t.path}>{t.name}</option>
            ))}
          </select>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-slate-400 mb-1">Agent</label>
          <select
            value={agent}
            onChange={e => setAgent(e.target.value)}
            className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200"
          >
            {agents?.map(a => (
              <option key={a.name} value={a.name}>{a.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">Variant Label</label>
          <input
            type="text"
            value={variant}
            onChange={e => setVariant(e.target.value)}
            className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-slate-400 mb-1">Token Budget</label>
          <input
            type="number"
            value={budget}
            onChange={e => setBudget(Number(e.target.value))}
            className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200"
          />
        </div>
        <div>
          <label className="block text-sm text-slate-400 mb-1">TTL (seconds)</label>
          <input
            type="number"
            value={ttl}
            onChange={e => setTtl(Number(e.target.value))}
            className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200"
          />
        </div>
      </div>

      <button
        type="submit"
        disabled={launching || (isProjectLaunch ? !description : !taskFile)}
        className="w-full bg-orange-600 hover:bg-orange-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium py-2 px-4 rounded transition-colors"
      >
        {launching ? 'Starting...' : isProjectLaunch ? `Run on ${preFill?.projectName}` : 'Start Run'}
      </button>
    </form>
  )
}
