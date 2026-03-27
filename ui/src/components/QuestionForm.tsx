import { useState } from 'react'

interface Question {
  id: string
  task: string
  question: string
  options: string[]
  default: string
  impact: string
  status: string
  asked: string
  answered: string | null
  answer: string | null
}

interface QuestionFormProps {
  question: Question
  onAnswered: () => void
}

export default function QuestionForm({ question, onAnswered }: QuestionFormProps) {
  const [selected, setSelected] = useState(question.default)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      const res = await fetch(`/api/session/questions/${question.id}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: selected }),
      })
      if (res.ok) {
        onAnswered()
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-4">
      <div className="flex items-start justify-between mb-2">
        <p className="text-sm font-medium text-slate-200">{question.question}</p>
        <span className="text-xs text-slate-500 ml-2 whitespace-nowrap">
          Task: {question.task}
        </span>
      </div>

      <p className="text-xs text-slate-500 mb-3">Impact: {question.impact}</p>

      <div className="space-y-2 mb-3">
        {question.options.map(option => (
          <label key={option} className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name={`q-${question.id}`}
              value={option}
              checked={selected === option}
              onChange={() => setSelected(option)}
              className="text-blue-500"
            />
            <span className="text-sm text-slate-300">
              {option}
              {option === question.default && (
                <span className="text-xs text-slate-500 ml-1">(default)</span>
              )}
            </span>
          </label>
        ))}
      </div>

      <button
        onClick={handleSubmit}
        disabled={submitting}
        className="bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white text-sm font-medium py-1.5 px-4 rounded transition-colors"
      >
        {submitting ? 'Submitting...' : 'Answer'}
      </button>
    </div>
  )
}
