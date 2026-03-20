# Handoff Packet: TASK-009

> Status: APPROVED
> Project Root: /Users/brach/Documents/THE_FACTORY/projects/CRUCIBLE
> Revision Of: none
> Supersedes: none
> Superseded By: none

## Dispatch
- Mode: ORCHESTRATOR DISPATCH
- Output path: `specs/feat-mvp-sandbox/session-TASK-009.md`
- Parallel wave: none

## Objective
Wire all completed layers (sandbox, middleware, telemetry, teardown) into a working CLI entrypoint at `src/cli/run.ts` so that `npx crucible run` executes a full sandboxed agent run with all kill switches active.

## Role
Developer

## Working Directory
- Run from: `/Users/brach/Documents/THE_FACTORY/projects/CRUCIBLE`
- Related feature/milestone: Phase 1 MVP — Phase D (CLI + Wiring)

## Scope Boundary
- Files this agent MAY create/modify:
  - `src/cli/run.ts` (main deliverable — new file)
  - `src/cli/index.ts` (update barrel export)
- Files this agent must NOT touch:
  - `src/types/index.ts`
  - `src/sandbox/runner.ts`
  - `src/sandbox/teardown.ts`
  - `src/middleware/*.ts`
  - `src/telemetry/tracer.ts`
  - `package.json` (commander is already declared)
  - `tsconfig.json`

## Context Files
- `AGENT_BOOTSTRAP.md`
- `preambles/COMMON_RULES.md`
- `preambles/DEVELOPER.md`
- `specs/feat-mvp-sandbox/spec.md`
- `specs/feat-mvp-sandbox/plan.md` (Layer Interaction Diagram, TTL Strategy)
- `specs/feat-mvp-sandbox/tasks.md` (TASK-009 acceptance criteria)
- `src/types/index.ts` — all type contracts
- `src/sandbox/runner.ts` — `SandboxRunner.create(config)`, `.getToolContext()`, `.flushArtifacts(runId)`, `.destroy()`
- `src/sandbox/teardown.ts` — `teardown(context, killReason)`, `createIdempotentTeardown(context)`, `TeardownContext`
- `src/middleware/tokenBudget.ts` — `createTokenBudget({ budget, onWarning })` returns `{ middleware, getTokenCount }`
- `src/middleware/loopDetector.ts` — `createLoopDetector(config)` returns `Middleware`
- `src/middleware/stack.ts` — `composeMiddleware(base, ...middlewares)` returns `LlmCallFn`
- `src/telemetry/tracer.ts` — `RunTracer.create(runConfig)`, `.getRunId()`, `.createTracerMiddleware()`, `.close(killReason, tokenCount)`, `.traceMiddlewareEvent(event)`

## Interface Contracts
- `AgentFn = (llmCall: LlmCallFn, tools: ToolContext) => Promise<AgentOutput>` — the agent receives a middleware-wrapped LlmCallFn and a ToolContext. The CLI must construct both.
- `TeardownContext = { sandboxRunner, tracer, getTokenCount, runConfig, startedAt }` — all fields must be populated before creating the idempotent teardown.
- `KillReason` discriminated union has four variants: `completed`, `budget_exceeded`, `loop_detected`, `ttl_exceeded`. CLI must map each error/condition to the correct variant.
- Middleware composition order: `composeMiddleware(baseLlmCall, tracerMW, tokenBudgetMW, loopDetectorMW)` → call chain: loopDetector → tokenBudget → tracer → baseLlmCall.

## Required Output
- Write: `specs/feat-mvp-sandbox/session-TASK-009.md`
- Source file: `src/cli/run.ts`

## Constraints
- `src/cli/run.ts` must include the shebang `#!/usr/bin/env node` as the first line (bin entry points to `dist/cli/run.js`).
- All LLM calls must be async — no blocking.
- The `baseLlmCall` function (the raw LLM API call) must be defined in this file. It should use the Anthropic SDK or a simple fetch to the Anthropic messages API (ANTHROPIC_API_KEY from env). The exact implementation is up to the Developer, but it MUST conform to `LlmCallFn` signature: `(messages: LlmMessage[], options?: LlmCallOptions) => Promise<LlmResponse>`.
- Use `createIdempotentTeardown(context)` to create a single teardown function that is safely callable from multiple code paths (TTL setTimeout, error catch blocks, clean completion).
- The agent function is currently hardcoded — import it from a known path. For TASK-009, a placeholder/stub agent is acceptable: `const agent: AgentFn = async (llmCall, tools) => ({ finalMessage: 'stub' })`. TASK-010 will provide the real agent.
- `dotenv` is NOT a dependency. Use `process.env` directly. The operator loads env vars before running.
- Exit codes: 0 = completed, 1 = budget_exceeded, 2 = loop_detected, 3 = ttl_exceeded.
- Must compile under `npx tsc --noEmit` with zero errors.

