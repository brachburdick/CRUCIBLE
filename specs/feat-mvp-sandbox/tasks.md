# Tasks: MVP Sandbox Runner

## Dependency Graph
```
TASK-001 (types) ─┬─→ TASK-003 (sandbox wrapper)
                  ├─→ TASK-004 (token budget)
TASK-002 (scaffold)┤─→ TASK-005 (loop detector)
                  ├─→ TASK-006 (langfuse tracer)
                  │
TASK-003 ─────────┼─→ TASK-007 (middleware stack)
TASK-004 ─────────┤
TASK-005 ─────────┤
TASK-006 ─────────┘
                  │
TASK-007 ─────────┬─→ TASK-008 (teardown convergence)
TASK-003 ─────────┘
                  │
TASK-008 ─────────┬─→ TASK-009 (CLI entrypoint)
                  │
TASK-009 ─────────┬─→ TASK-010 (example task + test agent)
                  │
TASK-010 ─────────┬─→ TASK-011 (integration: clean completion)
                  ├─→ TASK-012 (integration: budget kill)
                  ├─→ TASK-013 (integration: loop kill)
                  ├─→ TASK-014 (integration: TTL kill)
                  │
(any time after TASK-009) → TASK-015 (README)
```

Parallel-safe groups:
- After TASK-001 + TASK-002: TASK-003, TASK-004, TASK-005, TASK-006 can run in parallel.
- After TASK-010: TASK-011, TASK-012, TASK-013, TASK-014 can run in parallel.

## Tasks

### TASK-001: Type Definitions
- **Layer:** Types
- **Estimated effort:** < 30 min
- **Depends on:** none
- **Scope:** `src/types/index.ts`
- **Inputs:** Interface definitions from spec.md
- **Outputs:** All shared types, error classes, and interface contracts exported from `src/types/index.ts`
- **QA Required:** NO — pure type definitions, validated by TypeScript compiler
- **State Behavior:** N/A
- **Acceptance Criteria:**
  - [ ] `RunConfig`, `TaskPayload`, `KillReason`, `RunResult`, `ArtifactManifest`, `KillEvent`, `LlmCallFn`, `LlmMessage`, `LlmCallOptions`, `LlmResponse`, `ToolContext`, `ExecResult`, `AgentFn`, `AgentOutput`, `Middleware` are exported
  - [ ] `BudgetExceededError` and `LoopDetectedError` extend `Error` with typed fields
  - [ ] `KillReason` is a discriminated union on `type` field
  - [ ] `RunResult.metadata` is optional `Record<string, unknown>` for Phase 2 extensibility
  - [ ] File compiles under strict mode with no errors
  - [ ] If this session adds or modifies any interface values or fields, update the project's interface contract documentation — or flag `[INTERFACE IMPACT]` and stop.
- **Context files:** `specs/feat-mvp-sandbox/spec.md` (Interface Definitions section)
- **Status:** [x] COMPLETE — session-TASK-001-002.md

---

