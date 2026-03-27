/**
 * Mutation Budget Tracker — prevents runaway edits without test verification.
 *
 * Enforces THE_FACTORY's three-tier mutation discipline:
 * - Per-node: 2 consecutive source mutations without test = blocked
 * - Per-graph: 10 total mutations compound budget (resets on budget-reset)
 * - Circuit breakers: 4 edit-test cycles per node = halt, 10 unique files = halt
 *
 * The RunEngine calls pre/post each tool use to check if execution should continue.
 */

import type { MutationBudgetState, MutationBudgetConfig } from './types.js';
import { DEFAULT_MUTATION_BUDGET_CONFIG } from './types.js';

export type MutationCheckResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export class MutationTracker {
  private readonly config: MutationBudgetConfig;
  private state: MutationBudgetState;

  constructor(config?: Partial<MutationBudgetConfig>) {
    this.config = { ...DEFAULT_MUTATION_BUDGET_CONFIG, ...config };
    this.state = this.freshState();
  }

  private freshState(): MutationBudgetState {
    return {
      consecutiveMutations: 0,
      totalMutations: 0,
      editTestCycles: 0,
      uniqueFiles: new Set<string>(),
      halted: false,
      haltReason: null,
    };
  }

  /** Get current state (with uniqueFiles as array for serialization). */
  getState(): Omit<MutationBudgetState, 'uniqueFiles'> & { uniqueFiles: string[] } {
    return {
      ...this.state,
      uniqueFiles: Array.from(this.state.uniqueFiles),
    };
  }

  /** Check whether a mutation is allowed before executing it. */
  preMutation(filePath: string): MutationCheckResult {
    if (this.state.halted) {
      return { allowed: false, reason: this.state.haltReason ?? 'Budget halted' };
    }

    // Per-node: consecutive mutations without test
    if (this.state.consecutiveMutations >= this.config.consecutiveCap) {
      return {
        allowed: false,
        reason: `Consecutive mutation cap reached (${this.config.consecutiveCap}). Run tests before continuing.`,
      };
    }

    // Per-graph: compound budget
    if (this.state.totalMutations >= this.config.compoundBudget) {
      return {
        allowed: false,
        reason: `Compound mutation budget exhausted (${this.config.compoundBudget}). Reset budget to continue.`,
      };
    }

    // Circuit breaker: unique files
    const wouldAdd = !this.state.uniqueFiles.has(filePath);
    if (wouldAdd && this.state.uniqueFiles.size >= this.config.uniqueFilesCap) {
      this.halt(`Unique files circuit breaker: ${this.config.uniqueFilesCap} files modified across graph`);
      return { allowed: false, reason: this.state.haltReason! };
    }

    return { allowed: true };
  }

  /** Record that a mutation was performed. Call after a successful edit/write. */
  postMutation(filePath: string): void {
    this.state.consecutiveMutations++;
    this.state.totalMutations++;
    this.state.uniqueFiles.add(filePath);
  }

  /** Record that tests were run. Resets the per-node consecutive counter. */
  recordTestRun(): void {
    // If there were mutations before this test, that's one edit-test cycle.
    if (this.state.consecutiveMutations > 0) {
      this.state.editTestCycles++;
    }
    this.state.consecutiveMutations = 0;

    // Circuit breaker: edit-test cycles
    if (this.state.editTestCycles >= this.config.editTestCycleCap) {
      this.halt(`Edit-test cycle circuit breaker: ${this.config.editTestCycleCap} cycles on same node`);
    }
  }

  /** Reset the per-node state (when switching to a new node). */
  resetNode(): void {
    this.state.consecutiveMutations = 0;
    this.state.editTestCycles = 0;
  }

  /** Full budget reset (compound budget). */
  resetBudget(): void {
    this.state = this.freshState();
  }

  /** Whether the tracker is halted. */
  get isHalted(): boolean {
    return this.state.halted;
  }

  private halt(reason: string): void {
    this.state.halted = true;
    this.state.haltReason = reason;
  }
}