## Cross-Cutting Notes (from prior phases — must account for all)
1. **Token usage breakdown**: `teardown.ts` sets `promptTokens: 0, completionTokens: 0, totalTokens: getTokenCount()` because the token budget handle only exposes a cumulative total. No action needed in CLI — just be aware.
2. **`createIdempotentTeardown(context)`**: Wraps teardown with a once-only guard. CLI MUST use this to safely pass the same teardown function to TTL setTimeout AND error catch blocks.
3. **`tracer.getRunId()`**: CLI must call this after creating the tracer to get the run ID for logging.
4. **`createTokenBudget()` returns `{ middleware, getTokenCount }`**: CLI must destructure — `middleware` goes into `composeMiddleware`, `getTokenCount` goes into `TeardownContext`.
5. **`composeMiddleware(base, ...middlewares)`**: Left-fold, last = outermost. Correct call: `composeMiddleware(baseLlmCall, tracerMW, tokenBudgetMW, loopDetectorMW)`.

## Wiring Sequence (reference — from plan.md Layer Interaction Diagram)
```
1. Parse CLI args (commander): --task, --variant, --budget, --ttl
2. Read and validate TaskPayload JSON from --task file
3. Build RunConfig from args + env defaults
4. Create RunTracer (root Langfuse trace) → tracer.getRunId()
5. Create SandboxRunner (E2B instance)
6. Create token budget → { middleware: tokenBudgetMW, getTokenCount }
7. Create loop detector → loopDetectorMW
8. Create tracer middleware → tracerMW = tracer.createTracerMiddleware()
9. Compose: wrappedLlmCall = composeMiddleware(baseLlmCall, tracerMW, tokenBudgetMW, loopDetectorMW)
10. Build ToolContext from SandboxRunner → sandboxRunner.getToolContext()
11. Build TeardownContext → { sandboxRunner, tracer, getTokenCount, runConfig, startedAt }
12. Create safeTeardown = createIdempotentTeardown(teardownContext)
13. Set TTL setTimeout → on fire: safeTeardown({ type: 'ttl_exceeded', wallTimeMs, ttlMs })
14. Call agent(wrappedLlmCall, toolContext)
15. On success: safeTeardown({ type: 'completed' }) → exit 0
16. On BudgetExceededError: safeTeardown({ type: 'budget_exceeded', tokenCount, budget }) → exit 1
17. On LoopDetectedError: safeTeardown({ type: 'loop_detected', similarityScore, consecutiveCount, lastMessages }) → exit 2
18. TTL fires: safeTeardown({ type: 'ttl_exceeded', ... }) → exit 3
19. Clear TTL timer on any teardown completion
```

## Acceptance Criteria
- [ ] Parses: `--task <file>`, `--variant <label>`, `--budget <tokens>`, `--ttl <seconds>`
- [ ] Falls back to env defaults for `--budget` (`DEFAULT_TOKEN_BUDGET`) and `--ttl` (`DEFAULT_TTL_SECONDS`)
- [ ] Falls back to env defaults for loop detection config (`LOOP_WINDOW_SIZE`, `LOOP_SIMILARITY_THRESHOLD`, `LOOP_CONSECUTIVE_TURNS`)
- [ ] Reads and validates task payload JSON from `--task` file path
- [ ] Instantiates: `SandboxRunner`, `RunTracer`, token budget middleware, loop detector middleware
- [ ] Composes middleware stack in correct order via `composeMiddleware`
- [ ] Sets application-level TTL via `setTimeout` that triggers teardown with `ttl_exceeded`
- [ ] Catches `BudgetExceededError` → teardown with `budget_exceeded`
- [ ] Catches `LoopDetectedError` → teardown with `loop_detected`
- [ ] On clean agent completion → teardown with `completed`
- [ ] Streams log output to terminal (console.log for events, structured JSON for kill events)
- [ ] Exit codes: 0 = completed, 1 = budget_exceeded, 2 = loop_detected, 3 = ttl_exceeded
- [ ] Uses `createIdempotentTeardown` — not raw `teardown()`
- [ ] `npx tsc --noEmit` passes with zero errors
- [ ] All pre-existing tests pass

## Dependencies
- Requires completion of: TASK-001, TASK-002, TASK-003, TASK-004, TASK-005, TASK-006, TASK-007, TASK-008 (all COMPLETE)
- Blocks: TASK-010, TASK-011, TASK-012, TASK-013, TASK-014, TASK-015

## Open Questions
- none
