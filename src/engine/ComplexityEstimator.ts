/**
 * ComplexityEstimator — Fast-path triage for decomposition routing.
 *
 * Classifies tasks as simple/moderate/complex based on signals
 * from the TaskPayload. Simple tasks skip decomposition (D0 fast path).
 */

import type { TaskPayload } from '../types/index.js';

export interface ComplexityEstimate {
  level: 'simple' | 'moderate' | 'complex';
  signals: {
    fileCount: number;
    sectionCrossings: number;
    estimatedScope: string;
    hasDependencies: boolean;
  };
}

export function estimateComplexity(task: TaskPayload): ComplexityEstimate {
  const fileCount = task.files ? Object.keys(task.files).length : 0;
  const instructionLength = (task.instructions ?? '').length;
  const checkCount = task.checks?.length ?? 0;

  // Count section crossings: distinct directory prefixes in files
  const dirs = new Set<string>();
  if (task.files) {
    for (const filePath of Object.keys(task.files)) {
      const parts = filePath.split('/');
      if (parts.length > 1) {
        dirs.add(parts[0]!);
      }
    }
  }
  const sectionCrossings = dirs.size;

  // Check for dependency indicators in instructions
  const hasDependencies = /(?:depends?\s+on|requires?|after|first|before|prerequisite|blocked)/i.test(
    task.instructions ?? ''
  );

  // Multi-step acceptance criteria
  const multiStepCriteria = checkCount >= 3;

  // Classify
  let level: ComplexityEstimate['level'];

  if (fileCount >= 5 || (sectionCrossings >= 2 && fileCount >= 3) || (multiStepCriteria && hasDependencies)) {
    level = 'complex';
  } else if (fileCount <= 1 && !hasDependencies && instructionLength < 500 && !multiStepCriteria) {
    level = 'simple';
  } else {
    level = 'moderate';
  }

  return {
    level,
    signals: {
      fileCount,
      sectionCrossings,
      estimatedScope: level,
      hasDependencies,
    },
  };
}