### TASK-002: Project Scaffolding
- **Layer:** All (infrastructure)
- **Estimated effort:** < 30 min
- **Depends on:** none
- **Scope:** `package.json`, `tsconfig.json`, `.env.example`, `.gitignore`, `src/` directory structure
- **Inputs:** Bootstrap spec (stack constraints, env vars, project structure)
- **Outputs:** Compilable empty project with correct TS config, all dependencies declared, env template
- **QA Required:** NO — verified by `npm install && npx tsc --noEmit`
- **State Behavior:** N/A
- **Acceptance Criteria:**
  - [ ] `tsconfig.json` has `strict: true`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`
  - [ ] `package.json` declares dependencies: `e2b`, `@langfuse/langfuse`, `openai`, `commander`
  - [ ] `package.json` declares `"bin": { "crucible": "./dist/cli/run.js" }`
  - [ ] `.env.example` lists: `E2B_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`, `DEFAULT_TOKEN_BUDGET`, `DEFAULT_TTL_SECONDS`, `LOOP_WINDOW_SIZE`, `LOOP_SIMILARITY_THRESHOLD`, `LOOP_CONSECUTIVE_TURNS`
  - [ ] `.gitignore` includes `runs/`, `node_modules/`, `dist/`, `.env`
  - [ ] Directory structure exists: `src/sandbox/`, `src/middleware/`, `src/telemetry/`, `src/cli/`, `src/types/`, `runs/`, `tasks/`
  - [ ] `npm install` succeeds
  - [ ] `npx tsc --noEmit` succeeds (with empty source files or barrel exports)
  - [ ] All pre-existing tests pass
- **Context files:** Bootstrap spec (project structure, constraints, .env sections)
- **Status:** [x] COMPLETE — session-TASK-001-002.md

---

### TASK-003: E2B Sandbox Wrapper + ToolContext
- **Layer:** Sandbox
- **Estimated effort:** < 30 min
- **Depends on:** TASK-001, TASK-002
- **Scope:** `src/sandbox/runner.ts`
- **Inputs:** `RunConfig`, `ToolContext`, `ExecResult`, `ArtifactManifest` types; E2B SDK
- **Outputs:** `SandboxRunner` class that manages E2B sandbox lifecycle and exposes `ToolContext`
- **QA Required:** YES — integration boundary with external service (E2B). Must verify sandbox creation, command execution, file operations, artifact flush, and teardown.
- **State Behavior:** N/A
- **Acceptance Criteria:**
  - [ ] `SandboxRunner.create(config)` creates an E2B sandbox with TTL = `config.ttlSeconds + 30`
  - [ ] Network outbound is disabled by default; allowlist applied from `TaskPayload.networkAllowlist`
  - [ ] `getToolContext()` returns a `ToolContext` with `exec`, `writeFile`, `readFile` backed by the E2B sandbox
  - [ ] `flushArtifacts(runId)` downloads all files from sandbox working directory to `./runs/<runId>/`
  - [ ] `flushArtifacts` returns an `ArtifactManifest` with file paths and sizes
  - [ ] `destroy()` closes the E2B sandbox
  - [ ] If sandbox is already destroyed, `destroy()` is a no-op (idempotent)
  - [ ] All methods are async
  - [ ] All pre-existing tests pass
  - [ ] If this session adds or modifies any interface values or fields, update the project's interface contract documentation — or flag `[INTERFACE IMPACT]` and stop.
- **Context files:** `src/types/index.ts`, `skills/e2b-sandbox.md`, `specs/feat-mvp-sandbox/spec.md`
- **Status:** [x] COMPLETE — session-TASK-003.md

---

### TASK-004: Token Budget Middleware
- **Layer:** Middleware
- **Estimated effort:** < 30 min
- **Depends on:** TASK-001, TASK-002
- **Scope:** `src/middleware/tokenBudget.ts`
- **Inputs:** `LlmCallFn`, `Middleware`, `BudgetExceededError` types
- **Outputs:** `createTokenBudget(config)` factory that returns a `Middleware`
- **QA Required:** YES — safety-critical kill path. Must verify counting accuracy, threshold warnings, and hard kill.
- **State Behavior:** N/A
- **Acceptance Criteria:**
  - [ ] `createTokenBudget({ budget, onWarning })` returns a `Middleware` function
  - [ ] Wraps any `LlmCallFn` — does not require changes to agent internals
  - [ ] Maintains a rolling token counter scoped to the closure (per-run)
  - [ ] After each LLM call, adds `response.usage.promptTokens + response.usage.completionTokens` to counter
  - [ ] At 50% of budget: calls `onWarning('50%', currentCount, budget)` — continue execution
  - [ ] At 80% of budget: calls `onWarning('80%', currentCount, budget)` — continue execution
  - [ ] At 100% of budget: throws `BudgetExceededError` with current count and budget
  - [ ] Warning callbacks fire at most once each (50% fires once, 80% fires once)
  - [ ] Exposes `getTokenCount()` for teardown reporting
  - [ ] No cross-run state — new closure per `createTokenBudget` call
  - [ ] All pre-existing tests pass
- **Context files:** `src/types/index.ts`, `specs/feat-mvp-sandbox/spec.md`
- **Status:** [x] COMPLETE — session-TASK-004.md

---

### TASK-005: Semantic Loop Detector
- **Layer:** Middleware
- **Estimated effort:** < 30 min
- **Depends on:** TASK-001, TASK-002
- **Scope:** `src/middleware/loopDetector.ts`
- **Inputs:** `LlmCallFn`, `Middleware`, `LoopDetectedError` types; OpenAI SDK for embeddings
- **Outputs:** `createLoopDetector(config)` factory that returns a `Middleware`
- **QA Required:** YES — safety-critical kill path. Must verify embedding, similarity calculation, consecutive turn tracking, and error with diagnostics.
- **State Behavior:** N/A
- **Acceptance Criteria:**
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
  - [ ] All pre-existing tests pass
- **Context files:** `src/types/index.ts`, `specs/feat-mvp-sandbox/spec.md`
- **Status:** [x] COMPLETE — session-TASK-005.md

---

### TASK-006: Langfuse Tracer
- **Layer:** Telemetry
- **Estimated effort:** < 30 min
- **Depends on:** TASK-001, TASK-002
- **Scope:** `src/telemetry/tracer.ts`
- **Inputs:** `RunConfig`, `KillReason`, `KillEvent` types; Langfuse SDK
- **Outputs:** `RunTracer` class managing trace lifecycle + `createTracerMiddleware()` that returns a `Middleware`
- **QA Required:** YES — integration boundary with external service (Langfuse). Must verify trace creation, span structure, and flush.
- **State Behavior:** N/A
- **Acceptance Criteria:**
  - [ ] `RunTracer.create(runConfig)` creates a root Langfuse trace with run ID, variant label, and start time
  - [ ] `createTracerMiddleware()` returns a `Middleware` that wraps `LlmCallFn` with child spans (tokens in/out, model, latency)
  - [ ] `traceToolCall(name, input, output, durationMs)` records a tool call child span
  - [ ] `traceMiddlewareEvent(event)` records middleware events (budget warnings, loop flags) as child spans
  - [ ] Agent code never receives a reference to the tracer — append-only by construction
  - [ ] `close(killReason, tokenCount)` closes the root span with reason and final token count
  - [ ] `close` calls `langfuse.flush()` and awaits it before returning
  - [ ] If flush fails, logs error but does not throw (non-blocking teardown)
  - [ ] All pre-existing tests pass
  - [ ] If this session adds or modifies any interface values or fields, update the project's interface contract documentation — or flag `[INTERFACE IMPACT]` and stop.
- **Context files:** `src/types/index.ts`, `skills/langfuse-tracing.md`, `specs/feat-mvp-sandbox/spec.md`
- **Status:** [x] COMPLETE — session-TASK-006.md

---

### TASK-007: Middleware Stack Composer
- **Layer:** Middleware
- **Estimated effort:** < 30 min
- **Depends on:** TASK-004, TASK-005, TASK-006 (needs all middleware implementations to verify composition)
- **Scope:** `src/middleware/stack.ts`
- **Inputs:** `Middleware`, `LlmCallFn` types; individual middleware factories
- **Outputs:** `composeMiddleware(...middlewares)` function that chains middlewares onto a base `LlmCallFn`
- **QA Required:** NO — pure function composition, verified by integration tests in TASK-011+
- **State Behavior:** N/A
- **Acceptance Criteria:**
  - [ ] `composeMiddleware(base, ...middlewares)` returns a single `LlmCallFn`
  - [ ] Middlewares apply in order: last middleware in the array is outermost (first to execute)
  - [ ] Correct composition order: `composeMiddleware(baseLlmCall, tracerMiddleware, tokenBudgetMiddleware, loopDetectorMiddleware)` produces call chain: loopDetector → tokenBudget → tracer → baseLlmCall
  - [ ] Works with zero middlewares (returns base function unchanged)
  - [ ] Works with one middleware
  - [ ] All pre-existing tests pass
- **Context files:** `src/types/index.ts`, `src/middleware/tokenBudget.ts`, `src/middleware/loopDetector.ts`, `src/telemetry/tracer.ts`
- **Status:** [x] COMPLETE — session-TASK-007.md

---

### TASK-008: Teardown Convergence
- **Layer:** Sandbox + Telemetry (integration)
- **Estimated effort:** < 30 min
- **Depends on:** TASK-003, TASK-007
- **Scope:** `src/sandbox/teardown.ts` (new file)
- **Inputs:** `SandboxRunner`, `RunTracer`, `KillReason`, `KillEvent`, `RunResult` types
- **Outputs:** `teardown(context, killReason)` function implementing the single convergent teardown path
- **QA Required:** YES — critical convergence point. All kill paths must produce identical teardown behavior.
- **State Behavior:** N/A
- **Acceptance Criteria:**
  - [ ] `teardown(context, killReason)` executes in this exact order:
    1. Logs `KillEvent` JSON to stdout
    2. Calls `sandboxRunner.flushArtifacts(runId)` to download artifacts
    3. Calls `tracer.close(killReason, tokenCount)` to close trace and flush
    4. Calls `sandboxRunner.destroy()` to destroy E2B sandbox
    5. Writes `RunResult` JSON to `./runs/<runId>/result.json`
  - [ ] If artifact flush fails: logs error, continues teardown (does not abort)
  - [ ] If tracer close fails: logs error, continues teardown (does not abort)
  - [ ] If sandbox destroy fails: logs error, continues (idempotent)
  - [ ] Teardown is idempotent — calling twice does not error
  - [ ] `RunResult` is fully populated with timing, token usage, kill reason, and artifact manifest
  - [ ] Creates `./runs/<runId>/` directory if it doesn't exist
  - [ ] All pre-existing tests pass
  - [ ] If this session adds or modifies any interface values or fields, update the project's interface contract documentation — or flag `[INTERFACE IMPACT]` and stop.
- **Context files:** `src/sandbox/runner.ts`, `src/telemetry/tracer.ts`, `src/types/index.ts`, `specs/feat-mvp-sandbox/plan.md` (teardown section)
- **Status:** [x] COMPLETE — session-TASK-008.md

---

### TASK-009: CLI Entrypoint
- **Layer:** CLI
- **Estimated effort:** < 30 min
- **Depends on:** TASK-008
- **Scope:** `src/cli/run.ts`
- **Inputs:** All layers; `commander` for arg parsing; `.env` for defaults
- **Outputs:** Working `npx crucible run` command that wires all layers together
- **QA Required:** YES — user-facing entrypoint. Must verify arg parsing, env loading, wiring, streaming output, exit codes.
- **State Behavior:** N/A
- **Acceptance Criteria:**
  - [ ] Parses: `--task <file>`, `--variant <label>`, `--budget <tokens>`, `--ttl <seconds>`
  - [ ] Falls back to env defaults for `--budget` (`DEFAULT_TOKEN_BUDGET`) and `--ttl` (`DEFAULT_TTL_SECONDS`)
  - [ ] Falls back to env defaults for loop detection config (`LOOP_WINDOW_SIZE`, `LOOP_SIMILARITY_THRESHOLD`, `LOOP_CONSECUTIVE_TURNS`)
  - [ ] Reads and validates task payload JSON from `--task` file path
  - [ ] Instantiates: `SandboxRunner`, `RunTracer`, token budget middleware, loop detector middleware
  - [ ] Composes middleware stack in correct order via `composeMiddleware`
  - [ ] Sets application-level TTL via `setTimeout` that triggers `teardown()` with `ttl_exceeded`
  - [ ] Catches `BudgetExceededError` → teardown with `budget_exceeded`
  - [ ] Catches `LoopDetectedError` → teardown with `loop_detected`
  - [ ] On clean agent completion → teardown with `completed`
  - [ ] Streams log output to terminal (console.log for events, structured JSON for kill events)
  - [ ] Exit codes: 0 = completed, 1 = budget_exceeded, 2 = loop_detected, 3 = ttl_exceeded
  - [ ] All pre-existing tests pass
- **Context files:** All `src/` files, `specs/feat-mvp-sandbox/spec.md`, `specs/feat-mvp-sandbox/plan.md`
- **Status:** [x] COMPLETE — session-TASK-009.md

---

### TASK-010: Example Task Payload + Test Agent
- **Layer:** CLI (test fixtures)
- **Estimated effort:** < 30 min
- **Depends on:** TASK-009
- **Scope:** `tasks/example-simple.json`, `tasks/example-looping.json`, `src/agents/echo.ts` (test agent)
- **Inputs:** `TaskPayload`, `AgentFn` types
- **Outputs:** Two task payloads and a simple test agent for integration testing
- **QA Required:** NO — test fixtures, validated by integration tests
- **State Behavior:** N/A
- **Acceptance Criteria:**
  - [ ] `tasks/example-simple.json` is a valid `TaskPayload` that asks the agent to perform a simple task (e.g., "write a haiku to a file")
  - [ ] `tasks/example-looping.json` is a valid `TaskPayload` designed to trigger loop detection (e.g., "keep asking the same question")
  - [ ] `src/agents/echo.ts` exports an `AgentFn` that uses `llmCall` and `tools` to complete a simple task
  - [ ] The echo agent demonstrates correct use of both `llmCall` and `tools.exec`/`tools.writeFile`
  - [ ] All pre-existing tests pass
- **Context files:** `src/types/index.ts`, `specs/feat-mvp-sandbox/spec.md`
- **Status:** [ ] UNBLOCKED — ready for dispatch

---

### TASK-011: Integration Test — Clean Completion
- **Layer:** Validation
- **Estimated effort:** < 30 min
- **Depends on:** TASK-010
- **Scope:** Integration test (manual or scripted)
- **Inputs:** `tasks/example-simple.json`, echo agent, working CLI
- **Outputs:** Verified clean run with artifacts and trace
- **QA Required:** YES — validates Definition of Done item: "npx crucible run executes a real agent task inside E2B"
- **State Behavior:** N/A
- **Acceptance Criteria:**
  - [ ] `npx crucible run --task tasks/example-simple.json --variant test-v1 --budget 10000 --ttl 120` completes
  - [ ] Exit code is 0
  - [ ] `./runs/<runId>/result.json` exists and contains valid `RunResult` with `exitReason.type === 'completed'`
  - [ ] Artifacts directory contains files produced by the agent
  - [ ] Langfuse shows a complete trace for the run with root span, LLM call spans, and tool call spans
  - [ ] All pre-existing tests pass
- **Context files:** `specs/feat-mvp-sandbox/spec.md` (Definition of Done)
- **Status:** [ ] Not started

---

### TASK-012: Integration Test — Budget Kill
- **Layer:** Validation
- **Estimated effort:** < 30 min
- **Depends on:** TASK-010
- **Scope:** Integration test (manual or scripted)
- **Inputs:** `tasks/example-simple.json`, echo agent, working CLI with low budget
- **Outputs:** Verified budget kill with correct teardown
- **QA Required:** YES — validates Definition of Done item: "Token budget middleware kills the run before ceiling is breached"
- **State Behavior:** N/A
- **Acceptance Criteria:**
  - [ ] `npx crucible run --task tasks/example-simple.json --variant test-v1 --budget 100 --ttl 120` triggers budget kill
  - [ ] Exit code is 1
  - [ ] `./runs/<runId>/result.json` exists with `exitReason.type === 'budget_exceeded'`
  - [ ] Result JSON includes token count and budget in exit reason
  - [ ] Langfuse trace shows budget warning events and final kill reason
  - [ ] Artifacts are flushed (not silently discarded)
  - [ ] All pre-existing tests pass
- **Context files:** `specs/feat-mvp-sandbox/spec.md` (Definition of Done, Kill Switch Priority Order)
- **Status:** [ ] Not started

---

### TASK-013: Integration Test — Loop Kill
- **Layer:** Validation
- **Estimated effort:** < 30 min
- **Depends on:** TASK-010
- **Scope:** Integration test (manual or scripted)
- **Inputs:** `tasks/example-looping.json`, echo agent or looping agent, working CLI
- **Outputs:** Verified loop kill with diagnostics
- **QA Required:** YES — validates Definition of Done item: "Loop detector identifies and kills a deliberately looping test case"
- **State Behavior:** N/A
- **Acceptance Criteria:**
  - [ ] `npx crucible run --task tasks/example-looping.json --variant test-loop --budget 50000 --ttl 120` triggers loop detection
  - [ ] Exit code is 2
  - [ ] `./runs/<runId>/result.json` exists with `exitReason.type === 'loop_detected'`
  - [ ] Result JSON includes similarity score, consecutive count, and last messages in exit reason
  - [ ] Langfuse trace shows loop detection event
  - [ ] Artifacts are flushed (not silently discarded)
  - [ ] All pre-existing tests pass
- **Context files:** `specs/feat-mvp-sandbox/spec.md` (Definition of Done, Kill Switch Priority Order)
- **Status:** [ ] Not started

---

### TASK-014: Integration Test — TTL Kill
- **Layer:** Validation
- **Estimated effort:** < 30 min
- **Depends on:** TASK-010
- **Scope:** Integration test (manual or scripted)
- **Inputs:** Task payload, slow/hanging agent, working CLI with short TTL
- **Outputs:** Verified TTL kill with correct teardown
- **QA Required:** YES — validates TTL kill path
- **State Behavior:** N/A
- **Acceptance Criteria:**
  - [ ] `npx crucible run --task tasks/example-simple.json --variant test-ttl --budget 50000 --ttl 5` triggers TTL kill (agent takes longer than 5 seconds)
  - [ ] Exit code is 3
  - [ ] `./runs/<runId>/result.json` exists with `exitReason.type === 'ttl_exceeded'`
  - [ ] Result JSON includes wall time and TTL in exit reason
  - [ ] Artifacts are flushed before sandbox destruction
  - [ ] Langfuse trace is closed with TTL reason
  - [ ] All pre-existing tests pass
- **Context files:** `specs/feat-mvp-sandbox/spec.md` (Definition of Done, Kill Switch Priority Order)
- **Status:** [ ] Not started

---

### TASK-015: README Documentation
- **Layer:** Documentation
- **Estimated effort:** < 30 min
- **Depends on:** TASK-009
- **Scope:** `README.md`
- **Inputs:** All specs, working CLI
- **Outputs:** README documenting setup, env vars, CLI usage, and architecture overview
- **QA Required:** NO — documentation, reviewed by operator
- **State Behavior:** N/A
- **Acceptance Criteria:**
  - [ ] Documents: project purpose, prerequisites (Node.js, E2B account, Langfuse instance, OpenAI key)
  - [ ] Documents: setup steps (`npm install`, `.env` configuration)
  - [ ] Documents: all env vars with descriptions and defaults
  - [ ] Documents: CLI usage with all flags and examples
  - [ ] Documents: exit codes and their meanings
  - [ ] Documents: project structure overview
  - [ ] Documents: kill switch priority order
  - [ ] All pre-existing tests pass
- **Context files:** `specs/feat-mvp-sandbox/spec.md`, `.env.example`
- **Status:** [ ] UNBLOCKED — ready for dispatch
