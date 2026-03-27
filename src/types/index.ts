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
  /** Optional path to a directory to upload as the seed repo */
  seedDir?: string;
  /** Optional network allowlist for sandbox (empty = fully locked) */
  networkAllowlist?: string[];
  /** Acceptance checks to run after the agent completes */
  checks?: CheckSpec[];
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
  /** String for text messages, or structured content blocks for tool results */
  content: string | ContentBlock[];
}

/** Content block types used in the Anthropic Messages API */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface LlmCallOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Tool definitions for Claude's native tool_use API */
  tools?: ToolDefinition[];
}

export interface LlmResponse {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
  model: string;
  /** Tool calls requested by the model (present when tools were provided) */
  toolCalls?: ToolCall[];
  /** Stop reason from the API ('end_turn', 'tool_use', 'max_tokens') */
  stopReason?: string;
}

// ─── Tool-use types ───

/** Tool definition passed to the Anthropic Messages API */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** A tool call requested by the model */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A tool result sent back to the model */
export interface ToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
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

// ─── Variant config ───

/** Configuration for a pipeline variant — defines how the agent behaves */
export interface VariantConfig {
  /** Unique variant name (used as variantLabel in RunResult) */
  name: string;
  /** Human-readable description of this variant */
  description: string;
  /** Agent to use from the AGENTS registry (default: 'coder') */
  agent?: string;
  /** Model override (e.g., 'claude-opus-4-20250514') */
  model?: string;
  /** System prompt — inline text or path to a .md file */
  systemPrompt?: string;
  /** Paths to skill .md files to append to the system prompt */
  skills?: string[];
  /** Token budget override */
  budget?: number;
  /** TTL override in seconds */
  ttl?: number;
  /** Freeform metadata for tracking experiment dimensions */
  metadata?: Record<string, unknown>;
}

// ─── Scoring types ───

/** Specification for a single acceptance check */
export interface CheckSpec {
  /** Human-readable check name */
  name: string;
  /** Check type — currently only 'exec' (run a command) */
  type: 'exec';
  /** Shell command to execute in the sandbox */
  command: string;
  /** Expected exit code (default: 0) */
  expectedExitCode?: number;
  /** Timeout in seconds for the check command */
  timeout?: number;
}

/** Result of running acceptance checks after a run */
export interface ScoreResult {
  checks: Array<{
    name: string;
    passed: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  }>;
  passRate: number;
}

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
