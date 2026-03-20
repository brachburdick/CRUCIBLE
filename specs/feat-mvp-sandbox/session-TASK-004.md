# Session Summary: TASK-004

## Role
Developer

## Objective
Implement a token budget middleware that wraps any `LlmCallFn`, tracks token usage per run, emits warnings at 50%/80%, and throws `BudgetExceededError` at 100%.

## Status
COMPLETE

## Work Performed
- Read all bootstrap, preamble, handoff, spec, plan, tasks, and skill files before writing any code.
- Read baseline state of `src/middleware/index.ts` (one line comment only on first check; re-read after discovering TASK-005 had already run and added `loopDetector` exports).
- Ran baseline `npx tsc --noEmit` — passed with zero errors.
- Created `src/middleware/tokenBudget.ts` with `createTokenBudget` factory function.
- Added `createTokenBudget`, `TokenBudgetConfig`, and `TokenBudgetHandle` exports to `src/middleware/index.ts` without disturbing the existing `loopDetector` exports.
- Ran final `npx tsc --noEmit` — passed with zero errors.

## Files Changed
- `src/middleware/tokenBudget.ts` — Created. Implements `createTokenBudget(config)` factory returning `{ middleware, getTokenCount }`. All state is in a per-call closure; no cross-run state.
- `src/middleware/index.ts` — Added barrel exports for `createTokenBudget`, `TokenBudgetConfig`, and `TokenBudgetHandle` using `.js` extension (NodeNext requirement).

## Interfaces Added or Modified
- `TokenBudgetConfig` (new): `{ budget: number; onWarning: (threshold: '50%' | '80%', currentCount: number, budget: number) => void }`
- `TokenBudgetHandle` (new): `{ middleware: Middleware; getTokenCount: () => number }`
- `createTokenBudget(config: TokenBudgetConfig): TokenBudgetHandle` (new)

## Decisions Made
- **Return type is `TokenBudgetHandle` (object) rather than raw `Middleware`**: The handoff requires both a `Middleware` (conforming to `(next: LlmCallFn) => LlmCallFn`) and a `getTokenCount()` accessor for teardown reporting. TypeScript's `Middleware` type cannot carry extra methods. Returning a named object `{ middleware, getTokenCount }` keeps the types clean and caller usage explicit. Alternative considered: attaching `getTokenCount` as a property on the function object — rejected because it bypasses TypeScript's type system and requires casting.
- **Warning checks fire in ascending order (50% then 80%) after accumulation**: Both flags are checked in a single pass after each `tokenCount` update. A single call could cross both thresholds simultaneously (e.g., if the first call uses 90% of budget). In that case both `onWarning('50%', ...)` and `onWarning('80%', ...)` fire before the hard kill is evaluated. This matches spec intent: warnings are advisory, kill is the authoritative stop.
- **Hard kill check uses `>= 1.0` ratio**: Consistent with spec edge case documentation — overshoot is accepted. The error is thrown after `tokenCount` is updated, so the overshoot is captured in the count passed to `BudgetExceededError` and available via `getTokenCount()`.

## Scope Violations
None.

## Remaining Work
None.

## Blocked On
None.

## Missteps
- First attempt to edit `src/middleware/index.ts` failed with "file has been modified since read" — TASK-005 (loop detector) had run concurrently and added its own exports. Re-read the file and merged both export sets cleanly.

## Learnings
- Parallel task execution (TASK-003, TASK-004, TASK-005, TASK-006 are marked parallel-safe) means the barrel export file can be in a different state than what was first read. Always re-read before editing, and treat the Edit tool's rejection as a signal to check for concurrent modifications.
