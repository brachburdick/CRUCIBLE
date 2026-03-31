import { useState, useEffect, useRef, useCallback } from 'react'
import { useFetch, postRun } from '../hooks/useApi'
import ReadinessGatePanel from './ReadinessGatePanel'
import DeepAnalysisPanel from './DeepAnalysisPanel'
import type { DeepCheck, CascadeResult } from './DeepAnalysisPanel'

interface Task { name: string; path: string }
interface Agent { name: string }

interface ReadinessCheck {
  rule: string
  source: string
  binding: 'required' | 'waivable' | 'advisory'
  passed: boolean
  detail: string
}

interface ReadinessAssessment {
  checks: ReadinessCheck[]
  compositeScore: number
  globalScore: number
  [key: string]: unknown
}

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

/** Human-readable label map — matches the backend */
const RULE_LABELS: Record<string, string> = {
  has_acceptance_criteria: 'Acceptance Criteria',
  has_scope_boundary: 'Scope Boundary',
  has_verification_command: 'Verification Command',
  risk_classified: 'Risk Classification',
  dependencies_resolved: 'Dependencies',
  no_ambiguous_terms: 'Ambiguous Terms',
}

/**
 * Build enriched instructions by appending operator clarifications.
 * Pure function — matches backend buildEnrichedInstructions.
 */
export function buildEnrichedInstructions(
  instructions: string,
  enrichments: Record<string, string>,
): string {
  const entries = Object.entries(enrichments).filter(([, v]) => v.trim().length > 0)
  if (entries.length === 0) return instructions

  const lines = entries.map(([rule, answer]) => {
    const label = RULE_LABELS[rule] ?? rule
    return `[${label}]\n${answer}`
  })

  const block = `\n---\nOperator clarifications (provided during pre-flight readiness check):\n\n${lines.join('\n\n')}`
  return instructions ? `${instructions}${block}` : block.trimStart()
}

