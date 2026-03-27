/**
 * Session Model — facade over all session lifecycle components.
 *
 * The RunEngine (Phase 3) consumes this as a single entry point for:
 * - State snapshot persistence and continuity
 * - Task ownership and dependency resolution
 * - Async question queue for non-blocking decisions
 * - Run record audit trail
 * - Mutation budget enforcement
 * - Flow template injection and phase validation
 */

// Types
export type {
  StateSnapshot,
  SessionKnowledge,
  SessionFriction,
  DecisionEntry,
  KeyLocation,
  DeadEnd,
  Task,
  TaskPriority,
  TaskStatus,
  TaskType,
  RiskLevel,
  Question,
  QuestionStatus,
  RunRecord,
  HumanTouches,
  RunResult,
  MutationBudgetState,
  MutationBudgetConfig,
  MutationAction,
  FlowType,
  FlowTemplate,
  FlowPhase,
  FlowRule,
  FlowPhaseTransition,
} from './types.js';

export { DEFAULT_MUTATION_BUDGET_CONFIG } from './types.js';

// Modules
export { StateSnapshotManager, createSnapshot, emptyKnowledge, emptyFriction } from './state-snapshot.js';
export { TaskManager } from './task-manager.js';
export { QuestionQueue } from './question-queue.js';
export { RunRecordStore, createRunRecord, emptyHumanTouches } from './run-record.js';
export { MutationTracker } from './mutation-tracker.js';
export type { MutationCheckResult } from './mutation-tracker.js';
export {
  getFlowTemplate,
  getFlowTypes,
  validatePhaseTransition,
  getPhaseNames,
  DEBUG_FLOW,
  FEATURE_FLOW,
  REFACTOR_FLOW,
} from './flow-templates.js';

// ─── SessionModel facade ───

import { StateSnapshotManager } from './state-snapshot.js';
import { TaskManager } from './task-manager.js';
import { QuestionQueue } from './question-queue.js';
import { RunRecordStore } from './run-record.js';
import { MutationTracker } from './mutation-tracker.js';
import type { MutationBudgetConfig } from './types.js';

export interface SessionModelConfig {
  /** Path to the .agent/ directory for this project */
  agentDir: string;
  /** Optional mutation budget overrides */
  mutationBudget?: Partial<MutationBudgetConfig>;
}

/**
 * SessionModel — unified facade over all session lifecycle components.
 *
 * Usage:
 * ```ts
 * const session = new SessionModel({ agentDir: '.agent' });
 * await session.initialize();  // loads state from disk
 * // ... use session.tasks, session.questions, etc.
 * await session.finalize();    // persists state to disk
 * ```
 */
export class SessionModel {
  readonly snapshot: StateSnapshotManager;
  readonly tasks: TaskManager;
  readonly questions: QuestionQueue;
  readonly runRecords: RunRecordStore;
  readonly mutations: MutationTracker;

  constructor(config: SessionModelConfig) {
    this.snapshot = new StateSnapshotManager(config.agentDir);
    this.tasks = new TaskManager(config.agentDir);
    this.questions = new QuestionQueue(config.agentDir);
    this.runRecords = new RunRecordStore(config.agentDir);
    this.mutations = new MutationTracker(config.mutationBudget);
  }

  /** Load all session state from disk. Call at pipeline start. */
  async initialize(): Promise<void> {
    await Promise.all([
      this.snapshot.load(),
      this.tasks.load(),
      this.questions.load(),
      this.runRecords.load(),
    ]);
  }

  /** Persist all session state to disk. Call at pipeline end. */
  async finalize(): Promise<void> {
    await Promise.all([
      this.snapshot.save(),
      this.tasks.save(),
      this.questions.save(),
    ]);
  }

  /**
   * Check if a run record has been written for any active task.
   * Returns task IDs that completed work but lack a run record.
   */
  missingRunRecords(): string[] {
    const activeTasks = this.snapshot.current.activeTasks;
    return activeTasks.filter(id => !this.runRecords.hasRecordForTask(id));
  }
}
