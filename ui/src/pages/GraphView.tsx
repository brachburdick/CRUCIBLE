import { useParams, Link } from 'react-router-dom'
import { useFetch } from '../hooks/useApi'
import NavBar from '../components/NavBar'
import { TaskStatusBadge } from '../components/TaskStatusBadge'

interface DecompositionNode {
  id: string
  parentId: string | null
  type: string
  description: string
  status: string
  acceptanceCriteria: string[]
  metrics: {
    tokenUsage: { total: number }
    wallTimeMs: number
    mutations: number
    testCycles: number
  }
}

interface DecompositionGraph {
  id: string
  strategyUsed: string
  status: string
  createdAt: string
  updatedAt: string
  nodes: DecompositionNode[]
  edges: Array<{ from: string; to: string; type: string }>
  metrics: {
    totalTokens: number
    totalWallTimeMs: number
    completedCount: number
    failedCount: number
    nodeCount: number
  }
}

export default function GraphView() {
  const { id } = useParams<{ id: string }>()
  const { data: graph } = useFetch<DecompositionGraph>(`/api/graphs/${id}`, [id])

  if (!graph) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-200">
        <NavBar />
        <div className="max-w-5xl mx-auto px-6 py-6 text-slate-500">Loading graph...</div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <NavBar />

      <div className="max-w-6xl mx-auto px-6 py-6">
        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <Link to="/graphs" className="text-slate-500 hover:text-slate-300 text-sm">← Graphs</Link>
          <h2 className="text-lg font-semibold font-mono">{graph.id}</h2>
          <TaskStatusBadge status={graph.status} />
          <span className="text-xs text-slate-500">Strategy: {graph.strategyUsed}</span>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-5 gap-4 mb-6">
          {[
            { label: 'Nodes', value: graph.metrics.nodeCount },
            { label: 'Completed', value: graph.metrics.completedCount },
            { label: 'Failed', value: graph.metrics.failedCount },
            { label: 'Tokens', value: graph.metrics.totalTokens.toLocaleString() },
            { label: 'Time', value: `${(graph.metrics.totalWallTimeMs / 1000).toFixed(1)}s` },
          ].map(s => (
            <div key={s.label} className="bg-slate-800/50 rounded-lg p-3">
              <p className="text-xs text-slate-500">{s.label}</p>
              <p className="text-lg font-bold text-slate-200">{s.value}</p>
            </div>
          ))}
        </div>

        {/* Placeholder: React Flow graph will go here in Phase 6D */}
        <div className="bg-slate-900 border border-slate-800 rounded-lg p-8 mb-6 text-center">
          <p className="text-slate-500 text-sm mb-2">
            Visual node graph (React Flow + ELK) coming in Phase 6D
          </p>
          <p className="text-slate-600 text-xs">
            {graph.nodes.length} nodes · {graph.edges.length} edges
          </p>
        </div>

        {/* Node List (functional fallback) */}
        <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
          <h3 className="px-4 py-3 text-sm font-semibold text-slate-300 border-b border-slate-800">
            Nodes
          </h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400 text-left">
                <th className="px-4 py-2 font-medium">ID</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Description</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium text-right">Tokens</th>
                <th className="px-4 py-2 font-medium text-right">Time</th>
              </tr>
            </thead>
            <tbody>
              {graph.nodes.map(node => (
                <tr key={node.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                  <td className="px-4 py-2 font-mono text-xs text-orange-400">{node.id}</td>
                  <td className="px-4 py-2 text-slate-400">{node.type}</td>
                  <td className="px-4 py-2 text-slate-300 max-w-md truncate">{node.description}</td>
                  <td className="px-4 py-2"><TaskStatusBadge status={node.status} /></td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-slate-400">
                    {node.metrics.tokenUsage.total > 0 ? node.metrics.tokenUsage.total.toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-slate-400">
                    {node.metrics.wallTimeMs > 0 ? `${(node.metrics.wallTimeMs / 1000).toFixed(1)}s` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
