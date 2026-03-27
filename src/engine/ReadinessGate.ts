/**
 * ReadinessGate — Evaluates tasks/nodes against global readiness rules.
 *
 * 6 global checks, configurable gate mode (hard-block vs triage).
 * Composite score: (globalWeight * globalScore) + ((1 - globalWeight) * dynamicScore).
 */

import type { TaskPayload } from '../types/index.js';
import type { DecompositionNode, ReadinessAssessment, ReadinessCheck, QuestionRef } from '../types/graph.js';
import { emptyReadiness } from '../types/graph.js';

export interface ReadinessGateConfig {
  gateMode: 'hard-block' | 'triage';
  readinessThreshold: number;
  globalWeight: number;
}

const DEFAULT_CONFIG: ReadinessGateConfig = {
  gateMode: 'triage',
  readinessThreshold: 0.8,
  globalWeight: 0.7,
};

/** Ambiguous terms that need measurable criteria */
const AMBIGUOUS_TERMS = ['fast', 'safe', 'minimal', 'better', 'clean', 'simple', 'efficient', 'optimal', 'robust', 'scalable'];

/** Patterns that qualify ambiguous terms (making them acceptable) */
const QUALIFIER_PATTERNS = [
  /\d+\s*(ms|seconds?|minutes?|hours?|%|percent|x\s*faster)/i,
  /less\s*than\s*\d+/i,
  /under\s*\d+/i,
  /within\s*\d+/i,
  /at\s*most\s*\d+/i,
  /at\s*least\s*\d+/i,
];

export class ReadinessGate {
  private config: ReadinessGateConfig;

