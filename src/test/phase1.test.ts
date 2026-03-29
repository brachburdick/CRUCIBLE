/**
 * Phase 1 tests: ReadinessGate, QuestionGenerator, preflight.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ReadinessGate } from '../engine/ReadinessGate.js';
import { generateQuestions, preflight } from '../engine/QuestionGenerator.js';
import type { TaskPayload } from '../types/index.js';

const WELL_SPECIFIED_TASK: TaskPayload = {
  description: 'Fix a pricing bug where discounts are applied incorrectly',
  instructions: 'Debug the discount calculation in pricing.py and fix it. Run python test_orders.py to verify.',
  files: { 'pricing.py': 'def calc(): pass', 'orders.py': 'import pricing' },
  checks: [
    { name: 'all tests pass', type: 'exec', command: 'python test_orders.py' },
    { name: 'fix is correct', type: 'exec', command: 'python -c "from pricing import get_discount_multiplier; assert get_discount_multiplier(\'SAVE20\') == 0.8"' },
  ],
};

const VAGUE_TASK: TaskPayload = {
  description: 'Make it faster',
  instructions: 'Improve performance',
};

const AMBIGUOUS_BUT_SPECIFIED_TASK: TaskPayload = {
  description: 'Make the API endpoint faster — reduce response time to under 200ms',
  instructions: 'Optimize the /api/search endpoint in src/routes/search.ts. Run npm test to verify no regressions.',
  files: { 'src/routes/search.ts': 'export function search() {}' },
  checks: [{ name: 'tests pass', type: 'exec', command: 'npm test' }],
};

describe('ReadinessGate', () => {
  it('passes a well-specified task', async () => {
    const gate = new ReadinessGate();
    const assessment = await gate.assess(WELL_SPECIFIED_TASK);

    assert.ok(assessment.passedAt !== null, 'Well-specified task should pass');
    assert.ok(assessment.compositeScore >= 0.8, `Composite score ${assessment.compositeScore} should be >= 0.8`);

    // All hard checks should pass
    const requiredChecks = assessment.checks.filter(c => c.binding === 'required');
    for (const check of requiredChecks) {
      assert.ok(check.passed, `Required check "${check.rule}" should pass: ${check.detail}`);
    }
  });

  it('fails a vague task with specific reasons', async () => {
    const gate = new ReadinessGate();
    const assessment = await gate.assess(VAGUE_TASK);

    assert.ok(assessment.passedAt === null, 'Vague task should fail');
    assert.ok(assessment.compositeScore < 0.8, `Composite score ${assessment.compositeScore} should be < 0.8`);

    // Check specific failures
    const failedRules = assessment.checks.filter(c => !c.passed).map(c => c.rule);
    assert.ok(failedRules.includes('has_acceptance_criteria'), 'Should fail has_acceptance_criteria');
    assert.ok(failedRules.includes('has_scope_boundary'), 'Should fail has_scope_boundary');
    assert.ok(failedRules.includes('has_verification_command'), 'Should fail has_verification_command');
    assert.ok(failedRules.includes('no_ambiguous_terms'), 'Should fail no_ambiguous_terms (contains "faster")');
  });

  it('no_ambiguous_terms is advisory — does not block in triage mode', async () => {
    // Task that fails ONLY the ambiguity check
    const taskWithAmbiguity: TaskPayload = {
      description: 'Refactor the code to be clean and simple',
      instructions: 'Extract the validator from src/engine/validation.ts into its own module. Run npm test to verify.',
      files: { 'src/engine/validation.ts': 'export function validate() {}' },
      checks: [{ name: 'tests pass', type: 'exec', command: 'npm test' }],
    };

    const gate = new ReadinessGate({ gateMode: 'triage' });
    const assessment = await gate.assess(taskWithAmbiguity);

    // Ambiguity check should fail
    const ambiguityCheck = assessment.checks.find(c => c.rule === 'no_ambiguous_terms');
    assert.ok(ambiguityCheck, 'no_ambiguous_terms check should exist');
    assert.equal(ambiguityCheck!.passed, false, 'Should detect ambiguous terms');
    assert.equal(ambiguityCheck!.binding, 'advisory', 'Should be advisory binding');

    // But the task should still pass in triage mode (advisory doesn't hard-block)
    assert.ok(assessment.passedAt !== null, 'Task should pass despite advisory failure in triage mode');
  });

  it('hard-block mode blocks on any failed hard check', async () => {
    const gate = new ReadinessGate({ gateMode: 'hard-block' });
    const assessment = await gate.assess(VAGUE_TASK);

    assert.ok(assessment.passedAt === null, 'Should be blocked in hard-block mode');
    assert.equal(assessment.gateMode, 'hard-block');
  });

  it('handles qualified ambiguous terms correctly', async () => {
    const gate = new ReadinessGate();
    const assessment = await gate.assess(AMBIGUOUS_BUT_SPECIFIED_TASK);

    // "faster" is qualified with "under 200ms" — should pass ambiguity check
    const ambiguityCheck = assessment.checks.find(c => c.rule === 'no_ambiguous_terms');
    assert.ok(ambiguityCheck, 'Should have ambiguity check');
    assert.ok(ambiguityCheck!.passed, 'Qualified ambiguous term should pass');
  });

  it('computes composite score correctly', async () => {
    const gate = new ReadinessGate({ globalWeight: 0.7 });
    const assessment = await gate.assess(WELL_SPECIFIED_TASK);

    // dynamicScore is 1.0 in Phase 1
    assert.equal(assessment.dynamicScore, 1.0);
    // compositeScore = 0.7 * globalScore + 0.3 * 1.0
    const expected = 0.7 * assessment.globalScore + 0.3 * 1.0;
    assert.ok(
      Math.abs(assessment.compositeScore - expected) < 0.001,
      `Composite ${assessment.compositeScore} should equal ${expected}`,
    );
  });
});

describe('QuestionGenerator', () => {
  it('generates questions for failed checks', async () => {
    const gate = new ReadinessGate();
    const assessment = await gate.assess(VAGUE_TASK);

    const questions = generateQuestions(assessment, 'task-001');

    assert.ok(questions.length > 0, 'Should generate at least one question');

    for (const q of questions) {
      assert.ok(q.id.startsWith('q-auto-'), `Question ID should start with q-auto-: ${q.id}`);
      assert.equal(q.task, 'task-001');
      assert.equal(q.status, 'pending');
      assert.ok(q.question.length > 0, 'Question text should be non-empty');
      assert.ok(q.options.length > 0, 'Should have options');
      assert.ok(q.default.length > 0, 'Should have a default');
      assert.ok(q.impact.length > 0, 'Should have impact description');
      assert.ok(q.asked, 'Should have asked timestamp');
    }
  });

  it('generates no questions for a passing task', async () => {
    const gate = new ReadinessGate();
    const assessment = await gate.assess(WELL_SPECIFIED_TASK);
    const questions = generateQuestions(assessment, 'task-002');

    assert.equal(questions.length, 0, 'Should generate no questions for passing task');
  });
});

describe('preflight', () => {
  it('returns passed=true for well-specified task', async () => {
    const gate = new ReadinessGate();
    const result = await preflight(WELL_SPECIFIED_TASK, gate, 'task-good');

    assert.equal(result.passed, true);
    assert.ok(result.assessment.passedAt !== null);
    assert.equal(result.questions.length, 0);
  });

  it('returns passed=false with questions for vague task', async () => {
    const gate = new ReadinessGate();
    const result = await preflight(VAGUE_TASK, gate, 'task-vague');

    assert.equal(result.passed, false);
    assert.ok(result.questions.length > 0);
    assert.ok(result.assessment.questionsGenerated.length > 0);
  });
});
