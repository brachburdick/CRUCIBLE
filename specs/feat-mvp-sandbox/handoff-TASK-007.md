# Handoff Packet: TASK-007

## Objective
Implement a `composeMiddleware` function that chains an array of `Middleware` functions onto a base `LlmCallFn`, producing a single wrapped `LlmCallFn`.

## Role
Developer

## Scope Boundary
- Files this agent MAY read/modify:
  - `src/middleware/stack.ts` (create)
  - `src/middleware/index.ts` (update barrel export)
- Files this agent must NOT touch:
  - `src/types/index.ts`
  - `src/middleware/tokenBudget.ts`
  - `src/middleware/loopDetector.ts`
  - `src/sandbox/*`
  - `src/telemetry/*`
  - `src/cli/*`
  - `package.json`
  - `tsconfig.json`

## Context Files
- `AGENT_BOOTSTRAP.md`
- `preambles/COMMON_RULES.md`
- `preambles/DEVELOPER.md`
- `specs/feat-mvp-sandbox/spec.md` (Layer Boundaries, Middleware section)
- `specs/feat-mvp-sandbox/plan.md` (Middleware Stack Order)
- `specs/feat-mvp-sandbox/tasks.md` (TASK-007 section)
- `src/types/index.ts` (Middleware type definition)
- `src/middleware/tokenBudget.ts` (for understanding Middleware contract — read only)
- `src/middleware/loopDetector.ts` (for understanding Middleware contract — read only)
- `src/telemetry/tracer.ts` (createTracerMiddleware returns Middleware — read only)
- `skills/typescript-node.md`

## Constraints
- TypeScript strict mode, NodeNext module resolution. Use `.js` extensions in all relative imports.
- The `Middleware` type is: `(next: LlmCallFn) => LlmCallFn`.
- The composition function is a pure function — no side effects, no state.
- Middlewares apply in order: **last middleware in the array is outermost** (first to execute).
- The correct call chain for CRUCIBLE is: `composeMiddleware(baseLlmCall, tracerMiddleware, tokenBudgetMiddleware, loopDetectorMiddleware)` which produces: `loopDetector → tokenBudget → tracer → baseLlmCall`.
- This means the function folds right: each middleware wraps the result of applying the previous middleware to the base.
- Must work with zero middlewares (returns base function unchanged).
- Must work with one middleware.
- Do NOT import from `src/sandbox/` or `src/telemetry/` — this is a pure middleware utility.

## Important API Notes from Phase B
- `createTokenBudget()` returns `TokenBudgetHandle { middleware, getTokenCount }` — the `.middleware` field is the `Middleware`. The caller (TASK-009 CLI) destructures this; the stack composer receives the already-extracted `Middleware` values.
- `createLoopDetector()` returns a `Middleware` directly.
- `RunTracer.createTracerMiddleware()` returns a `Middleware` directly.
- All three conform to `(next: LlmCallFn) => LlmCallFn`. The stack composer doesn't need to know about their internals.

## Acceptance Criteria
- [ ] `composeMiddleware(base, ...middlewares)` returns a single `LlmCallFn`
- [ ] Middlewares apply in order: last middleware in the array is outermost (first to execute)
- [ ] Correct composition order: `composeMiddleware(baseLlmCall, tracerMiddleware, tokenBudgetMiddleware, loopDetectorMiddleware)` produces call chain: loopDetector → tokenBudget → tracer → baseLlmCall
- [ ] Works with zero middlewares (returns base function unchanged)
- [ ] Works with one middleware
- [ ] `npx tsc --noEmit` passes
- [ ] All pre-existing tests pass

## Dependencies
- Requires completion of: TASK-004, TASK-005, TASK-006 (COMPLETE)
- Blocks: TASK-008 (teardown convergence — needs full stack for integration context)

## Open Questions
None.
