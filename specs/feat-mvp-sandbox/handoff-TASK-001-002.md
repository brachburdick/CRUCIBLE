# Handoff Packet: TASK-001 + TASK-002 (Phase A Foundation)

## Objective
Create the type definitions and project scaffolding that all subsequent tasks depend on. When done, `npm install && npx tsc --noEmit` must succeed and all shared types must be exported.

## Role
Developer

## Scope Boundary
- Files this agent MAY read/modify:
  - `src/types/index.ts`
  - `package.json`
  - `tsconfig.json`
  - `.env.example`
  - `.gitignore`
  - `src/**/*.ts` (creating empty barrel files for directory structure only)
- Files this agent must NOT touch:
  - `specs/**` (read-only)
  - `preambles/**` (read-only)
  - `templates/**` (read-only)
  - `docs/**` (read-only)
  - `skills/**` (read-only)

## Context Files
- `AGENT_BOOTSTRAP.md`
- `preambles/COMMON_RULES.md`
- `preambles/DEVELOPER.md`
- `skills/typescript-node.md`
- `specs/feat-mvp-sandbox/spec.md` — **Interface Definitions section has the exact TypeScript types to implement**
- `specs/feat-mvp-sandbox/tasks.md` — TASK-001 and TASK-002 acceptance criteria
- `specs/feat-mvp-sandbox/plan.md` — resolved decisions (especially D4: commander)

## Constraints
- TypeScript strict mode, `module: "NodeNext"`, `moduleResolution: "NodeNext"`
- No framework — library + CLI only
- All imports must use explicit `.js` extensions (NodeNext requirement)
- Types file must be pure definitions — no logic, no imports from other project layers
- `BudgetExceededError` and `LoopDetectedError` must extend `Error` with typed fields
- `KillReason` must be a discriminated union on the `type` field
- `RunResult.metadata` must be optional `Record<string, unknown>` (Phase 2 extensibility)

## Acceptance Criteria

### TASK-001: Type Definitions
- [ ] All types from spec.md Interface Definitions section are exported from `src/types/index.ts`
- [ ] `BudgetExceededError` and `LoopDetectedError` extend `Error` with typed fields
- [ ] `KillReason` is a discriminated union on `type` field
- [ ] `RunResult.metadata` is optional `Record<string, unknown>`
- [ ] File compiles under strict mode with no errors
- [ ] If this session adds or modifies any interface values or fields, update the project's interface contract documentation — or flag `[INTERFACE IMPACT]` and stop.

### TASK-002: Project Scaffolding
- [ ] `tsconfig.json` has `strict: true`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`
- [ ] `package.json` declares dependencies: `e2b`, `@langfuse/langfuse`, `openai`, `commander`
- [ ] `package.json` declares `"bin": { "crucible": "./dist/cli/run.js" }`
- [ ] `.env.example` lists all 11 env vars with comments
- [ ] `.gitignore` includes `runs/`, `node_modules/`, `dist/`, `.env`
- [ ] Directory structure exists: `src/sandbox/`, `src/middleware/`, `src/telemetry/`, `src/cli/`, `src/types/`, `runs/`, `tasks/`
- [ ] `npm install` succeeds
- [ ] `npx tsc --noEmit` succeeds
- [ ] All pre-existing tests pass

## Dependencies
- Requires completion of: none
- Blocks: TASK-003, TASK-004, TASK-005, TASK-006 (all Phase B leaf layers)

## Open Questions
None — all decisions resolved.
