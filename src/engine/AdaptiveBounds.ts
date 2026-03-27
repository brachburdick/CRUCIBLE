/**
 * AdaptiveBounds — Decomposition stop conditions.
 *
 * Checks whether a node should be decomposed further or treated as a leaf.
 * Any single condition triggering "stop" halts further decomposition.
 */

import type { DecompositionNode } from '../types/graph.js';
import { estimateComplexity } from './ComplexityEstimator.js';

export interface BoundsConfig {
  max_depth: number;                    // default: 3
  max_files_hint: number;              // soft, default: 3
  three_conditions: boolean;
  compositionality_check: boolean;
}

export const DEFAULT_BOUNDS: BoundsConfig = {
  max_depth: 3,
  max_files_hint: 3,
  three_conditions: true,
  compositionality_check: true,
};

export interface BoundsResult {
  stop: boolean;
  reason: string;
}

export function shouldStopDecomposing(
  node: DecompositionNode,
  depth: number,
  config: BoundsConfig = DEFAULT_BOUNDS,
): BoundsResult {
  // 1. Depth limit reached
  if (depth >= config.max_depth) {
    return { stop: true, reason: `Depth limit reached (${depth}/${config.max_depth})` };
  }

  // 2. Complexity estimate is "simple"
  if (node.complexityEstimate === 'simple') {
    return { stop: true, reason: 'Node complexity is "simple" — no further decomposition needed' };
  }

  // 3. Three Conditions check: can the node be split into independent, mergeable pieces?
  if (config.three_conditions) {
    // A leaf with a single owned path and single acceptance criterion
    // is unlikely to benefit from further splitting
    if (node.ownedPaths.length <= 1 && node.acceptanceCriteria.length <= 1) {
      return {
        stop: true,
        reason: 'Three Conditions: node has single file and single criterion — cannot split into independent pieces',
      };
    }
  }

  // 4. 100% acceptance criteria coverage
  // If the node already has all criteria assigned to children, stop
  // (This is checked at the graph level, but we can do a basic check here)
  if (node.acceptanceCriteria.length === 0) {
    return { stop: true, reason: '100% coverage: no acceptance criteria to distribute' };
  }

  // 5. Files within hint range — soft signal
  if (node.ownedPaths.length <= config.max_files_hint && node.ownedPaths.length > 0) {
    // Not a hard stop, but a signal. We only stop if also simple/single criterion
    // (already handled above). Continue decomposition for now.
  }

  // No stop conditions met
  return { stop: false, reason: '' };
}
