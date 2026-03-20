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
