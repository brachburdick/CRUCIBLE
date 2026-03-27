/**
 * Mutation Guard — wraps ToolContext to enforce mutation budget at the
 * middleware level.
 *
 * Intercepts writeFile calls to check/record mutations via MutationTracker,
 * and detects test runner commands in exec to trigger recordTestRun().
 */

import type { ToolContext } from '../types/index.js';
import type { MutationTracker } from '../session/mutation-tracker.js';

/** Regex patterns that indicate a test runner invocation. */
const TEST_COMMAND_PATTERNS = [
  /\bpytest\b/,
  /\bjest\b/,
  /\bmocha\b/,
  /\bvitest\b/,
  /\bnpm\s+test\b/,
  /\bnpm\s+run\s+test\b/,
  /\byarn\s+test\b/,
  /\bpnpm\s+test\b/,
  /\bnode\s+--test\b/,
  /\bcargo\s+test\b/,
  /\bgo\s+test\b/,
  /\bmake\s+test\b/,
];

/**
 * Returns true if the command looks like a test runner invocation.
 */
export function isTestCommand(cmd: string): boolean {
  return TEST_COMMAND_PATTERNS.some(pattern => pattern.test(cmd));
}

/**
 * Create a mutation-aware ToolContext wrapper.
 *
 * - writeFile: calls tracker.preMutation() before writing; if blocked,
 *   throws a descriptive error. On success, calls tracker.postMutation().
 * - exec: if the command looks like a test runner, calls tracker.recordTestRun()
 *   after execution.
 * - readFile: passed through unchanged.
 */
export function createMutationGuard(
  tracker: MutationTracker,
  tools: ToolContext,
): ToolContext {
  return {
    readFile: tools.readFile,

    writeFile: async (path: string, content: string): Promise<void> => {
      const check = tracker.preMutation(path);
      if (!check.allowed) {
        throw new Error(`Mutation blocked: ${check.reason}`);
      }
      await tools.writeFile(path, content);
      tracker.postMutation(path);
    },

    exec: async (cmd: string) => {
      const result = await tools.exec(cmd);
      if (isTestCommand(cmd)) {
        tracker.recordTestRun();
      }
      return result;
    },
  };
}
