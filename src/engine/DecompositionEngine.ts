/**
 * DecompositionEngine — Core engine with pluggable strategy interface.
 *
 * Strategies are registered by name. The engine dispatches to the
 * named strategy and returns a DecompositionGraph.
 */

import type { TaskPayload, LlmCallFn } from '../types/index.js';
import type { DecompositionGraph } from '../types/graph.js';
import type { ReadinessGate } from './ReadinessGate.js';

export interface DecompositionStrategy {
  name: string;
  decompose(
    task: TaskPayload,
    context: DecompositionContext,
  ): Promise<DecompositionGraph>;
}

export interface DecompositionContext {
  llmCall: LlmCallFn;
  readinessGate: ReadinessGate;
  config: DecompositionStrategyConfig;
}

export interface DecompositionStrategyConfig {
  decomposition_trigger: 'preemptive' | 'on-failure' | 'hybrid';
  max_depth: number;
  max_files_hint: number;
  three_conditions: boolean;
  compositionality_check: boolean;
}

export const DEFAULT_STRATEGY_CONFIG: DecompositionStrategyConfig = {
  decomposition_trigger: 'hybrid',
  max_depth: 3,
  max_files_hint: 3,
  three_conditions: true,
  compositionality_check: true,
};

export class DecompositionEngine {
  private strategies: Map<string, DecompositionStrategy>;

  constructor(strategies: Map<string, DecompositionStrategy>) {
    this.strategies = strategies;
  }

  async decompose(
    task: TaskPayload,
    strategyName: string,
    context: DecompositionContext,
  ): Promise<DecompositionGraph> {
    const strategy = this.strategies.get(strategyName);
    if (!strategy) {
      const available = Array.from(this.strategies.keys()).join(', ');
      throw new Error(`Unknown decomposition strategy "${strategyName}". Available: ${available}`);
    }
    return strategy.decompose(task, context);
  }

  getStrategyNames(): string[] {
    return Array.from(this.strategies.keys());
  }

  hasStrategy(name: string): boolean {
    return this.strategies.has(name);
  }
}
