# Handoff Packet: TASK-005

## Objective
Implement a semantic loop detector middleware that embeds each agent message, tracks cosine similarity in a rolling window, and throws `LoopDetectedError` when consecutive high-similarity turns exceed the threshold.

## Role
Developer

## Scope Boundary
- Files this agent MAY read/modify:
  - `src/middleware/loopDetector.ts` (create)
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
- `specs/feat-mvp-sandbox/spec.md` (TR-4, Layer Boundaries, Constraints, Edge Cases — window not full, embedding API failure)
- `specs/feat-mvp-sandbox/plan.md` (Middleware Stack Order, Risk Areas — embedding latency)
- `specs/feat-mvp-sandbox/tasks.md` (TASK-005 section)
- `src/types/index.ts`
- `skills/typescript-node.md`

## Constraints
- TypeScript strict mode, NodeNext module resolution. Use `.js` extensions in all relative imports.
- All code must be async.
- The middleware layer does NOT know about E2B or Langfuse. No imports from `src/sandbox/` or `src/telemetry/`.
- Must conform to the `Middleware` type: `(next: LlmCallFn) => LlmCallFn`.
- Must wrap any `LlmCallFn` without requiring changes to agent internals.
- Uses `text-embedding-3-small` via the OpenAI SDK for embeddings. Import as `import OpenAI from 'openai';` (ESM, `openai` package). Auth via `OPENAI_API_KEY` env var (the SDK reads it automatically).
- Cosine similarity: compute dot product of two normalized embedding vectors. OpenAI embeddings from `text-embedding-3-small` are already normalized, so cosine similarity = dot product.
- If embedding API call fails: log a warning (`console.warn`), skip that turn's similarity check, reset the consecutive counter. Do NOT crash the run.
- No similarity check until the window has at least 2 embeddings.
- No cross-run state — new closure per `createLoopDetector` call.
- The loop detector fires BEFORE the LLM call (checks the input messages), per the middleware stack order in plan.md.

## Acceptance Criteria
- [ ] `createLoopDetector({ windowSize, similarityThreshold, consecutiveTurns, onWarning })` returns a `Middleware`
- [ ] Wraps any `LlmCallFn` — does not require changes to agent internals
- [ ] Before each LLM call, embeds the last user message using `text-embedding-3-small` via OpenAI SDK
- [ ] Maintains a rolling window of the last N embeddings (configurable, default 8)
- [ ] Computes cosine similarity of new embedding against all embeddings in window
- [ ] Tracks consecutive turns where mean similarity exceeds threshold
- [ ] If consecutive high-similarity turns >= `consecutiveTurns` (default 5): throws `LoopDetectedError` with similarity score, count, and last N raw messages
- [ ] Saves last N raw messages alongside the error for diagnosis
- [ ] If embedding API call fails: logs warning, skips similarity check for that turn, resets consecutive counter
- [ ] No similarity check until window has at least 2 embeddings
- [ ] No cross-run state — new closure per `createLoopDetector` call
- [ ] `npx tsc --noEmit` passes
- [ ] All pre-existing tests pass

## Dependencies
- Requires completion of: TASK-001, TASK-002 (COMPLETE)
- Blocks: TASK-007 (middleware stack composer)

## Open Questions
None — all resolved. See plan.md (D2: Embedding API Key, Risk Areas #3).
