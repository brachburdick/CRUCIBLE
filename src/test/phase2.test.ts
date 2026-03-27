/**
 * Phase 2 tests: DecompositionEngine, strategies, ComplexityEstimator,
 * CouplingAudit, AdaptiveBounds, variant YAML loading.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { DecompositionEngine } from '../engine/DecompositionEngine.js';
import type { DecompositionContext, DecompositionStrategyConfig } from '../engine/DecompositionEngine.js';
import { D0Strategy } from '../engine/strategies/D0Strategy.js';
import { D4Strategy } from '../engine/strategies/D4Strategy.js';
import { D5Strategy } from '../engine/strategies/D5Strategy.js';
import { estimateComplexity } from '../engine/ComplexityEstimator.js';
import { analyzeStaticCoupling } from '../engine/CouplingAudit.js';
import { shouldStopDecomposing } from '../engine/AdaptiveBounds.js';
import { ReadinessGate } from '../engine/ReadinessGate.js';
import { loadExtendedVariant } from '../engine/variants.js';
import { emptyReadiness, emptyNodeMetrics } from '../types/graph.js';
import type { DecompositionNode } from '../types/graph.js';
import type { TaskPayload, LlmCallFn } from '../types/index.js';

// ─── Mock LLM ───

const mockLlmCall: LlmCallFn = async (messages, _options) => {
  // Return a simple 2-node decomposition as JSON
  const response = JSON.stringify({
    nodes: [
      { id: 'leaf-analyze', description: 'Analyze the code', ownedPaths: ['pricing.py'], acceptanceCriteria: ['Identify root cause'] },
      { id: 'leaf-fix', description: 'Fix the bug', ownedPaths: ['orders.py'], acceptanceCriteria: ['Tests pass'] },
    ],
    edges: [
      { from: 'leaf-analyze', to: 'leaf-fix', type: 'data', description: 'Analysis informs fix' },
    ],
  });

  return {
    content: response,
    usage: { promptTokens: 100, completionTokens: 50 },
    model: 'mock',
  };
};

const BUGFIX_TASK: TaskPayload = {
  description: 'Fix pricing bug where discounts are applied incorrectly',
  instructions: 'Debug and fix the discount calculation. Run python test_orders.py to verify.',
  files: { 'pricing.py': 'def get_discount_multiplier(code): return 1.0 + percentage', 'orders.py': 'from pricing import get_discount_multiplier' },
  checks: [{ name: 'tests pass', type: 'exec', command: 'python test_orders.py' }],
};

const SIMPLE_TASK: TaskPayload = {
  description: 'Write a haiku about programming to a file',
  instructions: 'Write a haiku. Use WRITE_FILE to save it.',
};

function makeContext(config?: Partial<DecompositionStrategyConfig>): DecompositionContext {
  return {
    llmCall: mockLlmCall,
    readinessGate: new ReadinessGate(),
    config: {
      decomposition_trigger: 'hybrid',
      max_depth: 3,
      max_files_hint: 3,
      three_conditions: true,
      compositionality_check: true,
      ...config,
    },
  };
}

// ─── D0Strategy ───

describe('D0Strategy', () => {
  it('produces a 1-node graph for any task', async () => {
    const strategy = new D0Strategy();
    const graph = await strategy.decompose(BUGFIX_TASK, makeContext());

    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.nodes[0]!.type, 'leaf');
    assert.equal(graph.nodes[0]!.status, 'ready');
    assert.equal(graph.rootNodeId, 'root');
    assert.equal(graph.strategyUsed, 'D0');
    assert.equal(graph.edges.length, 0);
  });

  it('carries over task acceptance criteria', async () => {
    const strategy = new D0Strategy();
    const graph = await strategy.decompose(BUGFIX_TASK, makeContext());

    assert.deepEqual(graph.nodes[0]!.acceptanceCriteria, ['tests pass']);
    assert.deepEqual(graph.nodes[0]!.ownedPaths, ['pricing.py', 'orders.py']);
  });
});

// ─── D4Strategy ───

describe('D4Strategy', () => {
  it('produces a multi-node graph using LLM decomposition', async () => {
    const strategy = new D4Strategy();
    const graph = await strategy.decompose(BUGFIX_TASK, makeContext());

    // root + 2 children from mock LLM
    assert.ok(graph.nodes.length >= 3, `Expected >= 3 nodes, got ${graph.nodes.length}`);
    assert.equal(graph.strategyUsed, 'D4');

    // Should have root + leaves
    const root = graph.nodes.find(n => n.id === 'root');
    assert.ok(root);
    assert.equal(root!.type, 'goal');

    const leaves = graph.nodes.filter(n => n.type === 'leaf');
    assert.ok(leaves.length >= 2, `Expected >= 2 leaves, got ${leaves.length}`);
  });

  it('includes edges from LLM decomposition', async () => {
    const strategy = new D4Strategy();
    const graph = await strategy.decompose(BUGFIX_TASK, makeContext());

    assert.ok(graph.edges.length > 0, 'Should have edges');
    // Should have root→child edges and inter-child edges
    const rootEdges = graph.edges.filter(e => e.from === 'root');
    assert.ok(rootEdges.length > 0, 'Should have edges from root to children');
  });

  it('falls back gracefully when LLM fails', async () => {
    const failingLlm: LlmCallFn = async () => {
      throw new Error('LLM unavailable');
    };

    const strategy = new D4Strategy();
    const context = makeContext();
    context.llmCall = failingLlm;
    const graph = await strategy.decompose(BUGFIX_TASK, context);

    // Should still produce a valid graph via fallback
    assert.ok(graph.nodes.length >= 2, `Fallback should produce >= 2 nodes, got ${graph.nodes.length}`);
    assert.ok(graph.strategyUsed === 'D4');
  });
});

// ─── D5Strategy ───

describe('D5Strategy', () => {
  it('starts as a single-node graph (like D0)', async () => {
    const d4 = new D4Strategy();
    const strategy = new D5Strategy(d4);
    const graph = await strategy.decompose(BUGFIX_TASK, makeContext());

    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.nodes[0]!.type, 'leaf');
    assert.equal(graph.nodes[0]!.status, 'ready');
    assert.equal(graph.strategyUsed, 'D5');
  });

  it('can redecompose on simulated failure', async () => {
    const d4 = new D4Strategy();
    const strategy = new D5Strategy(d4);

    // Initial decomposition
    const graph = await strategy.decompose(BUGFIX_TASK, makeContext());
    assert.equal(graph.nodes.length, 1);

    // Simulate failure
    const failedNode = graph.nodes[0]!;
    const failureEvidence = {
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      exitReason: { type: 'completed' as const },
      tokenUsage: { prompt: 500, completion: 200, total: 700 },
      wallTimeMs: 30000,
      mutations: 2,
      testCycles: 1,
      toolCalls: [],
      verificationResults: [
        { checkName: 'tests pass', passed: false, stdout: '', stderr: 'AssertionError', exitCode: 1 },
      ],
    };

    const redecomposed = await strategy.redecompose(
      failedNode,
      failureEvidence,
      graph,
      makeContext(),
    );

    // Should now have more nodes
    assert.ok(redecomposed.nodes.length > 1, `Redecomposed should have > 1 node, got ${redecomposed.nodes.length}`);

    // Original failed node should be marked as failed
    const originalNode = redecomposed.nodes.find(n => n.id === failedNode.id);
    assert.ok(originalNode);
    assert.equal(originalNode!.status, 'failed');
    assert.equal(originalNode!.execution?.exitReason.type, 'redecomposed');
  });
});

// ─── ComplexityEstimator ───

describe('ComplexityEstimator', () => {
  it('classifies a simple task as "simple"', () => {
    const result = estimateComplexity(SIMPLE_TASK);
    assert.equal(result.level, 'simple');
    assert.equal(result.signals.fileCount, 0);
    assert.equal(result.signals.hasDependencies, false);
  });

  it('classifies a multi-file task as "moderate"', () => {
    const result = estimateComplexity(BUGFIX_TASK);
    assert.ok(
      result.level === 'moderate' || result.level === 'complex',
      `Expected moderate or complex, got ${result.level}`,
    );
    assert.equal(result.signals.fileCount, 2);
  });

  it('classifies a 5+ file task as "complex"', () => {
    const complexTask: TaskPayload = {
      description: 'Refactor authentication system across multiple modules',
      instructions: 'Update auth in all files. Depends on database migration completing first.',
      files: {
        'src/auth/login.ts': '',
        'src/auth/logout.ts': '',
        'src/auth/middleware.ts': '',
        'src/db/users.ts': '',
        'src/routes/api.ts': '',
      },
      checks: [
        { name: 'unit tests', type: 'exec', command: 'npm test' },
        { name: 'integration tests', type: 'exec', command: 'npm run test:integration' },
        { name: 'e2e tests', type: 'exec', command: 'npm run test:e2e' },
      ],
    };

    const result = estimateComplexity(complexTask);
    assert.equal(result.level, 'complex');
    assert.equal(result.signals.fileCount, 5);
    assert.ok(result.signals.hasDependencies);
  });
});

// ─── CouplingAudit (static analysis) ───

describe('CouplingAudit static analysis', () => {
  it('detects import-based data coupling', () => {
    const projectFiles = {
      'orders.ts': 'import { getDiscount } from "./pricing";',
      'pricing.ts': 'export function getDiscount() { return 0.8; }',
    };

    const result = analyzeStaticCoupling(['orders.ts'], ['pricing.ts'], projectFiles);
    assert.ok(
      result.couplingType === 'data' || result.couplingType === 'stamp',
      `Expected data or stamp coupling, got ${result.couplingType}`,
    );
    assert.equal(result.couplingSource, 'static');
    assert.ok(result.couplingConfidence > 0.5);
  });

  it('detects common coupling from shared mutable state', () => {
    const projectFiles = {
      'a.ts': 'let sharedState = 0;\nexport let counter = sharedState;',
      'b.ts': 'let sharedState = 0;\nimport { counter } from "./a";',
    };

    const result = analyzeStaticCoupling(['a.ts'], ['b.ts'], projectFiles);
    assert.equal(result.couplingType, 'common');
    assert.ok(result.couplingConfidence >= 0.8);
  });

  it('returns low confidence when no coupling detected', () => {
    const projectFiles = {
      'a.ts': 'console.log("hello");',
      'b.ts': 'console.log("world");',
    };

    const result = analyzeStaticCoupling(['a.ts'], ['b.ts'], projectFiles);
    assert.equal(result.couplingType, 'data');
    assert.ok(result.couplingConfidence <= 0.5);
  });
});

// ─── AdaptiveBounds ───

describe('AdaptiveBounds', () => {
  function makeNode(overrides: Partial<DecompositionNode> = {}): DecompositionNode {
    return {
      id: 'test',
      parentId: null,
      type: 'task',
      description: 'Test node',
      acceptanceCriteria: ['criterion 1', 'criterion 2'],
      ownedPaths: ['file1.ts', 'file2.ts'],
      inputs: [],
      outputs: [],
      status: 'pending',
      complexityEstimate: null,
      assignedTo: null,
      readiness: emptyReadiness(),
      execution: null,
      artifacts: [],
      reasoning: [],
      metrics: emptyNodeMetrics(),
      ...overrides,
    };
  }

  it('stops at depth limit', () => {
    const result = shouldStopDecomposing(makeNode(), 3, { max_depth: 3, max_files_hint: 3, three_conditions: true, compositionality_check: true });
    assert.equal(result.stop, true);
    assert.ok(result.reason.includes('Depth limit'));
  });

  it('does not stop at depth < limit', () => {
    const result = shouldStopDecomposing(makeNode(), 2, { max_depth: 3, max_files_hint: 3, three_conditions: true, compositionality_check: true });
    assert.equal(result.stop, false);
  });

  it('stops when complexity is simple', () => {
    const node = makeNode({ complexityEstimate: 'simple' });
    const result = shouldStopDecomposing(node, 1, { max_depth: 3, max_files_hint: 3, three_conditions: true, compositionality_check: true });
    assert.equal(result.stop, true);
    assert.ok(result.reason.includes('simple'));
  });

  it('stops when three conditions violated (single file + single criterion)', () => {
    const node = makeNode({
      ownedPaths: ['single.ts'],
      acceptanceCriteria: ['one criterion'],
    });
    const result = shouldStopDecomposing(node, 1, { max_depth: 3, max_files_hint: 3, three_conditions: true, compositionality_check: true });
    assert.equal(result.stop, true);
    assert.ok(result.reason.includes('Three Conditions'));
  });

  it('stops when no acceptance criteria', () => {
    const node = makeNode({ acceptanceCriteria: [] });
    const result = shouldStopDecomposing(node, 1, { max_depth: 3, max_files_hint: 3, three_conditions: true, compositionality_check: true });
    assert.equal(result.stop, true);
    assert.ok(result.reason.includes('coverage'));
  });
});

// ─── DecompositionEngine ───

describe('DecompositionEngine', () => {
  it('dispatches to registered strategy', async () => {
    const strategies = new Map([
      ['D0', new D0Strategy()],
    ]);
    const engine = new DecompositionEngine(strategies);

    const graph = await engine.decompose(SIMPLE_TASK, 'D0', makeContext());
    assert.equal(graph.strategyUsed, 'D0');
    assert.equal(graph.nodes.length, 1);
  });

  it('throws on unknown strategy', async () => {
    const engine = new DecompositionEngine(new Map());
    await assert.rejects(
      () => engine.decompose(SIMPLE_TASK, 'nonexistent', makeContext()),
      /Unknown decomposition strategy/,
    );
  });

  it('lists registered strategies', () => {
    const strategies = new Map([
      ['D0', new D0Strategy()],
      ['D4', new D4Strategy()],
    ]);
    const engine = new DecompositionEngine(strategies);
    const names = engine.getStrategyNames();
    assert.deepEqual(names.sort(), ['D0', 'D4']);
  });
});

// ─── Variant YAML loading ───

describe('Variant YAML with decomposition_strategy', () => {
  it('loads decomposition strategy from YAML', async () => {
    const variantPath = path.resolve('variants/adaptive-d5.yaml');
    const config = await loadExtendedVariant(variantPath);

    assert.equal(config.name, 'adaptive-d5');
    assert.ok(config.decompositionStrategy);
    assert.equal(config.decompositionStrategy!.name, 'D5');
    assert.equal(config.decompositionStrategy!.fallback, 'D4');
    assert.equal(config.decompositionStrategy!.decomposition_trigger, 'on-failure');
    assert.equal(config.decompositionStrategy!.max_depth, 3);
    assert.equal(config.decompositionStrategy!.max_files_hint, 3);
    assert.equal(config.decompositionStrategy!.three_conditions, true);
    assert.equal(config.decompositionStrategy!.compositionality_check, true);
  });

  it('loads variant without decomposition strategy (backward compat)', async () => {
    const variantPath = path.resolve('variants/bare.yaml');
    const config = await loadExtendedVariant(variantPath);

    assert.ok(config.name);
    assert.equal(config.decompositionStrategy, undefined);
  });
});
