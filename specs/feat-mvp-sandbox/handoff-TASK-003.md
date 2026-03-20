# Handoff Packet: TASK-003

## Objective
Implement the E2B sandbox wrapper that manages sandbox lifecycle and exposes a `ToolContext` facade for agent tool actions.

## Role
Developer

## Scope Boundary
- Files this agent MAY read/modify:
  - `src/sandbox/runner.ts` (create)
  - `src/sandbox/index.ts` (update barrel export)
- Files this agent must NOT touch:
  - `src/types/index.ts`
  - `src/middleware/*`
  - `src/telemetry/*`
  - `src/cli/*`
  - `package.json`
  - `tsconfig.json`

## Context Files
- `AGENT_BOOTSTRAP.md`
- `preambles/COMMON_RULES.md`
- `preambles/DEVELOPER.md`
- `specs/feat-mvp-sandbox/spec.md` (Layer Boundaries, Constraints, Edge Cases — especially TTL strategy)
- `specs/feat-mvp-sandbox/plan.md` (TTL Strategy, Risk Areas)
- `specs/feat-mvp-sandbox/tasks.md` (TASK-003 section)
- `src/types/index.ts`
- `skills/e2b-sandbox.md`
- `skills/typescript-node.md`

## Constraints
- TypeScript strict mode, NodeNext module resolution. Use `.js` extensions in all relative imports.
- All methods must be async.
- The sandbox layer does NOT know about middleware or tracing. No imports from `src/middleware/` or `src/telemetry/`.
- E2B sandbox outbound network is locked by default. Apply allowlist only from `TaskPayload.networkAllowlist`.
- E2B TTL must be set to `config.ttlSeconds + 30` to allow graceful teardown before the hard backstop.
- Artifact flush must complete BEFORE sandbox destruction — download all files first, then destroy.
- `destroy()` must be idempotent — calling it on an already-destroyed sandbox is a no-op.
- No cross-run state. Each `SandboxRunner.create()` call is independent.
- Import the E2B SDK as `import { Sandbox } from 'e2b';` (ESM, `e2b` package).

## Acceptance Criteria
- [ ] `SandboxRunner.create(config)` creates an E2B sandbox with TTL = `config.ttlSeconds + 30`
- [ ] Network outbound is disabled by default; allowlist applied from `TaskPayload.networkAllowlist`
- [ ] `getToolContext()` returns a `ToolContext` with `exec`, `writeFile`, `readFile` backed by the E2B sandbox
- [ ] `flushArtifacts(runId)` downloads all files from sandbox working directory to `./runs/<runId>/`
- [ ] `flushArtifacts` returns an `ArtifactManifest` with file paths and sizes
- [ ] `destroy()` closes the E2B sandbox
- [ ] If sandbox is already destroyed, `destroy()` is a no-op (idempotent)
- [ ] All methods are async
- [ ] `npx tsc --noEmit` passes
- [ ] All pre-existing tests pass
- [ ] If this session adds or modifies any interface values or fields, update the project's interface contract documentation — or flag `[INTERFACE IMPACT]` and stop.

## Dependencies
- Requires completion of: TASK-001, TASK-002 (COMPLETE)
- Blocks: TASK-007 (middleware stack composer), TASK-008 (teardown convergence)

## Open Questions
None — all resolved. See plan.md (D3: LLM Calls Host-Side, TTL Strategy).
