# Handoff Packet: TASK-006

## Objective
Implement the Langfuse tracer that manages a root trace per run, records child spans for LLM calls / tool calls / middleware events, and provides a `Middleware` for transparent LLM call instrumentation.

## Role
Developer

## Scope Boundary
- Files this agent MAY read/modify:
  - `src/telemetry/tracer.ts` (create)
  - `src/telemetry/index.ts` (update barrel export)
- Files this agent must NOT touch:
  - `src/types/index.ts`
  - `src/sandbox/*`
  - `src/middleware/*`
  - `src/cli/*`
  - `package.json`
  - `tsconfig.json`

## Context Files
- `AGENT_BOOTSTRAP.md`
- `preambles/COMMON_RULES.md`
- `preambles/DEVELOPER.md`
- `specs/feat-mvp-sandbox/spec.md` (TR-5, Layer Boundaries, Constraints, Edge Cases — Langfuse flush failure)
- `specs/feat-mvp-sandbox/plan.md` (Layer Interaction Diagram, Middleware Stack Order, Risk Areas — Langfuse batch flush)
- `specs/feat-mvp-sandbox/tasks.md` (TASK-006 section)
- `src/types/index.ts`
- `skills/langfuse-tracing.md`
- `skills/typescript-node.md`

## Constraints
- TypeScript strict mode, NodeNext module resolution. Use `.js` extensions in all relative imports.
- All code must be async.
- The npm package is `langfuse` (NOT `@langfuse/langfuse`). Import as `import { Langfuse } from 'langfuse';` (ESM). Auth via `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` env vars.
- Agent code must NEVER receive a reference to the tracer. The tracer is append-only by construction — it observes via the middleware wrapper and explicit `traceToolCall`/`traceMiddlewareEvent` calls from the CLI wiring layer.
- The `createTracerMiddleware()` must conform to the `Middleware` type: `(next: LlmCallFn) => LlmCallFn`. It wraps the actual LLM call with a child span recording tokens in/out, model, and latency.
- `close()` must call `langfuse.flush()` and await it. If flush fails, log the error but do NOT throw — teardown must not be blocked by telemetry failure.
- No cross-run state. Each `RunTracer.create()` call is independent.

## Acceptance Criteria
- [ ] `RunTracer.create(runConfig)` creates a root Langfuse trace with run ID, variant label, and start time
- [ ] `createTracerMiddleware()` returns a `Middleware` that wraps `LlmCallFn` with child spans (tokens in/out, model, latency)
- [ ] `traceToolCall(name, input, output, durationMs)` records a tool call child span
- [ ] `traceMiddlewareEvent(event)` records middleware events (budget warnings, loop flags) as child spans
- [ ] Agent code never receives a reference to the tracer — append-only by construction
- [ ] `close(killReason, tokenCount)` closes the root span with reason and final token count
- [ ] `close` calls `langfuse.flush()` and awaits it before returning
- [ ] If flush fails, logs error but does not throw (non-blocking teardown)
- [ ] `npx tsc --noEmit` passes
- [ ] All pre-existing tests pass
- [ ] If this session adds or modifies any interface values or fields, update the project's interface contract documentation — or flag `[INTERFACE IMPACT]` and stop.

## Dependencies
- Requires completion of: TASK-001, TASK-002 (COMPLETE)
- Blocks: TASK-007 (middleware stack composer)

## Open Questions
None — all resolved. See plan.md (Risk Areas #2: Langfuse batch flush timing).
