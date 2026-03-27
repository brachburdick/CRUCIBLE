/**
 * Flow Templates — structured representations of THE_FACTORY's three flow types.
 *
 * These are injected into agent system prompts by the RunEngine (Phase 3).
 * They are structured objects (not just strings) so the RunEngine can
 * programmatically check phase transitions and enforce gates.
 */

import type { FlowTemplate, FlowPhase, FlowRule, FlowPhaseTransition, FlowType } from './types.js';

// ─── Debug Flow ───
// Reproduce -> Isolate -> Diagnose -> Fix -> Verify

const DEBUG_PHASES: FlowPhase[] = [
  {
    name: 'reproduce',
    description: 'Create or identify a failing test that reproduces the bug.',
    entryGates: ['task_claimed', 'risk_level_set'],
    exitGates: ['reproduction_test_exists', 'reproduction_test_fails'],
  },
  {
    name: 'isolate',
    description: 'Narrow down the root cause location.',
    entryGates: ['reproduction_test_exists'],
    exitGates: ['root_cause_location_identified'],
  },
  {
    name: 'diagnose',
    description: 'Understand why the bug occurs at the identified location.',
    entryGates: ['root_cause_location_identified'],
    exitGates: ['root_cause_understood'],
  },
  {
    name: 'fix',
    description: 'Apply the minimal fix for the root cause.',
    entryGates: ['root_cause_understood'],
    exitGates: ['fix_applied', 'reproduction_test_passes'],
  },
  {
    name: 'verify',
    description: 'Confirm no regressions and write run record.',
    entryGates: ['reproduction_test_passes'],
    exitGates: ['no_regressions', 'run_record_written'],
  },
];

const DEBUG_RULES: FlowRule[] = [
  {
    name: 'reproduce_before_fix',
    description: 'A failing reproduction test must exist before any fix is attempted.',
    enforcement: 'hard',
  },
  {
    name: 'two_attempt_cap',
    description: 'After 2 failed fix attempts, escalate to operator.',
    enforcement: 'hard',
  },
  {
    name: 'no_refactor_during_fix',
    description: 'Do not refactor while fixing. File a separate task.',
    enforcement: 'advisory',
  },
  {
    name: 'separate_context_verification',
    description: 'The context that wrote the fix must not be the only context that certifies it.',
    enforcement: 'advisory',
  },
  {
    name: 'context_gate',
    description: 'End session with result: "partial" if turn count > 40 or context degradation detected.',
    enforcement: 'hard',
  },
];

export const DEBUG_FLOW: FlowTemplate = {
  type: 'debug',
  description: 'Reproduce -> Isolate -> Diagnose -> Fix -> Verify. Minimal change, reproduce first.',
  phases: DEBUG_PHASES,
  rules: DEBUG_RULES,
};

// ─── Feature Flow ───
// Intent -> Spec -> Plan -> Implement -> Test -> Verify

const FEATURE_PHASES: FlowPhase[] = [
  {
    name: 'intent',
    description: 'Confirm problem statement, desired outcome, non-goals, constraints, and acceptance criteria.',
    entryGates: ['task_claimed'],
    exitGates: ['acceptance_criteria_exist', 'risk_level_set'],
  },
  {
    name: 'spec',
    description: 'Define inputs, outputs, edge cases in a spec document.',
    entryGates: ['acceptance_criteria_exist'],
    exitGates: ['spec_confirmed_by_operator'],
  },
  {
    name: 'plan',
    description: 'Design the implementation approach and identify affected files/sections.',
    entryGates: ['spec_confirmed_by_operator'],
    exitGates: ['plan_approved'],
  },
  {
    name: 'implement',
    description: 'Write the implementation code.',
    entryGates: ['plan_approved'],
    exitGates: ['implementation_complete'],
  },
  {
    name: 'test',
    description: 'Write and run tests covering all acceptance criteria.',
    entryGates: ['implementation_complete'],
    exitGates: ['all_tests_pass', 'acceptance_criteria_covered'],
  },
  {
    name: 'verify',
    description: 'Final verification, no regressions, write run record.',
    entryGates: ['all_tests_pass'],
    exitGates: ['no_regressions', 'run_record_written'],
  },
];

const FEATURE_RULES: FlowRule[] = [
  {
    name: 'spec_before_code',
    description: 'Human confirmation of spec required before implementation begins.',
    enforcement: 'hard',
  },
  {
    name: 'two_attempt_cap',
    description: 'After 2 failed implementation attempts, escalate to operator.',
    enforcement: 'hard',
  },
  {
    name: 'no_feature_creep',
    description: 'Do not combine feature work with refactoring.',
    enforcement: 'advisory',
  },
  {
    name: 'session_scope_budgeting',
    description: 'If spec + plan + implement + tests exceeds context window, split now.',
    enforcement: 'hard',
  },
  {
    name: 'context_gate',
    description: 'End session with result: "partial" if turn count > 40 or context degradation detected.',
    enforcement: 'hard',
  },
];

