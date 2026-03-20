# Session Summary: TASK-008

## Role
Developer

## Objective
Implement the single convergent teardown function that all kill paths (budget, loop, TTL, clean completion) use to flush artifacts, close the trace, destroy the sandbox, and write the result JSON. Create `src/sandbox/teardown.ts` and update the barrel export in `src/sandbox/index.ts`.

## Status
COMPLETE

## Work Performed
- Read all required bootstrap, preamble, handoff, skill, and context files before writing any code.
- Read `src/sandbox/runner.ts` and `src/telemetry/tracer.ts` to verify the exact API signatures used in teardown.
- Read `src/types/index.ts` to understand `KillEvent`, `RunResult`, `ArtifactManifest`, and `KillReason` shapes.
- Ran baseline `npx tsc --noEmit` — confirmed clean compile before making changes.
- Created `src/sandbox/teardown.ts` with:
  - `TeardownContext` interface (exported as specified in handoff).
  - `teardown(context, killReason)` function executing the five steps in the exact required order, each wrapped in try/catch with structured error logging to stderr.
  - `createIdempotentTeardown(context)` factory returning a once-only guarded wrapper — callers (CLI, TTL timer, error catches) can all call it safely without duplicating teardown.
  - `emptyManifest(runId)` private helper for the artifact flush failure case.
- Updated `src/sandbox/index.ts` to re-export `teardown`, `createIdempotentTeardown`, and the `TeardownContext` type.
- Ran `npx tsc --noEmit` post-changes — clean, zero errors.

## Files Changed
- `src/sandbox/teardown.ts` — created. Implements `TeardownContext` interface, `teardown()` function, and `createIdempotentTeardown()` factory.
- `src/sandbox/index.ts` — added barrel exports for `teardown`, `createIdempotentTeardown`, and `TeardownContext`.

## Interfaces Added or Modified
- `TeardownContext` (new, in `teardown.ts`):
  ```typescript
  export interface TeardownContext {
    sandboxRunner: SandboxRunner;
    tracer: RunTracer;
    getTokenCount: () => number;
    runConfig: RunConfig;
    startedAt: Date;
  }
  ```
- `teardown(context: TeardownContext, killReason: KillReason): Promise<void>` (new export)
- `createIdempotentTeardown(context: TeardownContext): (killReason: KillReason) => Promise<void>` (new export)

## Decisions Made

- **`tokenUsage.promptTokens` and `completionTokens` set to 0**: `getTokenCount()` from `TokenBudgetHandle` returns a cumulative total only. The prompt/completion breakdown is not available at the teardown boundary without threading additional state through the context. Setting both to 0 and populating `totalTokens` accurately is the honest choice — fabricating a 50/50 split or any split would be misleading for Phase 2 scoring. Alternative considered: add a `getTokenBreakdown()` method to context — rejected because it would require modifying `TokenBudgetHandle` (out of scope, `[INTERFACE IMPACT]` territory) and is not called for in the handoff. The Orchestrator can add breakdown tracking in a follow-up if needed.

- **`createIdempotentTeardown` exported alongside `teardown`**: The handoff requires teardown to be idempotent. A closure-level boolean guard is the cleanest mechanism — it means the CLI (TASK-009) can safely pass the same wrapper to both the TTL `setTimeout` and the error catch blocks without needing to coordinate. Alternative considered: guard inside `teardown` itself with a module-level Set keyed by `runId` — rejected because module-level state creates cross-run bleed risk (violates no-cross-run-state constraint).

- **Structured JSON error logging to stderr**: All step-failure catches emit a structured JSON object to `console.error`. This makes failures machine-parseable and consistent with the `KillEvent` format. Alternative considered: plain-text error messages — rejected for consistency with the project's structured JSON logging convention.

- **`emptyManifest` private helper**: When artifact flush fails, teardown continues with an empty manifest so `RunResult.artifacts` is always populated. Alternative considered: `null` or `undefined` for artifacts — rejected because `RunResult.artifacts` is typed as `ArtifactManifest` (non-optional).

## Scope Violations
None.

## Remaining Work
None — task is complete.

## Blocked On
None.

## Missteps
- `npm test` returned exit code 1 with "Missing script: test". This is expected — no test script exists yet in the project (integration tests are TASK-011 through TASK-014). Pre-existing state had no tests; this is not a regression.

## Learnings
- `SandboxRunner.flushArtifacts()` already calls `fs.mkdir` on `runs/<runId>/artifacts/` with `{ recursive: true }`, so the artifacts directory is always created by the flush step. However, `runs/<runId>/` itself still needs explicit creation in step 5 for `result.json` — `fs.mkdir` with `recursive: true` handles the case where it already exists without error.
- `RunTracer.close()` already has its own internal try/catch for the Langfuse flush failure case (per `tracer.ts` line 187-198). Wrapping the `tracer.close()` call in teardown's own try/catch provides an additional layer of protection against unexpected errors in the `close()` method itself outside of the flush.
