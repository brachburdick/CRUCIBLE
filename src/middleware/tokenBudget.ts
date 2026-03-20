import {
  BudgetExceededError,
  LlmCallFn,
  LlmCallOptions,
  LlmMessage,
  Middleware,
} from '../types/index.js';

export interface TokenBudgetConfig {
  /** Total token budget for this run */
  budget: number;
  /**
   * Called when usage crosses 50% or 80% of budget.
   * Receives the threshold label, current token count, and total budget.
   * Returning from this callback continues execution.
   */
  onWarning: (threshold: '50%' | '80%', currentCount: number, budget: number) => void;
}

export interface TokenBudgetHandle {
  /** The composable middleware to insert into the stack */
  middleware: Middleware;
  /** Returns the total tokens consumed so far — for teardown reporting */
  getTokenCount: () => number;
}

/**
 * Factory that creates a token budget middleware for a single run.
 *
 * Each call to `createTokenBudget` produces an isolated closure — no cross-run
 * state. The returned `middleware` conforms to the `Middleware` type and wraps
 * any `LlmCallFn` without requiring changes to agent internals.
 *
 * Warning callbacks fire at most once each:
 *   - `onWarning('50%', ...)` fires the first time cumulative usage >= 50 % of budget
 *   - `onWarning('80%', ...)` fires the first time cumulative usage >= 80 % of budget
 *
 * When cumulative usage reaches or exceeds 100 % of budget, `BudgetExceededError`
 * is thrown on that call's return — the overshoot is intentional (see spec edge cases).
 */
export function createTokenBudget(config: TokenBudgetConfig): TokenBudgetHandle {
  const { budget, onWarning } = config;

  // Per-run state — scoped entirely to this closure
  let tokenCount = 0;
  let warned50 = false;
  let warned80 = false;

  const middleware: Middleware = (next: LlmCallFn): LlmCallFn => {
    return async (messages: LlmMessage[], options?: LlmCallOptions) => {
      const response = await next(messages, options);

      // Accumulate usage from the response
      tokenCount += response.usage.promptTokens + response.usage.completionTokens;

      const usageRatio = tokenCount / budget;

      // 50% warning — fires at most once
      if (!warned50 && usageRatio >= 0.5) {
        warned50 = true;
        onWarning('50%', tokenCount, budget);
      }

      // 80% warning — fires at most once
      if (!warned80 && usageRatio >= 0.8) {
        warned80 = true;
        onWarning('80%', tokenCount, budget);
      }

      // Hard kill at 100%
      if (usageRatio >= 1.0) {
        throw new BudgetExceededError(tokenCount, budget);
      }

      return response;
    };
  };

  return {
    middleware,
    getTokenCount: () => tokenCount,
  };
}