export const FEATURE_FLOW: FlowTemplate = {
  type: 'feature',
  description: 'Intent -> Spec -> Plan -> Implement -> Test -> Verify. Spec first, human confirms.',
  phases: FEATURE_PHASES,
  rules: FEATURE_RULES,
};

// ─── Refactor Flow ───
// Scope -> Snapshot -> Transform -> Verify

const REFACTOR_PHASES: FlowPhase[] = [
  {
    name: 'scope',
    description: 'Define what behavior must NOT change and what structural goals to achieve.',
    entryGates: ['task_claimed', 'risk_level_set'],
    exitGates: ['preservation_criteria_exist', 'structural_goals_defined'],
  },
  {
    name: 'snapshot',
    description: 'Run full test suite and record baseline results. Write characterization tests if coverage insufficient.',
    entryGates: ['preservation_criteria_exist'],
    exitGates: ['baseline_tests_recorded'],
  },
  {
    name: 'transform',
    description: 'Apply incremental structural changes. Run tests after each significant change.',
    entryGates: ['baseline_tests_recorded'],
    exitGates: ['transform_complete', 'tests_match_baseline'],
  },
  {
    name: 'verify',
    description: 'Final test suite run. Results must match baseline. Write run record.',
    entryGates: ['tests_match_baseline'],
    exitGates: ['no_regressions', 'run_record_written'],
  },
];

const REFACTOR_RULES: FlowRule[] = [
  {
    name: 'no_behavior_change',
    description: 'Refactors must not change observable behavior. Cardinal rule.',
    enforcement: 'hard',
  },
  {
    name: 'read_before_change',
    description: 'Read ALL files in scope before changing any.',
    enforcement: 'hard',
  },
  {
    name: 'two_attempt_cap',
    description: 'After 2 failed revert-fix cycles, revert to pre-transform state and escalate.',
    enforcement: 'hard',
  },
  {
    name: 'incremental_transforms',
    description: 'Run tests after each significant change, not just at the end.',
    enforcement: 'advisory',
  },
  {
    name: 'context_gate',
    description: 'End session with result: "partial" if turn count > 40 or context degradation detected.',
    enforcement: 'hard',
  },
];

export const REFACTOR_FLOW: FlowTemplate = {
  type: 'refactor',
  description: 'Scope -> Snapshot -> Transform -> Verify. Read first, no behavior change.',
  phases: REFACTOR_PHASES,
  rules: REFACTOR_RULES,
};

// ─── Flow Registry ───

const FLOW_REGISTRY: Map<FlowType, FlowTemplate> = new Map([
  ['debug', DEBUG_FLOW],
  ['feature', FEATURE_FLOW],
  ['refactor', REFACTOR_FLOW],
]);

/** Get the flow template for a given flow type. */
export function getFlowTemplate(type: FlowType): FlowTemplate {
  const flow = FLOW_REGISTRY.get(type);
  if (!flow) {
    throw new Error(`Unknown flow type: ${type}`);
  }
  return flow;
}

/** Get all available flow types. */
export function getFlowTypes(): FlowType[] {
  return Array.from(FLOW_REGISTRY.keys());
}

/**
 * Validate a phase transition within a flow.
 * Phases must progress forward — no skipping, no going backward.
 */
export function validatePhaseTransition(
  flow: FlowTemplate,
  fromPhase: string,
  toPhase: string
): FlowPhaseTransition {
  const fromIndex = flow.phases.findIndex(p => p.name === fromPhase);
  const toIndex = flow.phases.findIndex(p => p.name === toPhase);

  if (fromIndex === -1) {
    return { from: fromPhase, to: toPhase, valid: false, reason: `Unknown phase: ${fromPhase}` };
  }
  if (toIndex === -1) {
    return { from: fromPhase, to: toPhase, valid: false, reason: `Unknown phase: ${toPhase}` };
  }
  if (toIndex !== fromIndex + 1) {
    return {
      from: fromPhase,
      to: toPhase,
      valid: false,
      reason: toIndex <= fromIndex
        ? `Cannot go backward from ${fromPhase} to ${toPhase}`
        : `Cannot skip phases: ${fromPhase} -> ${toPhase} (expected ${flow.phases[fromIndex + 1].name})`,
    };
  }

  return { from: fromPhase, to: toPhase, valid: true, reason: null };
}

/**
 * Get the phase names for a flow type (for system prompt injection).
 */
export function getPhaseNames(type: FlowType): string[] {
  const flow = getFlowTemplate(type);
  return flow.phases.map(p => p.name);
}
