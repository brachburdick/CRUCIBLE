/**
 * Session model types — replicates THE_FACTORY's session lifecycle
 * for CRUCIBLE's adaptive pipeline.
 *
 * These types define the data contracts for state snapshots, task management,
 * async question queues, run records, mutation tracking, and flow templates.
 */

// ─── State Snapshot ───

export interface StateSnapshot {
  sessionId: string;
  timestamp: string;                    // ISO 8601
  branch: string;
  lastCommit: string;
  activeTasks: string[];                // task IDs currently in_progress
  modifiedFiles: string[];
  sessionKnowledge: SessionKnowledge;
  sessionFriction: SessionFriction;
}

export interface SessionKnowledge {
  decisions: DecisionEntry[];
  keyLocations: KeyLocation[];
  deadEnds: DeadEnd[];
  openQuestions: string[];              // question IDs still pending
}

export interface DecisionEntry {
  timestamp: string;
  nodeId: string | null;
  decision: string;
  rationale: string;
}

export interface KeyLocation {
  path: string;
  description: string;
  discoveredAt: string;
}

export interface DeadEnd {
  approach: string;
  reason: string;
  discoveredAt: string;
}

export interface SessionFriction {
  mutationsSinceTest: number;
  totalMutations: number;
  testCycles: number;
  uniqueFilesModified: string[];
}

// ─── Task Management ───

export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';
export type TaskStatus = 'pending' | 'in_progress' | 'complete' | 'blocked' | 'skipped';
export type TaskType = 'debug' | 'feature' | 'refactor' | 'chore';
export type RiskLevel = 'low' | 'medium' | 'high';

export interface Task {
  id: string;
  description: string;
  taskType: TaskType;
  status: TaskStatus;
  priority: TaskPriority;
  riskLevel: RiskLevel;
  blockedBy: string[];                  // task IDs that must complete first
  ownedPaths: string[];
  flowPhase: string | null;
  assignedTo: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Question Queue ───

export type QuestionStatus = 'pending' | 'answered' | 'dismissed';

export interface Question {
  id: string;
  task: string;                         // task ID this question relates to
  question: string;
  options: string[];
  default: string;
  impact: string;
  status: QuestionStatus;
  asked: string;                        // ISO 8601
  answered: string | null;
  answer: string | null;
}

// ─── Run Records ───

export type RunResult = 'success' | 'partial' | 'failed' | 'escalated';

export interface RunRecord {
  runId: string;
  date: string;                         // ISO 8601
  projectId: string;
  taskId: string;
  taskType: TaskType;
  result: RunResult;
  summary: string;
  filesTouched: string[];
  humanTouches: HumanTouches;
}

export interface HumanTouches {
  questions: number;
  corrections: number;
  escalations: number;
  approvals: number;
  total: number;
}

// ─── Mutation Budget ───

export type MutationAction = 'edit' | 'write';

export interface MutationBudgetState {
  /** Consecutive mutations without a test run (per-node cap: 2) */
  consecutiveMutations: number;
  /** Total mutations in the graph execution (compound budget: 10) */
  totalMutations: number;
  /** Number of edit-test cycles on the current node */
  editTestCycles: number;
  /** Set of unique file paths modified across the graph */
  uniqueFiles: Set<string>;
  /** Whether the budget is currently halted */
  halted: boolean;
  /** Reason for halt, if any */
  haltReason: string | null;
}

export interface MutationBudgetConfig {
  /** Max consecutive mutations before test required (default: 2) */
  consecutiveCap: number;
  /** Total mutation budget across graph (default: 10) */
  compoundBudget: number;
  /** Max edit-test cycles per node before halt (default: 4) */
  editTestCycleCap: number;
  /** Max unique files before halt (default: 10) */
  uniqueFilesCap: number;
}

export const DEFAULT_MUTATION_BUDGET_CONFIG: MutationBudgetConfig = {
  consecutiveCap: 2,
  compoundBudget: 10,
  editTestCycleCap: 4,
  uniqueFilesCap: 10,
};

// ─── Flow Templates ───

export type FlowType = 'debug' | 'feature' | 'refactor' | 'exploration' | 'assessment';

export interface FlowPhase {
  name: string;
  description: string;
  /** Rules that must be satisfied before entering this phase */
  entryGates: string[];
  /** Rules that must be satisfied before leaving this phase */
  exitGates: string[];
}

export interface FlowTemplate {
  type: FlowType;
  description: string;
  phases: FlowPhase[];
  rules: FlowRule[];
}

export interface FlowRule {
  name: string;
  description: string;
  enforcement: 'hard' | 'advisory';
}

export interface FlowPhaseTransition {
  from: string;
  to: string;
  valid: boolean;
  reason: string | null;
}
