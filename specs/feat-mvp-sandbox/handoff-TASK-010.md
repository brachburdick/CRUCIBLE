# Handoff Packet: TASK-010

> Status: APPROVED
> Project Root: /Users/brach/Documents/THE_FACTORY/projects/CRUCIBLE
> Revision Of: none
> Supersedes: none
> Superseded By: none

## Dispatch
- Mode: ORCHESTRATOR DISPATCH
- Output path: `specs/feat-mvp-sandbox/session-TASK-010.md`
- Parallel wave: D-parallel (TASK-010 + TASK-015 can run concurrently)

## Objective
Create two example task payload JSON files and a working test agent (`echo.ts`) that demonstrates correct use of the `AgentFn` contract, enabling integration tests in Phase E.

## Role
Developer

## Working Directory
- Run from: `/Users/brach/Documents/THE_FACTORY/projects/CRUCIBLE`
- Related feature/milestone: Phase 1 MVP — Phase D (CLI + Wiring)

## Scope Boundary
- Files this agent MAY create/modify:
  - `tasks/example-simple.json` (new file)
  - `tasks/example-looping.json` (new file)
  - `src/agents/echo.ts` (new file)
  - `src/cli/run.ts` (update stub agent import to use `src/agents/echo.ts`)
- Files this agent must NOT touch:
  - `src/types/index.ts`
  - `src/sandbox/*.ts` (except reading)
  - `src/middleware/*.ts`
  - `src/telemetry/*.ts`
  - `package.json`
  - `tsconfig.json`

## Context Files
- `AGENT_BOOTSTRAP.md`
- `preambles/COMMON_RULES.md`
- `preambles/DEVELOPER.md`
- `specs/feat-mvp-sandbox/spec.md`
- `specs/feat-mvp-sandbox/tasks.md` (TASK-010 acceptance criteria)
- `src/types/index.ts` — `TaskPayload`, `AgentFn`, `AgentOutput`, `LlmCallFn`, `LlmMessage`, `ToolContext`, `ExecResult`
- `src/cli/run.ts` — current stub agent location (lines 30–32), import structure

## Interface Contracts
- `TaskPayload` shape:
  ```typescript
  {
    description: string;
    instructions: string;
    files?: Record<string, string>;
    networkAllowlist?: string[];
  }
  ```
- `AgentFn` signature:
  ```typescript
  type AgentFn = (
    llmCall: LlmCallFn,
    tools: ToolContext
  ) => Promise<AgentOutput>;
  ```
- `AgentOutput` shape:
  ```typescript
  {
    finalMessage: string;
    artifacts?: string[];
  }
  ```
- `LlmCallFn` signature: `(messages: LlmMessage[], options?: LlmCallOptions) => Promise<LlmResponse>`
- `ToolContext` methods: `exec(cmd)`, `writeFile(path, content)`, `readFile(path)`

## Required Output
- Write: `specs/feat-mvp-sandbox/session-TASK-010.md`
- Source files: `tasks/example-simple.json`, `tasks/example-looping.json`, `src/agents/echo.ts`
- Modified file: `src/cli/run.ts` (replace stub with real agent import)

## Constraints
- The echo agent MUST use both `llmCall` and at least one `tools` method (`exec` or `writeFile`) to demonstrate the full contract. It must not be a no-op stub.
- `example-simple.json` should produce a task completable in 1–3 LLM turns (e.g., "write a haiku to a file"). Keep it simple — this is for integration testing, not benchmarking.
- `example-looping.json` must be designed to trigger the loop detector — the instructions should cause repetitive identical LLM calls (e.g., "keep asking the same question over and over").
- The agent import in `src/cli/run.ts` must replace the inline stub. Import from `'../agents/echo.js'`. Remove the stub entirely.
- `src/agents/echo.ts` must have a default export or named export `agent` of type `AgentFn`.
- `npx tsc --noEmit` must pass with zero errors.
- The `tasks/` directory already exists (created by TASK-002).
- The `src/agents/` directory does NOT exist yet — create it.

## Echo Agent Behavior (reference design)
The echo agent should implement a simple agentic loop:
1. Send the task instructions to the LLM via `llmCall` as a user message.
2. Parse the LLM response for any tool actions (or just use the response content directly).
3. Use `tools.writeFile` to write something to the sandbox (e.g., the LLM's creative output).
4. Optionally call `tools.exec` to verify the file was written (e.g., `cat` the file).
5. Return `{ finalMessage: <LLM's response or summary>, artifacts: [<written file paths>] }`.

For the looping variant: the agent should NOT have special looping logic — the *task payload instructions* should be what causes the LLM to loop. The same echo agent should work with both payloads.

## Acceptance Criteria
- [ ] `tasks/example-simple.json` is a valid `TaskPayload` that asks the agent to perform a simple task (e.g., "write a haiku to a file")
- [ ] `tasks/example-looping.json` is a valid `TaskPayload` designed to trigger loop detection (e.g., "keep asking the same question")
- [ ] `src/agents/echo.ts` exports an `AgentFn` that uses `llmCall` and `tools` to complete a simple task
- [ ] The echo agent demonstrates correct use of both `llmCall` and `tools.exec`/`tools.writeFile`
- [ ] `src/cli/run.ts` imports the echo agent instead of using the inline stub
- [ ] `npx tsc --noEmit` passes with zero errors
- [ ] All pre-existing tests pass

## Dependencies
- Requires completion of: TASK-009 (COMPLETE)
- Blocks: TASK-011, TASK-012, TASK-013, TASK-014

## Open Questions
- none
