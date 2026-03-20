# Handoff Packet: TASK-015

> Status: APPROVED
> Project Root: /Users/brach/Documents/THE_FACTORY/projects/CRUCIBLE
> Revision Of: none
> Supersedes: none
> Superseded By: none

## Dispatch
- Mode: ORCHESTRATOR DISPATCH
- Output path: `specs/feat-mvp-sandbox/session-TASK-015.md`
- Parallel wave: D-parallel (TASK-010 + TASK-015 can run concurrently)

## Objective
Write a comprehensive README.md documenting project purpose, setup, CLI usage, env vars, exit codes, architecture overview, and kill switch priority order — so a new operator can set up and run CRUCIBLE from scratch.

## Role
Developer

## Working Directory
- Run from: `/Users/brach/Documents/THE_FACTORY/projects/CRUCIBLE`
- Related feature/milestone: Phase 1 MVP — Phase D (CLI + Wiring)

## Scope Boundary
- Files this agent MAY create/modify:
  - `README.md` (overwrite the existing stub)
- Files this agent must NOT touch:
  - Any `src/` file
  - `package.json`
  - `tsconfig.json`
  - Any `specs/` file (except writing session summary)

## Context Files
- `AGENT_BOOTSTRAP.md`
- `preambles/COMMON_RULES.md`
- `preambles/DEVELOPER.md`
- `specs/feat-mvp-sandbox/spec.md` — full technical requirements, interface definitions, kill switch priority
- `specs/feat-mvp-sandbox/plan.md` — layer interaction diagram, middleware stack order, TTL strategy
- `.env.example` — all environment variables with current names
- `src/cli/run.ts` — CLI flags and usage (read-only reference)
- `package.json` — project metadata, bin entry, dependencies

## Interface Contracts
- none (documentation task)

## Required Output
- Write: `specs/feat-mvp-sandbox/session-TASK-015.md`
- Documentation file: `README.md`

## Constraints
- The README must be accurate to the current implementation — read `src/cli/run.ts` and `.env.example` before writing. Do not guess CLI flags or env var names.
- Do NOT document features that don't exist yet (no Phase 2 content, no comparison mode, no dashboard).
- Keep the tone practical and operator-focused — this is a tool for running agent evaluations, not a marketing page.
- Exit codes section must match the implemented values: 0 = completed, 1 = budget_exceeded, 2 = loop_detected, 3 = ttl_exceeded.
- Kill switch priority order from spec: Token Budget > Loop Detector > TTL (budget fires first because it checks after each call; loop fires before each call but embedding latency means budget usually wins on the same turn; TTL is wall-clock backstop).
- `npx tsc --noEmit` must still pass (README changes shouldn't affect this, but verify).

## README Structure (suggested, not mandatory)
1. **Project title + one-line description**
2. **Prerequisites** — Node.js 18+, E2B account, Langfuse instance, OpenAI API key, Anthropic API key
3. **Setup** — clone, `npm install`, copy `.env.example` to `.env`, fill in keys
4. **Usage** — `npx crucible run --task <file> --variant <label> --budget <tokens> --ttl <seconds>`
5. **Environment Variables** — table with name, description, default
6. **Exit Codes** — table with code, meaning
7. **Architecture Overview** — brief description of layers (sandbox, middleware, telemetry, CLI), mention LLM calls are host-side
8. **Kill Switches** — priority order, what each does, how they converge on teardown
9. **Project Structure** — directory tree overview
10. **Output** — what goes into `./runs/<runId>/`

## Acceptance Criteria
- [ ] Documents: project purpose, prerequisites (Node.js, E2B account, Langfuse instance, OpenAI key)
- [ ] Documents: setup steps (`npm install`, `.env` configuration)
- [ ] Documents: all env vars with descriptions and defaults
- [ ] Documents: CLI usage with all flags and examples
- [ ] Documents: exit codes and their meanings
- [ ] Documents: project structure overview
- [ ] Documents: kill switch priority order
- [ ] `npx tsc --noEmit` passes with zero errors
- [ ] All pre-existing tests pass

## Dependencies
- Requires completion of: TASK-009 (COMPLETE)
- Blocks: none

## Open Questions
- none
