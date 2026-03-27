/**
 * Session model tests: task dependency resolution, mutation budget
 * state transitions, and flow phase validation.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { TaskManager } from '../session/task-manager.js';
import { MutationTracker } from '../session/mutation-tracker.js';
import {
  validatePhaseTransition,
  getFlowTemplate,
  getPhaseNames,
  DEBUG_FLOW,
  FEATURE_FLOW,
  REFACTOR_FLOW,
} from '../session/flow-templates.js';
import { QuestionQueue } from '../session/question-queue.js';
import type { Task, FlowType } from '../session/types.js';

// ─── Helpers ───

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    description: `Task ${overrides.id}`,
    taskType: 'feature',
    status: 'pending',
    priority: 'medium',
    riskLevel: 'low',
    blockedBy: [],
    ownedPaths: [],
    flowPhase: null,
    assignedTo: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Task Dependency Resolution ───

describe('TaskManager.ready()', () => {
  let manager: TaskManager;

  beforeEach(() => {
    // Use a temp dir that won't actually be written to in these tests
    manager = new TaskManager('/tmp/crucible-test-agent');
  });

  it('should return pending tasks with no dependencies', () => {
    manager.add(makeTask({ id: 'tf-001' }));
    manager.add(makeTask({ id: 'tf-002' }));

    const ready = manager.ready();
    assert.equal(ready.length, 2);
  });

  it('should not return tasks with incomplete dependencies', () => {
    manager.add(makeTask({ id: 'tf-001' }));
    manager.add(makeTask({ id: 'tf-002', blockedBy: ['tf-001'] }));

    const ready = manager.ready();
    assert.equal(ready.length, 1);
    assert.equal(ready[0].id, 'tf-001');
  });

  it('should return tasks whose dependencies are all complete', () => {
    manager.add(makeTask({ id: 'tf-001', status: 'complete' }));
    manager.add(makeTask({ id: 'tf-002', blockedBy: ['tf-001'] }));

    const ready = manager.ready();
    assert.equal(ready.length, 1);
    assert.equal(ready[0].id, 'tf-002');
  });

  it('should sort by priority: critical > high > medium > low', () => {
    manager.add(makeTask({ id: 'tf-low', priority: 'low' }));
    manager.add(makeTask({ id: 'tf-crit', priority: 'critical' }));
    manager.add(makeTask({ id: 'tf-high', priority: 'high' }));
    manager.add(makeTask({ id: 'tf-med', priority: 'medium' }));

    const ready = manager.ready();
    assert.deepEqual(
      ready.map(t => t.id),
      ['tf-crit', 'tf-high', 'tf-med', 'tf-low']
    );
  });

  it('should not return in_progress or complete tasks', () => {
    manager.add(makeTask({ id: 'tf-001', status: 'in_progress' }));
    manager.add(makeTask({ id: 'tf-002', status: 'complete' }));
    manager.add(makeTask({ id: 'tf-003', status: 'pending' }));

    const ready = manager.ready();
    assert.equal(ready.length, 1);
    assert.equal(ready[0].id, 'tf-003');
  });

  it('should handle diamond dependencies', () => {
    //   A
    //  / \
    // B   C
    //  \ /
    //   D
    manager.add(makeTask({ id: 'A', status: 'complete' }));
    manager.add(makeTask({ id: 'B', blockedBy: ['A'], status: 'complete' }));
    manager.add(makeTask({ id: 'C', blockedBy: ['A'], status: 'complete' }));
    manager.add(makeTask({ id: 'D', blockedBy: ['B', 'C'] }));

    const ready = manager.ready();
    assert.equal(ready.length, 1);
    assert.equal(ready[0].id, 'D');
  });

  it('should block D when only one of its deps is complete', () => {
    manager.add(makeTask({ id: 'A', status: 'complete' }));
    manager.add(makeTask({ id: 'B', blockedBy: ['A'], status: 'complete' }));
    manager.add(makeTask({ id: 'C', blockedBy: ['A'] })); // still pending
    manager.add(makeTask({ id: 'D', blockedBy: ['B', 'C'] }));

    const ready = manager.ready();
    assert.equal(ready.length, 1);
    assert.equal(ready[0].id, 'C');
  });

  it('should return empty when all tasks are blocked', () => {
    manager.add(makeTask({ id: 'A', blockedBy: ['B'] }));
    manager.add(makeTask({ id: 'B', blockedBy: ['A'] })); // circular

    const ready = manager.ready();
    assert.equal(ready.length, 0);
  });
});

describe('TaskManager.claim()', () => {
  it('should set status to in_progress and assign', () => {
    const manager = new TaskManager('/tmp/crucible-test-agent');
    manager.add(makeTask({ id: 'tf-001' }));

    const claimed = manager.claim('tf-001', 'session-abc');
    assert.equal(claimed.status, 'in_progress');
    assert.equal(claimed.assignedTo, 'session-abc');
  });

  it('should throw when claiming non-pending task', () => {
    const manager = new TaskManager('/tmp/crucible-test-agent');
    manager.add(makeTask({ id: 'tf-001', status: 'complete' }));

    assert.throws(() => manager.claim('tf-001', 'session-abc'), /not pending/);
  });
});

describe('TaskManager.complete()', () => {
  it('should require a run record ID', () => {
    const manager = new TaskManager('/tmp/crucible-test-agent');
    manager.add(makeTask({ id: 'tf-001', status: 'in_progress' }));

    assert.throws(() => manager.complete('tf-001', ''), /Run record ID required/);
  });

  it('should set status to complete with valid run record', () => {
    const manager = new TaskManager('/tmp/crucible-test-agent');
    manager.add(makeTask({ id: 'tf-001', status: 'in_progress' }));

    const completed = manager.complete('tf-001', 'run-abc123');
    assert.equal(completed.status, 'complete');
  });
});

// ─── Mutation Budget State Transitions ───

describe('MutationTracker', () => {
  let tracker: MutationTracker;

  beforeEach(() => {
    tracker = new MutationTracker();
  });

  it('should allow first mutation', () => {
    const check = tracker.preMutation('src/foo.ts');
    assert.equal(check.allowed, true);
  });

  it('should block after 2 consecutive mutations without test', () => {
    assert.equal(tracker.preMutation('src/a.ts').allowed, true);
    tracker.postMutation('src/a.ts');

    assert.equal(tracker.preMutation('src/b.ts').allowed, true);
    tracker.postMutation('src/b.ts');

    const check = tracker.preMutation('src/c.ts');
    assert.equal(check.allowed, false);
    assert.ok('reason' in check && check.reason.includes('Consecutive'));
  });

  it('should reset consecutive counter on test run', () => {
    tracker.postMutation('src/a.ts');
    tracker.postMutation('src/b.ts');
    tracker.recordTestRun();

    const check = tracker.preMutation('src/c.ts');
    assert.equal(check.allowed, true);
  });

  it('should block after compound budget exhausted (10 mutations)', () => {
    for (let i = 0; i < 10; i++) {
      tracker.postMutation(`src/file${i}.ts`);
      // Run tests every mutation to keep consecutive counter at 0
      tracker.recordTestRun();
    }
    // We've hit 10 edit-test cycles which triggers the cycle breaker at 4.
    // Use a fresh tracker with higher cycle cap to isolate the compound test.
    const t2 = new MutationTracker({ editTestCycleCap: 100 });
    for (let i = 0; i < 10; i++) {
      t2.postMutation(`src/file${i}.ts`);
      t2.recordTestRun();
    }

    const check = t2.preMutation('src/file10.ts');
    assert.equal(check.allowed, false);
    assert.ok('reason' in check && check.reason.includes('Compound'));
  });

  it('should halt after 4 edit-test cycles', () => {
    for (let cycle = 0; cycle < 4; cycle++) {
      tracker.postMutation(`src/foo.ts`);
      tracker.recordTestRun();
    }

    assert.equal(tracker.isHalted, true);
    const check = tracker.preMutation('src/foo.ts');
    assert.equal(check.allowed, false);
  });

  it('should halt when unique files cap reached', () => {
    // Use a tracker with high cycle and compound caps to isolate unique files test
    const t2 = new MutationTracker({ editTestCycleCap: 100, compoundBudget: 100 });
    for (let i = 0; i < 10; i++) {
      t2.postMutation(`src/file${i}.ts`);
      t2.recordTestRun();
    }

    const check = t2.preMutation('src/file10.ts');
    assert.equal(check.allowed, false);
    assert.ok('reason' in check && check.reason.includes('Unique files'));
  });

  it('should allow same file mutation without incrementing unique count', () => {
    tracker.preMutation('src/foo.ts');
    tracker.postMutation('src/foo.ts');
    tracker.recordTestRun();

    tracker.preMutation('src/foo.ts');
    tracker.postMutation('src/foo.ts');

    const state = tracker.getState();
    assert.equal(state.uniqueFiles.length, 1);
    assert.equal(state.totalMutations, 2);
  });

  it('should fully reset on resetBudget', () => {
    for (let i = 0; i < 5; i++) {
      tracker.postMutation(`src/file${i}.ts`);
      if (i % 2 === 1) tracker.recordTestRun();
    }
    tracker.resetBudget();

    const state = tracker.getState();
    assert.equal(state.totalMutations, 0);
    assert.equal(state.consecutiveMutations, 0);
    assert.equal(state.uniqueFiles.length, 0);
    assert.equal(state.halted, false);
  });

  it('should reset node-level counters without affecting graph-level', () => {
    tracker.postMutation('src/a.ts');
    tracker.postMutation('src/b.ts');
    tracker.resetNode();

    const state = tracker.getState();
    assert.equal(state.consecutiveMutations, 0);
    assert.equal(state.editTestCycles, 0);
    assert.equal(state.totalMutations, 2); // graph-level preserved
  });
});

// ─── Flow Phase Validation ───

describe('Flow Templates', () => {
  it('should have all three flow types', () => {
    assert.ok(DEBUG_FLOW);
    assert.ok(FEATURE_FLOW);
    assert.ok(REFACTOR_FLOW);
  });

  it('should look up flow by type', () => {
    const debug = getFlowTemplate('debug');
    assert.equal(debug.type, 'debug');
    assert.equal(debug.phases.length, 5);
  });

  it('should throw for unknown flow type', () => {
    assert.throws(() => getFlowTemplate('unknown' as FlowType), /Unknown flow type/);
  });

  it('should return phase names in order', () => {
    const names = getPhaseNames('debug');
    assert.deepEqual(names, ['reproduce', 'isolate', 'diagnose', 'fix', 'verify']);
  });

  it('should validate forward transition', () => {
    const result = validatePhaseTransition(DEBUG_FLOW, 'reproduce', 'isolate');
    assert.equal(result.valid, true);
    assert.equal(result.reason, null);
  });

  it('should reject backward transition', () => {
    const result = validatePhaseTransition(DEBUG_FLOW, 'fix', 'reproduce');
    assert.equal(result.valid, false);
    assert.ok(result.reason?.includes('backward'));
  });

  it('should reject skipping phases', () => {
    const result = validatePhaseTransition(DEBUG_FLOW, 'reproduce', 'fix');
    assert.equal(result.valid, false);
    assert.ok(result.reason?.includes('skip'));
  });

  it('should reject unknown phase names', () => {
    const result = validatePhaseTransition(DEBUG_FLOW, 'nonexistent', 'isolate');
    assert.equal(result.valid, false);
    assert.ok(result.reason?.includes('Unknown'));
  });

  it('should validate all sequential transitions in feature flow', () => {
    const phases = getPhaseNames('feature');
    for (let i = 0; i < phases.length - 1; i++) {
      const result = validatePhaseTransition(FEATURE_FLOW, phases[i], phases[i + 1]);
      assert.equal(result.valid, true, `${phases[i]} -> ${phases[i + 1]} should be valid`);
    }
  });

  it('should have hard rules for key constraints', () => {
    const debugHard = DEBUG_FLOW.rules.filter(r => r.enforcement === 'hard');
    assert.ok(debugHard.some(r => r.name === 'reproduce_before_fix'));
    assert.ok(debugHard.some(r => r.name === 'two_attempt_cap'));

    const featureHard = FEATURE_FLOW.rules.filter(r => r.enforcement === 'hard');
    assert.ok(featureHard.some(r => r.name === 'spec_before_code'));

    const refactorHard = REFACTOR_FLOW.rules.filter(r => r.enforcement === 'hard');
    assert.ok(refactorHard.some(r => r.name === 'no_behavior_change'));
  });
});

// ─── Question Queue ───

describe('QuestionQueue', () => {
  let queue: QuestionQueue;

  beforeEach(() => {
    queue = new QuestionQueue('/tmp/crucible-test-agent');
  });

  it('should ask and retrieve a question', () => {
    const q = queue.ask({
      id: 'q-001',
      task: 'tf-001',
      question: 'Use Redis or in-memory cache?',
      options: ['Redis', 'in-memory'],
      default: 'in-memory',
      impact: 'Affects persistence across restarts',
    });

    assert.equal(q.status, 'pending');
    assert.equal(queue.pending().length, 1);
  });

  it('should answer a pending question', () => {
    queue.ask({
      id: 'q-001',
      task: 'tf-001',
      question: 'Use Redis or in-memory cache?',
      options: ['Redis', 'in-memory'],
      default: 'in-memory',
      impact: 'Affects persistence',
    });

    const answered = queue.answer('q-001', 'Redis');
    assert.equal(answered.status, 'answered');
    assert.equal(answered.answer, 'Redis');
    assert.ok(answered.answered);
  });

  it('should throw when answering non-pending question', () => {
    queue.ask({
      id: 'q-001',
      task: 'tf-001',
      question: 'Test?',
      options: ['A', 'B'],
      default: 'A',
      impact: 'None',
    });
    queue.answer('q-001', 'A');

    assert.throws(() => queue.answer('q-001', 'B'), /not pending/);
  });

  it('should filter questions by task', () => {
    queue.ask({ id: 'q-001', task: 'tf-001', question: 'Q1?', options: ['A'], default: 'A', impact: '' });
    queue.ask({ id: 'q-002', task: 'tf-002', question: 'Q2?', options: ['B'], default: 'B', impact: '' });
    queue.ask({ id: 'q-003', task: 'tf-001', question: 'Q3?', options: ['C'], default: 'C', impact: '' });

    const forTask1 = queue.forTask('tf-001');
    assert.equal(forTask1.length, 2);
  });

  it('should find newly answered questions', () => {
    queue.ask({ id: 'q-001', task: 'tf-001', question: 'Q1?', options: ['A'], default: 'A', impact: '' });
    queue.ask({ id: 'q-002', task: 'tf-001', question: 'Q2?', options: ['B'], default: 'B', impact: '' });
    queue.answer('q-001', 'A');
    queue.answer('q-002', 'B');

    const known = new Set(['q-001']);
    const newly = queue.newlyAnswered(known);
    assert.equal(newly.length, 1);
    assert.equal(newly[0].id, 'q-002');
  });
});
