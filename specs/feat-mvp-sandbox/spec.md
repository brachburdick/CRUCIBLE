# Spec: MVP Sandbox Runner

## Summary
Phase 1 of CRUCIBLE: prove that an agent task can be launched inside an isolated E2B sandbox, observed in real time via Langfuse tracing, and killed cleanly from outside via token budget, semantic loop detection, or wall-clock TTL — with all kill paths converging on the same artifact-flush and teardown sequence.

## User-Facing Behavior
The operator runs a single CLI command:
```
npx crucible run --task <file> --variant <label> --budget <tokens> --ttl <seconds>
```
- Log output streams to the terminal during execution.
- On completion (clean or killed), a structured JSON result is written to `./runs/<runId>/result.json` along with any artifacts the agent produced.
- Exit codes: `0` = clean completion, `1` = budget exceeded, `2` = loop detected, `3` = TTL exceeded.
- A complete Langfuse trace is available for every run.

## Technical Requirements
- **TR-1**: E2B sandbox wrapper creates an isolated sandbox per run with configurable TTL and locked outbound network.
- **TR-2**: LLM calls happen host-side, never inside the sandbox. The sandbox is an execution environment for agent tool actions only.
- **TR-3**: Token budget middleware wraps any `LlmCallFn`, maintains a per-run rolling counter, emits warnings at 50%/80%, and throws `BudgetExceededError` at 100%.
- **TR-4**: Semantic loop detector embeds each agent message via `text-embedding-3-small`, maintains a rolling window of N embeddings, and throws `LoopDetectedError` when mean cosine similarity exceeds threshold for K consecutive turns.
- **TR-5**: Langfuse tracer creates a root trace per run with child spans for every LLM call, tool call, and middleware event. Append-only — agent code has no reference to the tracer.
- **TR-6**: All kill paths (budget, loop, TTL) converge on a single teardown sequence: log structured JSON event → flush artifacts → close Langfuse trace → destroy sandbox.
- **TR-7**: CLI reads task payload from file, instantiates the full middleware stack, streams logs, writes result JSON, and exits with the correct code.

## Interface Definitions

```typescript
// ─── src/types/index.ts ───

/** Configuration for a single run */
export interface RunConfig {
  taskPayload: TaskPayload;
  variantLabel: string;
  tokenBudget: number;
  ttlSeconds: number;
  loopDetection: {
    windowSize: number;        // default 8
    similarityThreshold: number; // default 0.92
    consecutiveTurns: number;  // default 5
  };
}

/** Task payload read from file */
export interface TaskPayload {
  description: string;
  instructions: string;
  /** Optional initial files to upload to sandbox */
  files?: Record<string, string>;
  /** Optional network allowlist for sandbox (empty = fully locked) */
  networkAllowlist?: string[];
}

/** Discriminated union for why a run ended */
export type KillReason =
  | { type: 'completed' }
  | { type: 'budget_exceeded'; tokenCount: number; budget: number }
  | { type: 'loop_detected'; similarityScore: number; consecutiveCount: number; lastMessages: string[] }
  | { type: 'ttl_exceeded'; wallTimeMs: number; ttlMs: number };

/** Structured result of a single run — input contract for Phase 2 scorer */
export interface RunResult {
  runId: string;
  variantLabel: string;
  exitReason: KillReason;
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  wallTimeMs: number;
  startedAt: string;   // ISO 8601
  completedAt: string; // ISO 8601
  artifacts: ArtifactManifest;
  /** Reserved for Phase 2 scoring metadata */
  metadata?: Record<string, unknown>;
}

/** Manifest of artifacts produced during the run */
export interface ArtifactManifest {
  outputDir: string;
  files: Array<{
    path: string;
    sizeBytes: number;
  }>;
}

/** Structured kill event logged before teardown */
export interface KillEvent {
  runId: string;
  killReason: KillReason;
  tokenCount: number;
  wallTimeMs: number;
  timestamp: string; // ISO 8601
}

/** The LLM call function that middleware wraps */
export type LlmCallFn = (
  messages: LlmMessage[],
  options?: LlmCallOptions
) => Promise<LlmResponse>;

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCallOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LlmResponse {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
  model: string;
}

/** Tool context passed to agent — facade over E2B sandbox operations */
export interface ToolContext {
  exec: (cmd: string) => Promise<ExecResult>;
  writeFile: (path: string, content: string) => Promise<void>;
  readFile: (path: string) => Promise<string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Agent function signature — the contract for pluggable agents */
export type AgentFn = (
  llmCall: LlmCallFn,
  tools: ToolContext
) => Promise<AgentOutput>;

export interface AgentOutput {
  finalMessage: string;
  /** Agent-reported artifacts (informational — actual artifacts are flushed from sandbox) */
  artifacts?: string[];
}

/** Middleware is a function that wraps an LlmCallFn */
export type Middleware = (next: LlmCallFn) => LlmCallFn;

// ─── Error types ───

export class BudgetExceededError extends Error {
  constructor(
    public readonly tokenCount: number,
    public readonly budget: number
  ) {
    super(`Token budget exceeded: ${tokenCount}/${budget}`);
    this.name = 'BudgetExceededError';
  }
}

export class LoopDetectedError extends Error {
  constructor(
    public readonly similarityScore: number,
    public readonly consecutiveCount: number,
    public readonly lastMessages: string[]
  ) {
    super(`Semantic loop detected: similarity ${similarityScore} for ${consecutiveCount} consecutive turns`);
    this.name = 'LoopDetectedError';
  }
}
```