  constructor(config?: Partial<ReadinessGateConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async assess(task: TaskPayload): Promise<ReadinessAssessment> {
    const checks = this.runGlobalChecks(task);
    return this.buildAssessment(checks);
  }

  async assessNode(node: DecompositionNode): Promise<ReadinessAssessment> {
    // Synthesize a pseudo-TaskPayload from node fields for rule evaluation
    const pseudoTask: TaskPayload = {
      description: node.description,
      instructions: node.acceptanceCriteria.join('\n'),
      files: node.ownedPaths.length > 0
        ? Object.fromEntries(node.ownedPaths.map(p => [p, '']))
        : undefined,
      checks: node.acceptanceCriteria.length > 0
        ? [{ name: 'acceptance', type: 'exec' as const, command: 'true' }]
        : undefined,
    };
    const checks = this.runGlobalChecks(pseudoTask);
    return this.buildAssessment(checks);
  }

  private runGlobalChecks(task: TaskPayload): ReadinessCheck[] {
    return [
      this.checkAcceptanceCriteria(task),
      this.checkScopeBoundary(task),
      this.checkVerificationCommand(task),
      this.checkDependenciesResolved(task),
      this.checkAmbiguousTerms(task),
      this.checkRiskClassified(task),
    ];
  }

  private checkAcceptanceCriteria(task: TaskPayload): ReadinessCheck {
    const hasChecks = task.checks && task.checks.length > 0;
    const hasMeasurableOutcomes = /(?:should|must|expect|assert|verify|return|output|produce|pass|fail)/i.test(task.instructions ?? '');

    return {
      rule: 'has_acceptance_criteria',
      source: 'global',
      binding: 'hard',
      passed: !!(hasChecks || hasMeasurableOutcomes),
      detail: hasChecks
        ? `${task.checks!.length} acceptance check(s) defined`
        : hasMeasurableOutcomes
          ? 'Instructions contain measurable outcomes'
          : 'No testable acceptance criteria found',
    };
  }

  private checkScopeBoundary(task: TaskPayload): ReadinessCheck {
    const hasFiles = task.files && Object.keys(task.files).length > 0;
    const hasSeedDir = !!task.seedDir;
    const instructionsReferenceFiles = /(?:\.(?:py|ts|js|tsx|jsx|json|yaml|yml|md|css|html|go|rs|java|rb|sh)\b|src\/|lib\/|test|spec)/i.test(
      `${task.description} ${task.instructions}`
    );

    return {
      rule: 'has_scope_boundary',
      source: 'global',
      binding: 'hard',
      passed: !!(hasFiles || hasSeedDir || instructionsReferenceFiles),
      detail: hasFiles
        ? `files specified: ${Object.keys(task.files!).join(', ')}`
        : hasSeedDir
          ? `seedDir: ${task.seedDir}`
          : instructionsReferenceFiles
            ? 'Instructions reference specific files/modules'
            : 'No file paths, module, or section specified',
    };
  }

  private checkVerificationCommand(task: TaskPayload): ReadinessCheck {
    const hasChecks = task.checks && task.checks.length > 0;
    const hasTestCommand = /(?:run\s+.*test|pytest|npm\s+test|jest|mocha|make\s+test|go\s+test|cargo\s+test|python\s+test)/i.test(
      task.instructions ?? ''
    );

    return {
      rule: 'has_verification_command',
      source: 'global',
      binding: 'hard',
      passed: !!(hasChecks || hasTestCommand),
      detail: hasChecks
        ? `${task.checks!.length} exec check(s) defined`
        : hasTestCommand
          ? 'Instructions include test command'
          : 'No verification command or checks found',
    };
  }

  private checkDependenciesResolved(_task: TaskPayload): ReadinessCheck {
    // In Phase 1, tasks don't declare formal dependencies.
    // This check passes by default — it becomes meaningful when
    // nodes have ArtifactRef inputs pointing to other nodes.
    return {
      rule: 'dependencies_resolved',
      source: 'global',
      binding: 'hard',
      passed: true,
      detail: 'No declared dependencies (standalone task)',
    };
  }

  private checkAmbiguousTerms(task: TaskPayload): ReadinessCheck {
    const text = `${task.description} ${task.instructions}`.toLowerCase();
    const found: string[] = [];

    for (const term of AMBIGUOUS_TERMS) {
      if (text.includes(term)) {
        // Check if the term is qualified with measurable criteria nearby
        const termIdx = text.indexOf(term);
        const context = text.slice(Math.max(0, termIdx - 40), termIdx + term.length + 40);
        const isQualified = QUALIFIER_PATTERNS.some(p => p.test(context));
        if (!isQualified) {
          found.push(term);
        }
      }
    }

    return {
      rule: 'no_ambiguous_terms',
      source: 'global',
      binding: 'advisory',
      passed: found.length === 0,
      detail: found.length === 0
        ? 'No ambiguous terms found'
        : `Unqualified ambiguous terms: ${found.join(', ')}`,
    };
  }

  private checkRiskClassified(task: TaskPayload): ReadinessCheck {
    // Infer risk from description keywords
    const text = `${task.description} ${task.instructions}`.toLowerCase();
    const bugfix = /(?:fix|bug|patch|hotfix|regression|broken|error)/.test(text);
    const feature = /(?:add|create|implement|new|build|feature)/.test(text);
    const refactor = /(?:refactor|extract|consolidate|simplify|rename|move|reorganize)/.test(text);

    const classified = bugfix || feature || refactor;

    return {
      rule: 'risk_classified',
      source: 'global',
      binding: 'hard',
      passed: classified,
      detail: classified
        ? `Risk inferred: ${bugfix ? 'bugfix (low)' : feature ? 'feature (medium)' : 'refactor (low-medium)'}`
        : 'Unable to infer risk classification from description',
    };
  }

  private buildAssessment(checks: ReadinessCheck[]): ReadinessAssessment {
    const assessment = emptyReadiness();
    assessment.gateMode = this.config.gateMode;
    assessment.globalWeight = this.config.globalWeight;
    assessment.checks = checks;

    // Compute global score: proportion of passed checks (hard checks weighted more)
    const hardChecks = checks.filter(c => c.binding === 'hard');
    const advisoryChecks = checks.filter(c => c.binding === 'advisory');

    const hardPassed = hardChecks.filter(c => c.passed).length;
    const advisoryPassed = advisoryChecks.filter(c => c.passed).length;

    // Hard checks are worth 1.0 each, advisory worth 0.5
    const totalWeight = hardChecks.length + advisoryChecks.length * 0.5;
    const passedWeight = hardPassed + advisoryPassed * 0.5;
    assessment.globalScore = totalWeight > 0 ? passedWeight / totalWeight : 1.0;

    // dynamicScore is 1.0 in Phase 1 (no dynamic gate configured)
    assessment.dynamicScore = 1.0;

    // Composite
    assessment.compositeScore =
      assessment.globalWeight * assessment.globalScore +
      (1 - assessment.globalWeight) * assessment.dynamicScore;

    // Check pass condition
    const allHardPassed = hardChecks.every(c => c.passed);

    if (this.config.gateMode === 'hard-block') {
      if (allHardPassed && assessment.compositeScore >= this.config.readinessThreshold) {
        assessment.passedAt = new Date().toISOString();
      }
    } else {
      // Triage mode: pass if composite score meets threshold
      if (assessment.compositeScore >= this.config.readinessThreshold) {
        assessment.passedAt = new Date().toISOString();
      }
    }

    return assessment;
  }
}
