/**
 * QuestionGenerator — Produces structured questions from readiness failures.
 *
 * Compatible with THE_FACTORY's questions.jsonl schema.
 */

import type { ReadinessAssessment } from '../types/graph.js';

export interface GeneratedQuestion {
  id: string;
  task: string;
  question: string;
  options: string[];
  default: string;
  impact: string;
  status: 'pending';
  asked: string;
}

/** Question templates keyed by readiness rule name */
const QUESTION_TEMPLATES: Record<string, {
  question: string;
  options: string[];
  default: string;
  impact: string;
}> = {
  has_acceptance_criteria: {
    question: 'What does success look like for this task? Define at least one testable acceptance criterion.',
    options: [
      'All tests pass',
      'Output matches expected format',
      'No regressions in existing behavior',
      'Specific metric threshold met',
    ],
    default: 'All tests pass',
    impact: 'Cannot verify task completion without acceptance criteria',
  },
  has_scope_boundary: {
    question: 'What parts of the codebase does this task touch? Specify file paths, modules, or sections.',
    options: [
      'Single file',
      'Single module/directory',
      'Multiple modules',
      'Cross-cutting (affects many areas)',
    ],
    default: 'Single module/directory',
    impact: 'Cannot scope blast radius or assess complexity without boundaries',
  },
  has_verification_command: {
    question: 'How do we verify this task works? Provide a test command or check specification.',
    options: [
      'Run existing test suite',
      'Run specific test file',
      'Manual verification steps',
      'Add new tests first',
    ],
    default: 'Run existing test suite',
    impact: 'Cannot confirm correctness without a verification method',
  },
  dependencies_resolved: {
    question: 'This task has unresolved dependencies. Which dependencies need to be completed first?',
    options: [
      'Wait for upstream task',
      'Dependencies are actually resolved (false alarm)',
      'Proceed without dependency (risk accepted)',
    ],
    default: 'Wait for upstream task',
    impact: 'Blocked until dependencies are resolved or explicitly waived',
  },
  no_ambiguous_terms: {
    question: 'The task description contains ambiguous terms without measurable criteria. Can you quantify them?',
    options: [
      'Add specific metrics/thresholds',
      'Terms are contextually clear (no change needed)',
      'Remove ambiguous requirements',
      'Rewrite with concrete criteria',
    ],
    default: 'Add specific metrics/thresholds',
    impact: 'Ambiguous requirements may lead to subjective or incorrect solutions',
  },
  risk_classified: {
    question: 'What is the risk level of this task? (Needed for oversight routing.)',
    options: [
      'Low (bugfix, minor change)',
      'Medium (new feature, moderate scope)',
      'High (architectural change, breaking change)',
    ],
    default: 'Medium (new feature, moderate scope)',
    impact: 'Risk classification determines oversight level and approval gates',
  },
};

let questionCounter = 0;

export function generateQuestions(
  assessment: ReadinessAssessment,
  taskId: string,
): GeneratedQuestion[] {
  const now = new Date().toISOString();
  const questions: GeneratedQuestion[] = [];

  for (const check of assessment.checks) {
    if (check.passed) continue;

    const template = QUESTION_TEMPLATES[check.rule];
    if (!template) continue;

    questionCounter++;
    questions.push({
      id: `q-auto-${questionCounter.toString().padStart(3, '0')}`,
      task: taskId,
      question: template.question,
      options: template.options,
      default: template.default,
      impact: template.impact,
      status: 'pending',
      asked: now,
    });
  }

  return questions;
}

// ─── Preflight ───

import type { TaskPayload } from '../types/index.js';
import { ReadinessGate } from './ReadinessGate.js';

/**
 * Pre-flight check: assess task readiness before execution.
 * Returns assessment + generated questions for failed checks.
 */
export async function preflight(
  task: TaskPayload,
  gate: ReadinessGate,
  taskId?: string,
): Promise<{ passed: boolean; assessment: ReadinessAssessment; questions: GeneratedQuestion[] }> {
  const assessment = await gate.assess(task);
  const questions = generateQuestions(assessment, taskId ?? 'unknown');

  // Populate questionsGenerated refs on the assessment
  assessment.questionsGenerated = questions.map(q => ({
    questionId: q.id,
    rule: assessment.checks.find(c => !c.passed && QUESTION_TEMPLATES[c.rule]?.question === q.question)?.rule ?? 'unknown',
  }));

  return {
    passed: assessment.passedAt !== null,
    assessment,
    questions,
  };
}
