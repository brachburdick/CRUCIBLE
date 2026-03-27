/**
 * Decomposition Graph data model — Layer 0 of the Adaptive Pipeline.
 *
 * All graph-related types live here. Imports from ./index.js for shared types
 * (TaskPayload, KillReason, etc.) but never modifies them.
 */

import type { TaskPayload, KillReason } from './index.js';

// ─── Core Graph ───

export interface DecompositionGraph {
  id: string;
  taskOrigin: TaskPayload;
  pipelineDefinition: string;
  strategyUsed: string;
  createdAt: string;                    // ISO 8601
  updatedAt: string;
  rootNodeId: string;
  nodes: DecompositionNode[];
  edges: DependencyEdge[];
  status: 'decomposing' | 'executing' | 'completed' | 'failed' | 'budget_exceeded';
  metrics: GraphMetrics;
}

export interface DecompositionNode {
  id: string;
  parentId: string | null;
  type: 'goal' | 'milestone' | 'task' | 'leaf';
  description: string;
  acceptanceCriteria: string[];
  ownedPaths: string[];
  inputs: ArtifactRef[];
  outputs: ArtifactRef[];
  status: 'pending' | 'ready' | 'active' | 'completed' | 'failed' | 'blocked' | 'skipped';
  complexityEstimate: 'simple' | 'moderate' | 'complex' | null;
  assignedTo: string | null;
  readiness: ReadinessAssessment;
  execution: ExecutionRecord | null;
  artifacts: Artifact[];
  reasoning: ReasoningEntry[];
  metrics: NodeMetrics;
}

export interface DependencyEdge {
  from: string;
  to: string;
  type: 'data' | 'sequence' | 'contract';
  contract: InterfaceContract | null;
  couplingType: 'data' | 'stamp' | 'control' | 'common' | 'content';
  couplingSource: 'static' | 'llm-inferred' | 'hybrid';
  couplingConfidence: number;           // 0.0–1.0
}

// ─── Readiness ───

export interface ReadinessAssessment {
  gateMode: 'hard-block' | 'triage';
  globalScore: number;
  dynamicScore: number;
  compositeScore: number;
  globalWeight: number;                 // default 0.7
  checks: ReadinessCheck[];
  questionsGenerated: QuestionRef[];
  passedAt: string | null;
  falsePositiveHistory: number | null;
}

export interface ReadinessCheck {
  rule: string;
  source: 'global' | 'dynamic';
  binding: 'hard' | 'advisory';
  passed: boolean;
  detail: string;
}

export interface QuestionRef {
  questionId: string;
  rule: string;
}

// ─── Contracts & Artifacts ───

export interface InterfaceContract {
  inputTypes: TypeSpec[];
  outputTypes: TypeSpec[];
  invariants: string[];
  verifyCommand: string | null;
}

export interface TypeSpec {
  name: string;
  schema: string;                       // JSON Schema reference or inline
}

export interface ArtifactRef {
  nodeId: string;
  artifactId: string;
  type: string;
}

export interface Artifact {
  id: string;
  type: 'file' | 'test-result' | 'log' | 'metric';
  path: string | null;
  content: string | null;
  createdAt: string;
}

// ─── Execution ───

export interface ExecutionRecord {
  startedAt: string;
  completedAt: string | null;
  exitReason: KillReason | { type: 'escalated'; question: string } | { type: 'redecomposed' };
  tokenUsage: { prompt: number; completion: number; total: number };
  wallTimeMs: number;
  mutations: number;
  testCycles: number;
  toolCalls: ToolCallSummary[];
  verificationResults: VerificationResult[];
}

export interface ToolCallSummary {
  name: string;
  count: number;
  totalDurationMs: number;
}

export interface VerificationResult {
  checkName: string;
  passed: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ─── Reasoning ───

export interface ReasoningEntry {
  timestamp: string;
  phase: string;
  decision: string;
  alternatives: string[];
  rationale: string;
  confidence: number;                   // 0.0–1.0
}

// ─── Metrics ───

export interface NodeMetrics {
  tokenUsage: { prompt: number; completion: number; total: number };
  wallTimeMs: number;
  mutations: number;
  testCycles: number;
  retries: number;
}

export interface GraphMetrics {
  totalTokens: number;
  totalWallTimeMs: number;
  nodeCount: number;
  leafCount: number;
  completedCount: number;
  failedCount: number;
  maxDepth: number;
  averageCouplingConfidence: number;
}

// ─── Events ───

export interface GraphEvent {
  timestamp: string;
  type:
    | 'graph_created'
    | 'node_status_changed'
    | 'node_execution_started'
    | 'node_execution_completed'
    | 'readiness_assessed'
    | 'decomposition_started'
    | 'decomposition_completed'
    | 'question_generated'
    | 'edge_added'
    | 'graph_completed';
  nodeId: string | null;
  detail: Record<string, unknown>;
}

// ─── Default factories ───

export function emptyReadiness(): ReadinessAssessment {
  return {
    gateMode: 'triage',
    globalScore: 0,
    dynamicScore: 1.0,
    compositeScore: 0,
    globalWeight: 0.7,
    checks: [],
    questionsGenerated: [],
    passedAt: null,
    falsePositiveHistory: null,
  };
}

export function emptyNodeMetrics(): NodeMetrics {
  return {
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    wallTimeMs: 0,
    mutations: 0,
    testCycles: 0,
    retries: 0,
  };
}

export function emptyGraphMetrics(): GraphMetrics {
  return {
    totalTokens: 0,
    totalWallTimeMs: 0,
    nodeCount: 0,
    leafCount: 0,
    completedCount: 0,
    failedCount: 0,
    maxDepth: 0,
    averageCouplingConfidence: 0,
  };
}
