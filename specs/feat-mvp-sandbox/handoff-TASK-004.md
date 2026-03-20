# Handoff Packet: TASK-004

## Objective
Implement a token budget middleware that wraps any `LlmCallFn`, tracks token usage per run, emits warnings at 50%/80%, and throws `BudgetExceededError` at 100%.

## Role
Developer

## Scope Boundary
- Files this agent MAY read/modify:
  - `src/middleware/tokenBudget.ts` (create)
  - `src/middleware/index.ts` (update barrel export)
- Files this agent must NOT touch:
  - `src/types/index.ts`
  - `src/sandbox/*`
  - `src/telemetry/*`
  - `src/cli/*`
  - `package.json`
  - `tsconfig.json`

## Context Files
- `AGENT_BOOTSTRAP.md`
- `preambles/COMMON_RULES.md`
- `preambles/DEVELOPER.md`
- `specs/feat-mvp-sandbox/spec.md` (TR-3, Layer Boundaries, Constraints, Edge Cases — budget overshoot)
- `specs/feat-mvp-sandbox/plan.md` (Middleware Stack Order)
- `specs/feat-mvp-sandbox/tasks.md` (TASK-004 section)
- `src/types/index.ts`
- `skills/typescript-node.md`

## Constraints
- TypeScript strict mode, NodeNext module resolution. Use `.js` extensions in all relative imports.
- All code must be async.
- The middleware layer does NOT know about E2B or Langfuse. No imports from `src/sandbox/` or `src/telemetry/`.
- Must conform to the `Middleware` type: `(next: LlmCallFn) => LlmCallFn`.
- Must wrap any `LlmCallFn` without requiring changes to agent internals — the agent doesn't know it's being metered.
- Token counting uses `response.usage.promptTokens + response.usage.completionTokens` from the LLM response (after the call).
- Warning callbacks must fire at most once each (50% fires once, 80% fires once).
- No cross-run state — new closure per `createTokenBudget` call.
- Must expose `getTokenCount()` for teardown reporting.

## Acceptance Criteria
- [ ] `createTokenBudget({ budget, onWarning })` returns a `Middleware` function
- [ ] Wraps any `LlmCallFn` — does not require changes to agent internals
- [ ] Maintains a rolling token counter scoped to the closure (per-run)
- [ ] After each LLM call, adds `response.usage.promptTokens + response.usage.completionTokens` to counter
- [ ] At 50% of budget: calls `onWarning('50%', currentCount, budget)` — continue execution
- [ ] At 80% of budget: calls `onWarning('80%', currentCount, budget)` — continue execution
- [ ] At 100% of budget: throws `BudgetExceededError` with current count and budget
- [ ] Warning callbacks fire at most once each (50% fires once, 80% fires once)
- [ ] Exposes `getTokenCount()` for teardown reporting
- [ ] No cross-run state — new closure per `createTokenBudget` call
- [ ] `npx tsc --noEmit` passes
- [ ] All pre-existing tests pass

## Dependencies
- Requires completion of: TASK-001, TASK-002 (COMPLETE)
- Blocks: TASK-007 (middleware stack composer)

## Open Questions
None — all resolved. Budget overshoot behavior documented in spec.md Edge Cases.
