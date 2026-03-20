# Handoff Packet: TASK-008

## Objective
Implement the single convergent teardown function that all kill paths (budget, loop, TTL, clean completion) use to flush artifacts, close the trace, destroy the sandbox, and write the result JSON.

## Role
Developer

## Scope Boundary
- Files this agent MAY read/modify:
  - `src/sandbox/teardown.ts` (create)
  - `src/sandbox/index.ts` (update barrel export)
- Files this agent must NOT touch:
  - `src/types/index.ts`
  - `src/sandbox/runner.ts`
  - `src/middleware/*`
  - `src/telemetry/*`
  - `src/cli/*`
  - `package.json`
  - `tsconfig.json`

## Context Files
- `AGENT_BOOTSTRAP.md`
- `preambles/COMMON_RULES.md`
- `preambles/DEVELOPER.md`
- `specs/feat-mvp-sandbox/spec.md` (TR-6, Layer Boundaries, Edge Cases — Langfuse flush failure, TTL during flush)
- `specs/feat-mvp-sandbox/plan.md` (Layer Interaction Diagram — teardown sequence)
- `specs/feat-mvp-sandbox/tasks.md` (TASK-008 section)
- `src/types/index.ts`
- `src/sandbox/runner.ts` (SandboxRunner API — read only)
- `src/telemetry/tracer.ts` (RunTracer API — read only)
- `skills/e2b-sandbox.md`
- `skills/langfuse-tracing.md`
- `skills/typescript-node.md`

## Constraints
- TypeScript strict mode, NodeNext module resolution. Use `.js` extensions in all relative imports.
- All code must be async.
- The teardown function receives its dependencies as a context object — it does NOT instantiate SandboxRunner or RunTracer itself.
- The teardown sequence must execute in this EXACT order:
  1. Log `KillEvent` JSON to stdout via `console.log(JSON.stringify(killEvent))`
  2. Call `sandboxRunner.flushArtifacts(runId)` to download artifacts
  3. Call `tracer.close(killReason, tokenCount)` to close trace and flush
  4. Call `sandboxRunner.destroy()` to destroy E2B sandbox
  5. Write `RunResult` JSON to `./runs/<runId>/result.json`
- Each step must be wrapped in try/catch — if any step fails, log the error and continue to the next step. Teardown must NEVER throw. A partial teardown is better than an aborted one.
- Teardown must be **idempotent** — calling it twice must not error.
- `RunResult` must be fully populated with timing, token usage, kill reason, and artifact manifest.
- Create `./runs/<runId>/` directory if it doesn't exist.

## Important API Notes from Phase B
- **`SandboxRunner`** (`src/sandbox/runner.ts`):
  - `flushArtifacts(runId: string): Promise<ArtifactManifest>` — downloads files to `./runs/<runId>/artifacts/`, returns manifest
  - `destroy(): Promise<void>` — idempotent, kills E2B sandbox
- **`RunTracer`** (`src/telemetry/tracer.ts`):
  - `getRunId(): string` — returns the run ID (generated at create time via `crypto.randomUUID()`)
  - `close(killReason: KillReason, tokenCount: number): Promise<void>` — closes root span, flushes Langfuse; logs error on flush failure but does not throw
- **`TokenBudgetHandle`** (`src/middleware/tokenBudget.ts`):
  - `getTokenCount(): number` — returns cumulative tokens consumed (the teardown function needs this for `RunResult.tokenUsage`)
- The teardown function should accept a context object containing: `sandboxRunner`, `tracer`, `getTokenCount`, `runConfig`, `startedAt` (Date). The `runId` comes from `tracer.getRunId()`.

## Teardown Context Type (define in teardown.ts)
```typescript
export interface TeardownContext {
  sandboxRunner: SandboxRunner;
  tracer: RunTracer;
  getTokenCount: () => number;
  runConfig: RunConfig;
  startedAt: Date;
}
```

## Acceptance Criteria
- [ ] `teardown(context, killReason)` executes steps in the exact order specified above
- [ ] Logs `KillEvent` JSON to stdout as the first action
- [ ] Calls `sandboxRunner.flushArtifacts(runId)` to download artifacts
- [ ] Calls `tracer.close(killReason, tokenCount)` to close trace and flush
- [ ] Calls `sandboxRunner.destroy()` to destroy E2B sandbox
- [ ] Writes `RunResult` JSON to `./runs/<runId>/result.json`
- [ ] If artifact flush fails: logs error, continues teardown (does not abort)
- [ ] If tracer close fails: logs error, continues teardown (does not abort)
- [ ] If sandbox destroy fails: logs error, continues (idempotent)
- [ ] Teardown is idempotent — calling twice does not error
- [ ] `RunResult` is fully populated with timing, token usage, kill reason, and artifact manifest
- [ ] Creates `./runs/<runId>/` directory if it doesn't exist
- [ ] `npx tsc --noEmit` passes
- [ ] All pre-existing tests pass
- [ ] If this session adds or modifies any interface values or fields, update the project's interface contract documentation — or flag `[INTERFACE IMPACT]` and stop.

## Dependencies
- Requires completion of: TASK-003, TASK-007 (TASK-003 COMPLETE, TASK-007 in progress or complete)
- Blocks: TASK-009 (CLI entrypoint)

## Open Questions
None — all resolved. See spec.md Edge Cases (TTL during flush, Langfuse flush failure) and plan.md (TTL Strategy).
