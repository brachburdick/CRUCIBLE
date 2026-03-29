/**
 * StrategySelector — Pure decision tree for decomposition strategy suggestion.
 *
 * Consumes deep analysis heuristic checks and task intent, produces a
 * strategy suggestion (D0 or D4). D5 is never suggested — it's a runtime
 * escalation strategy, not a pre-flight choice.
 *
 * Fully deterministic, no side effects, no imports beyond types.
 */

// ─── Types ───

export interface DeepCheck {
  heuristic: 'estimated_duration' | 'file_count' | 'change_entropy' | 'architectural_scope';
  value: string | number;
  level: 'green' | 'amber' | 'red';
  detail: string;
  evidence?: string;
}

export interface CascadeInput {
  checks: DeepCheck[];
  taskIntent: 'implementation' | 'diagnostic';
}

export interface CascadeResult {
  suggested: 'D0' | 'D4';
  reason: string;
  flags: {
    humanReviewRecommended: boolean;
    planningFirstSubtask: boolean;
  };
}

// ─── Helpers ───

function findCheck(checks: DeepCheck[], heuristic: DeepCheck['heuristic']): DeepCheck | undefined {
  return checks.find(c => c.heuristic === heuristic);
}

function numericValue(check: DeepCheck | undefined): number {
  if (!check) return 0;
  return typeof check.value === 'number' ? check.value : parseFloat(String(check.value)) || 0;
}

// ─── Decision Tree (spec §4.1) ───

export function selectStrategy(input: CascadeInput): CascadeResult {
  const { checks, taskIntent } = input;

  // 1. Diagnostic task → D0
  if (taskIntent === 'diagnostic') {
    return {
      suggested: 'D0',
      reason: 'Diagnostic tasks need freedom to follow leads',
      flags: { humanReviewRecommended: false, planningFirstSubtask: false },
    };
  }

  const duration = findCheck(checks, 'estimated_duration');
  const fileCount = findCheck(checks, 'file_count');
  const entropy = findCheck(checks, 'change_entropy');
  const scope = findCheck(checks, 'architectural_scope');

  const durationMin = numericValue(duration);
  const fileCountNum = numericValue(fileCount);
  const entropyNum = numericValue(entropy);

  // 2. Duration <30 min AND ≤3 files → D0
  if (durationMin < 30 && fileCountNum <= 3) {
    return {
      suggested: 'D0',
      reason: 'Within single-agent capability',
      flags: { humanReviewRecommended: false, planningFirstSubtask: false },
    };
  }

  // 3. Duration >4 hr → D4 + humanReviewRecommended
  if (durationMin > 240) {
    return {
      suggested: 'D4',
      reason: 'Exceeds 4-hour threshold',
      flags: { humanReviewRecommended: true, planningFirstSubtask: false },
    };
  }

  // 4. File count >10 OR entropy >2 modules → D4
  if (fileCountNum > 10 || entropyNum > 2) {
    return {
      suggested: 'D4',
      reason: 'Scale or spread exceeds single-agent window',
      flags: { humanReviewRecommended: false, planningFirstSubtask: false },
    };
  }

  // 5. Architectural scope → D4 + planningFirstSubtask
  if (scope && (scope.value === 'architectural' || scope.level === 'amber' || scope.level === 'red')) {
    return {
      suggested: 'D4',
      reason: 'Architectural tasks benefit from approach documentation first',
      flags: { humanReviewRecommended: false, planningFirstSubtask: true },
    };
  }

  // 6. Default → D0
  return {
    suggested: 'D0',
    reason: 'No decomposition signals',
    flags: { humanReviewRecommended: false, planningFirstSubtask: false },
  };
}