## Layer Boundaries
- **Types layer** (`src/types/`) is responsible for: all shared type definitions, error classes, and interface contracts. No logic, no imports from other layers.
- **Sandbox layer** (`src/sandbox/`) is responsible for: E2B sandbox lifecycle (create, configure network, execute, flush artifacts, destroy). Exposes `ToolContext` facade. Does not know about middleware or tracing.
- **Middleware layer** (`src/middleware/`) is responsible for: composable `LlmCallFn` wrappers (token budget, loop detection) and the composition function (`stack.ts`). Does not know about E2B or Langfuse directly — communicates kill signals via typed errors.
- **Telemetry layer** (`src/telemetry/`) is responsible for: Langfuse trace lifecycle, span creation for LLM calls/tool calls/middleware events. Append-only from agent's perspective. Owns trace flush on teardown.
- **CLI layer** (`src/cli/`) is responsible for: argument parsing, wiring all layers together, streaming output, writing result JSON, exit codes. This is the only layer that imports from all others.
- **Interface between Middleware and Sandbox**: Middleware wraps `LlmCallFn` (host-side). Sandbox exposes `ToolContext` (sandbox-side). They never directly interact. The Runner in CLI wires them together.
- **Interface between Telemetry and all layers**: Telemetry observes via event callbacks or wrapper instrumentation. No layer imports telemetry except CLI (for wiring) and the tracer's own LLM call wrapper.

## Constraints
- TypeScript strict mode, NodeNext module resolution.
- No framework — library + CLI only.
- All LLM calls async. No sync blocking.
- E2B sandbox outbound network locked by default. Allowlist from task payload only.
- Middleware must be composable — wraps any `LlmCallFn` without agent internals changes.
- Agents have no reference to the tracer object.
- Every kill path logs a structured `KillEvent` JSON before teardown.
- No cross-run state bleed in any component.
- `OPENAI_API_KEY` required for embeddings (loop detector).

## Out of Scope
- Variant comparison / A-B runner (Phase 2)
- LLM-as-judge / Braintrust scoring (Phase 3)
- Functional test runner against agent output
- Dashboard or web UI
- Persistent run database
- Parallel sandbox execution
- Automatic promotion of winning variants

## Open Questions
All resolved — see decisions in plan.md.

## Edge Cases
- **Agent completes before any budget warning**: Clean exit, `KillReason.type = 'completed'`, all artifacts flushed normally.
- **Budget exceeded between LLM calls**: The middleware checks after each call. If a single call pushes past 100%, the error fires on that call's return — the overshoot is recorded in `RunResult.tokenUsage`.
- **Loop detector window not yet full**: No similarity check until the window has at least 2 embeddings. Cannot trigger `LoopDetectedError` in fewer than `consecutiveTurns` turns.
- **TTL fires during artifact flush**: E2B native TTL is a hard kill. The runner should set E2B TTL slightly longer (e.g., +30s) than the application TTL to allow artifact flush. Application-level TTL triggers graceful teardown first.
- **Langfuse flush fails on teardown**: Log the failure, do not block result JSON write. The run result is the source of truth; the trace is observability.
- **Empty task payload**: CLI validates task file on load. Missing required fields = exit with error message before sandbox creation.
- **Embedding API failure**: If the OpenAI embedding call fails, the loop detector should log a warning and skip that turn's check rather than crashing the run. The run continues without loop detection for that turn.
