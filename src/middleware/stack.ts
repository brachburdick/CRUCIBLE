import type { LlmCallFn, Middleware } from '../types/index.js';

/**
 * Compose an array of middleware functions onto a base LlmCallFn, producing a
 * single wrapped LlmCallFn.
 *
 * Ordering rule: the LAST middleware in the array is the OUTERMOST wrapper —
 * it executes first when a call is made and last when the response returns.
 *
 * Example:
 *   composeMiddleware(base, tracerMW, tokenBudgetMW, loopDetectorMW)
 *   → call chain: loopDetector → tokenBudget → tracer → base
 *
 * Implementation: left-fold over the middleware array. Each middleware wraps
 * the accumulated result, so the rightmost middleware ends up as the outermost
 * layer. Works with zero middlewares (returns base unchanged) and one middleware.
 *
 * Pure function — no side effects, no state.
 */
export function composeMiddleware(
  base: LlmCallFn,
  ...middlewares: Middleware[]
): LlmCallFn {
  return middlewares.reduce<LlmCallFn>(
    (accumulated, middleware) => middleware(accumulated),
    base,
  );
}
