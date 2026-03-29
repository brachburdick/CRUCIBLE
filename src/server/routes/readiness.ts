import type { FastifyInstance } from 'fastify';
import { ReadinessGate } from '../../engine/ReadinessGate.js';
import { selectStrategy } from '../../engine/StrategySelector.js';
import type { DeepCheck, CascadeResult } from '../../engine/StrategySelector.js';
import type { TaskPayload } from '../../types/index.js';
import type { ReadinessAssessment } from '../../types/graph.js';

/** Human-readable label map for enrichment formatting */
const RULE_LABELS: Record<string, string> = {
  has_acceptance_criteria: 'Acceptance Criteria',
  has_scope_boundary: 'Scope Boundary',
  has_verification_command: 'Verification Command',
  risk_classified: 'Risk Classification',
  dependencies_resolved: 'Dependencies',
  no_ambiguous_terms: 'Ambiguous Terms',
};

/**
 * Build enriched instructions by appending operator clarifications.
 * Pure function — unit testable.
 */
export function buildEnrichedInstructions(
  instructions: string,
  enrichments: Record<string, string>,
): string {
  const entries = Object.entries(enrichments).filter(([, v]) => v.trim().length > 0);
  if (entries.length === 0) return instructions;

  const lines = entries.map(([rule, answer]) => {
    const label = RULE_LABELS[rule] ?? rule;
    return `[${label}]\n${answer}`;
  });

  const block = `\n---\nOperator clarifications (provided during pre-flight readiness check):\n\n${lines.join('\n\n')}`;
  return instructions ? `${instructions}${block}` : block.trimStart();
}

interface ReadinessRequest {
  description: string;
  instructions?: string;
  seedDir?: string;
  checks?: Array<{ name: string; type: 'exec'; command: string }>;
  enrichments?: Record<string, string>;
  deep?: boolean;
  taskIntent?: 'implementation' | 'diagnostic';
}

interface ReadinessResponse {
  assessment: ReadinessAssessment;
  passable: boolean;
  deepChecks?: DeepCheck[];
  strategy?: CascadeResult;
}

export function registerReadinessRoutes(app: FastifyInstance): void {
  const gate = new ReadinessGate({ gateMode: 'triage' });

  app.post<{ Body: ReadinessRequest }>('/api/readiness', async (request, reply) => {
    const { description, instructions, seedDir, checks, enrichments, deep, taskIntent } = request.body;

    if (!description || description.trim().length === 0) {
      return reply.code(400).send({ error: 'description is required' });
    }

    // Merge enrichments into instructions for assessment
    const mergedInstructions = enrichments
      ? buildEnrichedInstructions(instructions ?? '', enrichments)
      : (instructions ?? '');

    const taskPayload: TaskPayload = {
      description,
      instructions: mergedInstructions,
      seedDir: seedDir || undefined,
      checks: checks || undefined,
    };

    const assessment = await gate.assess(taskPayload);

    // Compute passable: all required pass, all waivable either pass or are waived
    const requiredChecks = assessment.checks.filter(c => c.binding === 'required');
    const allRequiredPass = requiredChecks.every(c => c.passed);

    const waivableChecks = assessment.checks.filter(c => c.binding === 'waivable');
    const allWaivableResolved = waivableChecks.every(c =>
      c.passed || (enrichments && enrichments[c.rule] !== undefined),
    );

    const passable = allRequiredPass && allWaivableResolved;

    const response: ReadinessResponse = { assessment, passable };

    // Deep analysis: run LLM heuristics + strategy cascade
    if (deep) {
      try {
        const deepChecks = await gate.assessDeep(taskPayload);
        response.deepChecks = deepChecks;

        if (deepChecks.length > 0) {
          const intent = taskIntent ?? 'implementation';
          response.strategy = selectStrategy({ checks: deepChecks, taskIntent: intent });
        }
      } catch {
        // Deep analysis failure is non-blocking — return fast checks only
        response.deepChecks = [];
      }
    }

    return reply.send(response);
  });
}
