import { useState } from 'react'
import { useFetch, postRun } from '../hooks/useApi'

interface Task { name: string; path: string }
interface Agent { name: string }

export default function LaunchForm({ onLaunched }: { onLaunched: (runId: string) => void }) {
  const { data: tasks } = useFetch<Task[]>('/api/tasks')
  const { data: agents } = useFetch<Agent[]>('/api/agents')

  const [taskFile, setTaskFile] = useState('')
  const [agent, setAgent] = useState('echo')
  const [variant, setVariant] = useState('default')
  const [budget, setBudget] = useState(100000)
  const [ttl, setTtl] = useState(300)
  const [launching, setLaunching] = useState(false)

  // Set defaults when data loads
  if (tasks && tasks.length > 0 && !taskFile) {
    setTaskFile(tasks[0].path)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLaunching(true)
    try {
      const result = await postRun({ taskFile, agent, variant, budget, ttl })
      if (result.runId) {
        onLaunched(result.runId)
      }
    } finally {
      setLaunching(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm text-slate-400 mb-1">Task</label>
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
        disabled={launching || !taskFile}
        className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium py-2 px-4 rounded transition-colors"
      >
        {launching ? 'Starting...' : 'Start Run'}
      </button>
    </form>
  )
}
