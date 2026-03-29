import { useState } from 'react'

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

export interface ReadinessGatePanelProps {
  assessment: ReadinessAssessment | null
  enrichments: Record<string, string>
  waivers: Record<string, string>
  acknowledged: Set<string>
  loading: boolean
  onAnswer: (rule: string, answer: string) => void
  onWaive: (rule: string, justification: string) => void
  onAcknowledge: (rule: string) => void
  children?: React.ReactNode
}

const RULE_LABELS: Record<string, string> = {
  has_acceptance_criteria: 'Acceptance Criteria',
  has_scope_boundary: 'Scope Boundary',
  has_verification_command: 'Verification Command',
  risk_classified: 'Risk Classification',
  dependencies_resolved: 'Dependencies',
  no_ambiguous_terms: 'Ambiguous Terms',
}

const TIER_BADGE: Record<string, { label: string; color: string }> = {
  required: { label: 'REQUIRED', color: 'bg-red-500/20 text-red-400 border-red-500/30' },
  waivable: { label: 'WAIVABLE', color: 'bg-amber-500/20 text-amber-400 border-amber-500/30' },
  advisory: { label: 'ADVISORY', color: 'bg-blue-500/20 text-blue-400 border-blue-500/30' },
}

function CheckRow({
  check,
  enrichments,
  waivers,
  acknowledged,
  onAnswer,
  onWaive,
  onAcknowledge,
}: {
  check: ReadinessCheck
  enrichments: Record<string, string>
  waivers: Record<string, string>
  acknowledged: Set<string>
  onAnswer: (rule: string, answer: string) => void
  onWaive: (rule: string, justification: string) => void
  onAcknowledge: (rule: string) => void
}) {
  const [input, setInput] = useState('')
  const badge = TIER_BADGE[check.binding]
  const label = RULE_LABELS[check.rule] ?? check.rule
  const isWaived = check.binding === 'waivable' && waivers[check.rule] !== undefined
  const isAcknowledged = check.binding === 'advisory' && acknowledged.has(check.rule)
  const isAnswered = enrichments[check.rule] !== undefined

  const resolved = check.passed || isWaived || isAcknowledged

  const handleSubmit = () => {
    if (!input.trim()) return
    if (check.binding === 'waivable') {
      onWaive(check.rule, input.trim())
    } else {
      onAnswer(check.rule, input.trim())
    }
    setInput('')
  }

  return (
    <div className="py-2.5 border-b border-slate-800/50 last:border-0">
      <div className="flex items-start gap-2">
        {/* Pass/fail icon */}
        <span className="mt-0.5 text-sm flex-shrink-0">
          {resolved ? (
            <span className="text-green-400">&#10003;</span>
          ) : check.binding === 'advisory' ? (
            <span className="text-blue-400">i</span>
          ) : (
            <span className="text-red-400">&#10007;</span>
          )}
        </span>

        {/* Tier badge */}
        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border flex-shrink-0 ${badge.color}`}>
          {badge.label}
        </span>

        {/* Label + detail */}
        <div className="flex-1 min-w-0">
          <span className="text-sm text-slate-200 font-medium">{label}</span>
          <p className="text-xs text-slate-400 mt-0.5">
            {check.detail}
            {isWaived && <span className="ml-2 text-amber-400">(waived)</span>}
            {isAcknowledged && <span className="ml-2 text-blue-400">(acknowledged)</span>}
            {isAnswered && check.passed && <span className="ml-2 text-green-400">(resolved)</span>}
          </p>

          {/* Action inputs for failed checks */}
          {!resolved && !check.passed && (
            <div className="mt-2">
              {check.binding === 'required' && (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                    placeholder={getPlaceholder(check.rule)}
                    className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-slate-200 placeholder-slate-500"
                  />
                  <button
                    type="button"
                    onClick={handleSubmit}
                    className="px-3 py-1 bg-orange-600 hover:bg-orange-500 text-white text-xs rounded transition-colors"
                  >
                    Submit
                  </button>
                </div>
              )}
              {check.binding === 'waivable' && (
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSubmit()}
                    placeholder="Why is this acceptable?"
                    className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-slate-200 placeholder-slate-500"
                  />
                  <button
                    type="button"
                    onClick={handleSubmit}
                    className="px-3 py-1 bg-amber-600 hover:bg-amber-500 text-white text-xs rounded transition-colors"
                  >
                    Waive
                  </button>
                </div>
              )}
              {check.binding === 'advisory' && (
                <button
                  type="button"
                  onClick={() => onAcknowledge(check.rule)}
                  className="px-3 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs rounded transition-colors"
                >
                  Acknowledge
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function getPlaceholder(rule: string): string {
  switch (rule) {
    case 'has_acceptance_criteria':
      return 'What criteria determine success?'
    case 'has_scope_boundary':
      return 'What files or directories are in scope?'
    case 'has_verification_command':
      return 'What command verifies this task completed? e.g. npm test'
    default:
      return 'Provide clarification...'
  }
}

export default function ReadinessGatePanel({
  assessment,
  enrichments,
  waivers,
  acknowledged,
  loading,
  onAnswer,
  onWaive,
  onAcknowledge,
  children,
}: ReadinessGatePanelProps) {
  if (!assessment) return null

  const checks = assessment.checks
  const resolved = checks.filter(c =>
    c.passed ||
    (c.binding === 'waivable' && waivers[c.rule] !== undefined) ||
    (c.binding === 'advisory' && acknowledged.has(c.rule))
  ).length

  return (
    <div className="border border-slate-800 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-slate-900/50 border-b border-slate-800">
        <span className="text-sm font-medium text-slate-300">Readiness</span>
        {loading ? (
          <span className="flex items-center gap-1.5 text-xs text-slate-400">
            <span className="w-3 h-3 border-2 border-slate-500 border-t-orange-400 rounded-full animate-spin" />
            checking...
          </span>
        ) : (
          <span className="text-xs text-slate-400 font-mono">
            {resolved} / {checks.length}
          </span>
        )}
      </div>

      {/* Check rows */}
      <div className="px-4 py-1">
        {checks.map(check => (
          <CheckRow
            key={check.rule}
            check={check}
            enrichments={enrichments}
            waivers={waivers}
            acknowledged={acknowledged}
            onAnswer={onAnswer}
            onWaive={onWaive}
            onAcknowledge={onAcknowledge}
          />
        ))}
      </div>

      {/* Extension slot for 7B */}
      {children}
    </div>
  )
}
