# Plan: MVP Sandbox Runner

## Resolved Decisions

### D1: Agent Invocation Signature
**Decision:** `AgentFn = (llmCall: LlmCallFn, tools: ToolContext) => Promise<AgentOutput>`
**Rationale:** The agent receives a middleware-wrapped LLM call function (host-side) and a `ToolContext` facade over E2B sandbox operations. `ToolContext` is extensible — add methods later without breaking the contract. Rejected: passing raw sandbox handle (couples agent to E2B SDK), passing a full tool registry (overengineering for Phase 1).

### D2: Embedding API Key
**Decision:** Add `OPENAI_API_KEY` to `.env.example`. No provider abstraction.
**Rationale:** Single call site in `loopDetector.ts`. Embeddings are cheap. If we ever swap providers, it's a one-file change. Rejected: configurable provider interface (premature abstraction for one consumer).

### D3: LLM Calls Host-Side
**Decision:** All LLM calls and tracing happen in the host process. The E2B sandbox is purely an execution environment for agent tool actions. Sandbox outbound network is fully locked.
**Rationale:** Gives us unforgeable token budget enforcement, physically append-only tracing, true network isolation, and simpler teardown (all state is host-side). Rejected: LLM calls inside sandbox (breaks token enforcement, requires network allowlisting, complicates teardown).

### D4: CLI Argument Parser
**Decision:** Use `commander`.
**Rationale:** Minimal, zero transitive deps, standard for Node CLIs. Rejected: hand-rolled argv parsing (tedious, error-prone), yargs (heavier).

## Implementation Order

The build order follows dependency flow: types first (no deps), then leaf layers in parallel, then integration layers, then CLI on top.

```
Phase A: Foundation
  TASK-001: Types layer (all interfaces, errors)
  TASK-002: Project scaffolding (tsconfig, package.json, .env.example)

Phase B: Leaf Layers (parallel-safe after Phase A)
  TASK-003: E2B sandbox wrapper + ToolContext facade
  TASK-004: Token budget middleware
  TASK-005: Semantic loop detector
  TASK-006: Langfuse tracer

Phase C: Integration
  TASK-007: Middleware stack composer
  TASK-008: Teardown convergence (single path for all kill reasons)

Phase D: CLI + Wiring
  TASK-009: CLI entrypoint + run orchestration
  TASK-010: Example task payload + test agent

Phase E: Validation
  TASK-011: Integration test — clean completion
  TASK-012: Integration test — budget kill
  TASK-013: Integration test — loop kill
  TASK-014: Integration test — TTL kill
  TASK-015: README documentation
```

## Layer Interaction Diagram

```
CLI (run.ts)
 │
 ├─ reads TaskPayload from file
 ├─ builds RunConfig from args + env + defaults
 │
 ├─ creates Tracer (root trace)
 ├─ creates SandboxRunner (E2B instance)
 ├─ builds middleware stack:
 │    baseLlmCall
 │    → tracerWrapper (adds spans)
 │    → tokenBudget (counts + kills)
 │    → loopDetector (embeds + kills)
 │    = wrappedLlmCall
 │
 ├─ builds ToolContext from SandboxRunner
 │
 ├─ calls agentFn(wrappedLlmCall, toolContext)
 │    ├─ agent uses llmCall for LLM (host-side, metered, traced)
 │    └─ agent uses tools.exec/readFile/writeFile (sandbox-side)
 │
 ├─ on success or error:
 │    teardown(runContext, killReason)
 │      1. log KillEvent JSON
 │      2. flush artifacts from sandbox to ./runs/<runId>/
 │      3. close Langfuse root span
 │      4. destroy E2B sandbox
 │      5. write RunResult to ./runs/<runId>/result.json
 │
 └─ exit with code
```

## Middleware Stack Order (innermost to outermost)

The middleware wraps from bottom to top. The call chain is:
```
loopDetector → tokenBudget → tracerWrapper → baseLlmCall
```
- `loopDetector` sees the message first, embeds it, checks similarity, then passes through.
- `tokenBudget` counts tokens on the response, checks budget, then passes through.
- `tracerWrapper` records the span around the actual LLM call.
- `baseLlmCall` makes the actual API call.

This means: loop detection fires before the call (on the input message), token budget fires after the call (on the response usage), and tracing wraps the actual API call.

## TTL Strategy

Two-tier TTL to allow graceful teardown:
- **Application TTL**: `ttlSeconds` from config. Managed by a `setTimeout` in the runner. On fire: initiates graceful teardown (flush artifacts, close trace, then destroy sandbox).
- **E2B TTL**: Set to `ttlSeconds + 30`. This is the hard backstop. If graceful teardown hangs, E2B kills the sandbox.

## Risk Areas
1. **E2B SDK artifact retrieval timing**: If the sandbox is destroyed before file download completes, artifacts are lost. Mitigation: download artifacts before calling `sandbox.close()`.
2. **Langfuse batch flush timing**: The SDK batches events. On teardown, must call `langfuse.flush()` and await it. Mitigation: explicit flush in teardown sequence.
3. **Embedding API latency**: Each agent message triggers an embedding call. If this is too slow, it adds latency to every turn. Mitigation: fire-and-forget with an in-memory queue? No — we need the result for similarity check. Accept the latency; it's small (~50ms per call).
4. **Token count accuracy**: The LLM response includes usage data, but the middleware counts based on what the API reports. If the API is slow to report or reports inconsistently, budget enforcement may overshoot. Mitigation: accept small overshoots; document this in the spec edge cases.