function buildGateSummary(
  assessment: ReadinessAssessment | null,
  waivers: Record<string, string>,
  acknowledged: Set<string>,
) {
  if (!assessment) return undefined
  const passed: string[] = []
  const failed: string[] = []
  const waived: string[] = []
  for (const c of assessment.checks) {
    if (c.passed) {
      passed.push(c.rule)
    } else if (waivers[c.rule] !== undefined) {
      waived.push(c.rule)
    } else if (acknowledged.has(c.rule)) {
      // acknowledged advisories count as acknowledged, not passed
      passed.push(c.rule)
    } else {
      failed.push(c.rule)
    }
  }
  return { passed, failed, waived }
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
  const [strategy, setStrategy] = useState('D0')
  const [taskIntent, setTaskIntent] = useState('Implementation')
  const [launching, setLaunching] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  // Gate state
  const [assessment, setAssessment] = useState<ReadinessAssessment | null>(null)
  const [enrichments, setEnrichments] = useState<Record<string, string>>({})
  const [waivers, setWaivers] = useState<Record<string, string>>({})
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set())
  const [gateLoading, setGateLoading] = useState(false)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Deep analysis state
  const [deepChecks, setDeepChecks] = useState<DeepCheck[]>([])
  const [strategySuggestion, setStrategySuggestion] = useState<CascadeResult | null>(null)
  const [strategyManuallyChanged, setStrategyManuallyChanged] = useState(false)
  const [deepAnalysisKey, setDeepAnalysisKey] = useState(0) // increment to reset panel

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

  // Call readiness endpoint
  const evaluateReadiness = useCallback(async (
    desc: string,
    instr: string,
    enrich: Record<string, string>,
  ) => {
    if (!desc.trim()) return
    setGateLoading(true)
    try {
      const res = await fetch('/api/readiness', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: desc,
          instructions: instr || undefined,
          seedDir: preFill?.seedDir || undefined,
          enrichments: Object.keys(enrich).length > 0 ? enrich : undefined,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        setAssessment(data.assessment)
      }
    } catch {
      // silently fail — gate is informative, not blocking
    } finally {
      setGateLoading(false)
    }
  }, [preFill?.seedDir])

  // 1.5s idle trigger for description/instructions changes
  useEffect(() => {
    if (!isProjectLaunch || !description.trim()) return
    // Clear deep analysis results on edit (reset to Ready state)
    setDeepChecks([])
    setStrategySuggestion(null)
    setDeepAnalysisKey(k => k + 1)

    if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    idleTimerRef.current = setTimeout(() => {
      evaluateReadiness(description, instructions, enrichments)
    }, 1500)
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    }
  }, [description, instructions, isProjectLaunch, evaluateReadiness, enrichments])

  const handleAnswer = (rule: string, answer: string) => {
    const updated = { ...enrichments, [rule]: answer }
    setEnrichments(updated)
    // Immediate re-evaluation
    evaluateReadiness(description, instructions, updated)
  }

  const handleWaive = (rule: string, justification: string) => {
    setWaivers(prev => ({ ...prev, [rule]: justification }))
  }

  const handleAcknowledge = (rule: string) => {
    setAcknowledged(prev => new Set(prev).add(rule))
  }

  const handleStrategyChange = (value: string) => {
    setStrategy(value)
    setStrategyManuallyChanged(true)
  }

  const handleDeepResults = (checks: DeepCheck[], strat: CascadeResult | null) => {
    setDeepChecks(checks)
    setStrategySuggestion(strat)
    // Pre-fill strategy if operator hasn't manually changed it
    if (strat && !strategyManuallyChanged) {
      setStrategy(strat.suggested)
    }
  }

  // Compute passable: all required pass, all waivable resolved (pass or waived)
  const gatePassable = assessment ? (() => {
    const requiredOk = assessment.checks
      .filter(c => c.binding === 'required')
      .every(c => c.passed)
    const waivableOk = assessment.checks
      .filter(c => c.binding === 'waivable')
      .every(c => c.passed || waivers[c.rule] !== undefined)
    return requiredOk && waivableOk
  })() : false

  const canLaunchPrimary = isProjectLaunch
    ? description.trim().length > 0 && gatePassable && !gateLoading
    : !!taskFile

  const canLaunchBypass = isProjectLaunch
    ? description.trim().length > 0
    : !!taskFile

  const showBypassButton = isProjectLaunch && !canLaunchPrimary && canLaunchBypass

  const handleSubmit = async (bypass: boolean = false) => {
    setLaunching(true)
    try {
      const enrichedInstructions = isProjectLaunch
        ? buildEnrichedInstructions(instructions, enrichments)
        : instructions

      const waiverEntries = Object.entries(waivers).map(([rule, justification]) => ({
        rule,
        justification,
        timestamp: new Date().toISOString(),
      }))

      const result = await postRun(
        isProjectLaunch
          ? {
              agent,
              variant,
              budget,
              ttl,
              projectName: preFill?.projectName,
              description,
              instructions: enrichedInstructions,
              seedDir: preFill?.seedDir,
              systemPrompt: preFill?.systemPrompt,
              strategy,
              gateBypass: bypass || undefined,
              gateSummary: buildGateSummary(assessment, waivers, acknowledged),
              waivers: waiverEntries.length > 0 ? waiverEntries : undefined,
              deepAnalysis: deepChecks.length > 0 ? deepChecks : undefined,
              strategySuggested: strategySuggestion?.suggested,
              strategySelected: strategy,
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

  // Primary launch button label
  const primaryLabel = (() => {
    if (launching) return 'Starting...'
    if (!isProjectLaunch) return 'Start Run'
    if (gateLoading) return 'Checking...'
    if (assessment && !gatePassable) {
      const unresolvedCount = assessment.checks.filter(c =>
        !c.passed &&
        c.binding !== 'advisory' &&
        !(c.binding === 'waivable' && waivers[c.rule] !== undefined)
      ).length
      return unresolvedCount > 0 ? `Resolve ${unresolvedCount} check(s)` : 'Launch'
    }
    return preFill?.projectName ? `Run on ${preFill.projectName}` : 'Launch'
  })()

  return (
    <form onSubmit={e => { e.preventDefault(); handleSubmit(false) }} className="space-y-5">
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

      {/* ─── Essential Section ─── */}
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
          <label className="block text-sm text-slate-400 mb-1">Strategy</label>
          <select
            value={strategy}
            onChange={e => handleStrategyChange(e.target.value)}
            className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200"
          >
            <option value="D0">D0</option>
            <option value="D4">D4</option>
            <option value="D5">D5</option>
          </select>
          {strategySuggestion && (
            <p className="text-xs text-slate-500 mt-1">
              suggested: {strategySuggestion.suggested}
              {strategyManuallyChanged && strategy !== strategySuggestion.suggested && (
                <span className="ml-1">(overridden)</span>
              )}
              {strategySuggestion.reason && (
                <span className="ml-1">&mdash; {strategySuggestion.reason}</span>
              )}
            </p>
          )}
        </div>
      </div>

      {isProjectLaunch && (
        <div>
          <label className="block text-sm text-slate-400 mb-1">Task Intent</label>
          <select
            value={taskIntent}
            onChange={e => setTaskIntent(e.target.value)}
            className="w-full bg-slate-800 border border-slate-600 rounded px-3 py-2 text-sm text-slate-200"
          >
            <option value="Implementation">Implementation</option>
            <option value="Diagnostic">Diagnostic</option>
            <option value="Exploration">Exploration (Is X possible?)</option>
            <option value="Assessment">Assessment (How is this working?)</option>
          </select>
        </div>
      )}

      {/* ─── Readiness Section ─── */}
      {isProjectLaunch && description.trim().length > 0 && (
        <ReadinessGatePanel
          assessment={assessment}
          enrichments={enrichments}
          waivers={waivers}
          acknowledged={acknowledged}
          loading={gateLoading}
          onAnswer={handleAnswer}
          onWaive={handleWaive}
          onAcknowledge={handleAcknowledge}
        >
          <DeepAnalysisPanel
            key={deepAnalysisKey}
            gatePassable={gatePassable}
            description={description}
            instructions={instructions}
            seedDir={preFill?.seedDir}
            enrichments={enrichments}
            taskIntent={taskIntent}
            onResults={handleDeepResults}
          />
        </ReadinessGatePanel>
      )}

      {/* ─── Advanced Section ─── */}
      <div className="border border-slate-800 rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => setAdvancedOpen(!advancedOpen)}
          className="w-full flex items-center justify-between px-4 py-2.5 bg-slate-900/50 text-sm text-slate-400 hover:text-slate-300 transition-colors"
        >
          <span className="font-medium">Advanced</span>
          <div className="flex items-center gap-3">
            {!advancedOpen && (
              <span className="text-xs text-slate-500 font-mono">
                Budget: {(budget / 1000).toFixed(0)}K &middot; TTL: {ttl}s &middot; Variant: {variant || 'default'}
              </span>
            )}
            <span className="text-slate-500">{advancedOpen ? '\u25BC' : '\u25B6'}</span>
          </div>
        </button>
        {advancedOpen && (
          <div className="px-4 py-3 space-y-3 border-t border-slate-800">
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
        )}
      </div>

      {/* ─── Launch Buttons ─── */}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={launching || !canLaunchPrimary}
          className="flex-1 bg-orange-600 hover:bg-orange-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium py-2 px-4 rounded transition-colors"
        >
          {primaryLabel}
        </button>
        {showBypassButton && (
          <button
            type="button"
            onClick={() => handleSubmit(true)}
            disabled={launching}
            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm font-medium rounded transition-colors whitespace-nowrap"
          >
            Launch anyway
          </button>
        )}
      </div>
    </form>
  )
}
