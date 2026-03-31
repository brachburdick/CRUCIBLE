/**
 * ReadinessGate — Evaluates tasks/nodes against global readiness rules.
 *
 * 6 global checks, configurable gate mode (hard-block vs triage).
 * Composite score: (globalWeight * globalScore) + ((1 - globalWeight) * dynamicScore).
 */

import type { TaskPayload } from '../types/index.js';
import type { DecompositionNode, ReadinessAssessment, ReadinessCheck, QuestionRef } from '../types/graph.js';
import { emptyReadiness } from '../types/graph.js';
import { baseLlmCall } from './llm.js';
import type { DeepCheck } from './StrategySelector.js';
import type { FlowType } from '../session/types.js';

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

  async assess(task: TaskPayload, flowType?: FlowType): Promise<ReadinessAssessment> {
    const checks = this.runChecksForFlow(task, flowType);
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

  /**
   * Deep analysis — batched LLM call to estimate 4 heuristics.
   * Returns DeepCheck[] with levels assigned by thresholds.
   * Gracefully returns [] on any failure.
   */
  async assessDeep(task: TaskPayload): Promise<DeepCheck[]> {
    const prompt = `You are a task scope estimator for a software engineering agent harness. Analyze this task and estimate 4 heuristics. Be conservative — overestimate complexity rather than underestimate.

Task description: ${task.description}
Instructions: ${task.instructions ?? 'none'}
Files: ${task.files ? Object.keys(task.files).join(', ') : 'none specified'}
Seed directory: ${task.seedDir ?? 'none'}

Respond with ONLY a JSON object (no markdown, no commentary):
{
  "estimated_duration_minutes": <number>,
  "file_count": <number>,
  "change_entropy_modules": <number>,
  "architectural_scope": "localized" | "architectural"
}

estimated_duration_minutes: How long would a senior engineer take? (in minutes)
file_count: How many files will likely be modified?
change_entropy_modules: How many distinct modules/directories are touched?
architectural_scope: "localized" if changes stay within one module boundary, "architectural" if they cross module boundaries or change interfaces.`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const response = await baseLlmCall(
        [{ role: 'user', content: prompt }],
        { maxTokens: 500, temperature: 0.1 },
      );

      clearTimeout(timeout);

      const parsed = JSON.parse(response.content) as {
        estimated_duration_minutes?: number;
        file_count?: number;
        change_entropy_modules?: number;
        architectural_scope?: string;
      };

      return this.buildDeepChecks(parsed);
    } catch {
      return [];
    }
  }

  private buildDeepChecks(parsed: {
    estimated_duration_minutes?: number;
    file_count?: number;
    change_entropy_modules?: number;
    architectural_scope?: string;
  }): DeepCheck[] {
    const durationMin = parsed.estimated_duration_minutes ?? 0;
    const files = parsed.file_count ?? 0;
    const entropy = parsed.change_entropy_modules ?? 0;
    const scope = parsed.architectural_scope ?? 'localized';

    return [
      {
        heuristic: 'estimated_duration',
        value: durationMin,
        level: durationMin < 30 ? 'green' : durationMin <= 240 ? 'amber' : 'red',
        detail: durationMin < 60 ? `~${durationMin} min` : `~${(durationMin / 60).toFixed(1)} hr`,
      },
      {
        heuristic: 'file_count',
        value: files,
        level: files <= 3 ? 'green' : files <= 10 ? 'amber' : 'red',
        detail: `~${files} files`,
      },
      {
        heuristic: 'change_entropy',
        value: entropy,
        level: entropy <= 1 ? 'green' : entropy <= 2 ? 'amber' : 'red',
        detail: `${entropy} module${entropy !== 1 ? 's' : ''}`,
      },
      {
        heuristic: 'architectural_scope',
        value: scope,
        level: scope === 'localized' ? 'green' : 'amber',
        detail: scope === 'localized' ? 'Localized change' : 'Architectural — crosses module boundaries',
      },
    ];
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

  /**
   * Returns the applicable checks for a given flow type.
   * Some checks are irrelevant for certain flows (e.g., acceptance criteria
   * for exploration) and are omitted so they don't penalise the score.
   * Flow-specific checks are appended after the global ones.
   */
  private runChecksForFlow(task: TaskPayload, flowType?: FlowType): ReadinessCheck[] {
    // Checks to skip per flow type (by rule name)
    const SKIP: Record<string, string[]> = {
      debug:       ['has_acceptance_criteria'],
      feature:     [],
      refactor:    ['has_acceptance_criteria'],
      exploration: ['has_acceptance_criteria', 'has_verification_command', 'dependencies_resolved', 'risk_classified'],
      assessment:  ['has_acceptance_criteria', 'has_verification_command', 'dependencies_resolved', 'risk_classified'],
    };

    const skipRules = flowType ? (SKIP[flowType] ?? []) : [];
    const global = this.runGlobalChecks(task).filter(c => !skipRules.includes(c.rule));

    // Flow-specific checks
    const extra: ReadinessCheck[] = [];
    if (flowType === 'exploration') extra.push(this.checkExplorationQuestionClear(task));
    if (flowType === 'assessment')  extra.push(this.checkAssessmentScopeDefined(task));

    return [...global, ...extra];
  }

  private checkExplorationQuestionClear(task: TaskPayload): ReadinessCheck {
    const text = `${task.description} ${task.instructions ?? ''}`;
    const hasQuestion = /\?/.test(text);
    const hasEvidenceLanguage = /\b(is\s+.+possible|can\s+.+be\s+done|does\s+.+support|evidence\s+would|would\s+constitute|feasib|viable)\b/i.test(text);

    return {
      rule: 'exploration_question_clear',
      source: 'global',
      binding: 'required',
      passed: hasQuestion || hasEvidenceLanguage,
      detail: hasQuestion
        ? 'Exploration question identified (contains "?")'
        : hasEvidenceLanguage
          ? 'Evidence language found — question is answerable'
          : 'No clear exploration question found. Rephrase as "Is X possible?" or define what evidence would constitute an answer.',
    };
  }

  private checkAssessmentScopeDefined(task: TaskPayload): ReadinessCheck {
    const text = `${task.description} ${task.instructions ?? ''}`.toLowerCase();
    const hasDimension = /\b(correctness|performance|maintainability|security|coverage|stability|test|latency|throughput|complexity|debt|vulnerability)\b/.test(text);
    const hasSection = /\b(module|component|section|service|layer|package|file|class|function|endpoint|route)\b/.test(text);

    return {
      rule: 'assessment_scope_defined',
      source: 'global',
      binding: 'required',
      passed: hasDimension && hasSection,
      detail: hasDimension && hasSection
        ? 'Section and assessment dimension both identified'
        : !hasSection
          ? 'No section or component specified. Name what is being assessed.'
          : 'No assessment dimension specified. Add at least one: correctness, performance, maintainability, security, coverage, or stability.',
    };
  }

  private checkAcceptanceCriteria(task: TaskPayload): ReadinessCheck {
    const hasChecks = task.checks && task.checks.length > 0;
    const hasMeasurableOutcomes = /(?:should|must|expect|assert|verify|return|output|produce|pass|fail)/i.test(task.instructions ?? '');

    return {
      rule: 'has_acceptance_criteria',
      source: 'global',
      binding: 'required',
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
      binding: 'required',
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
      binding: 'required',
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
      binding: 'waivable',
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
      binding: 'waivable',
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

    // Compute global score: proportion of passed checks (required/waivable weighted more)
    const requiredChecks = checks.filter(c => c.binding === 'required');
    const waivableChecks = checks.filter(c => c.binding === 'waivable');
    const advisoryChecks = checks.filter(c => c.binding === 'advisory');

    const requiredPassed = requiredChecks.filter(c => c.passed).length;
    const waivablePassed = waivableChecks.filter(c => c.passed).length;
    const advisoryPassed = advisoryChecks.filter(c => c.passed).length;

    // Required checks worth 1.0, waivable 0.75, advisory 0.5
    const totalWeight = requiredChecks.length + waivableChecks.length * 0.75 + advisoryChecks.length * 0.5;
    const passedWeight = requiredPassed + waivablePassed * 0.75 + advisoryPassed * 0.5;
    assessment.globalScore = totalWeight > 0 ? passedWeight / totalWeight : 1.0;

    // dynamicScore is 1.0 in Phase 1 (no dynamic gate configured)
    assessment.dynamicScore = 1.0;

    // Composite
    assessment.compositeScore =
      assessment.globalWeight * assessment.globalScore +
      (1 - assessment.globalWeight) * assessment.dynamicScore;

    // Check pass condition
    const allRequiredPassed = requiredChecks.every(c => c.passed);

    if (this.config.gateMode === 'hard-block') {
      if (allRequiredPassed && assessment.compositeScore >= this.config.readinessThreshold) {
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
