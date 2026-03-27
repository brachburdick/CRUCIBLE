/**
 * Phase 3 tests: NodeScheduler, PromptBuilder, MutationGuard, GraphExecutor.
 *
 * All tests use mocks — no E2B sandbox or LLM credentials required.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { NodeScheduler, type SchedulerState } from '../engine/NodeScheduler.js';
import { buildNodePrompt } from '../engine/PromptBuilder.js';
import { createMutationGuard, isTestCommand } from '../middleware/mutationGuard.js';
import { GraphExecutor, detectFlowType, type GraphExecutorConfig, type SandboxContext } from '../engine/GraphExecutor.js';
import { MutationTracker } from '../session/mutation-tracker.js';
import { SessionModel } from '../session/index.js';
import { GraphStore } from '../engine/GraphStore.js';
import { GraphBuilder } from '../engine/GraphBuilder.js';
import { getFlowTemplate } from '../session/flow-templates.js';
import type {
  DecompositionGraph,
  DecompositionNode,
} from '../types/graph.js';
import { emptyReadiness, emptyNodeMetrics } from '../types/graph.js';
import type { ToolContext, AgentOutput, LlmCallFn } from '../types/index.js';
import type { SessionKnowledge } from '../session/types.js';

// ─── Helpers ───

function makeNode(overrides: Partial<DecompositionNode> & { id: string }): DecompositionNode {
  return {
    parentId: null,
    type: 'leaf',
    description: `Node ${overrides.id}`,
    acceptanceCriteria: [],
    ownedPaths: [],
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

function makeGraph(nodes: DecompositionNode[], edges: DecompositionGraph['edges'] = []): DecompositionGraph {
  return {
    id: 'test-graph',
    taskOrigin: { description: 'test', instructions: 'test' },
    pipelineDefinition: 'test',
    strategyUsed: 'D0',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    rootNodeId: nodes[0]?.id ?? 'root',
    nodes,
    edges,
    status: 'decomposing',
    metrics: {
      totalTokens: 0,
      totalWallTimeMs: 0,
      nodeCount: nodes.length,
      leafCount: nodes.filter(n => n.type === 'leaf').length,
      completedCount: 0,
      failedCount: 0,
      maxDepth: 1,
      averageCouplingConfidence: 0,
    },
  };
}

function mockToolContext(): ToolContext {
  return {
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    writeFile: async () => {},
    readFile: async () => '',
  };
}

function mockLlmCall(): LlmCallFn {
  return async () => ({
    content: 'done',
    usage: { promptTokens: 10, completionTokens: 5 },
    model: 'mock',
  });
}

function emptyKnowledge(): SessionKnowledge {
  return {
    decisions: [],
    keyLocations: [],
    deadEnds: [],
    openQuestions: [],
  };
}

// ─── NodeScheduler ───

describe('NodeScheduler', () => {
  let scheduler: NodeScheduler;

  beforeEach(() => {
    scheduler = new NodeScheduler();
  });

  describe('getReadyNodes()', () => {
    it('should return pending leaf nodes with no dependencies', () => {
      const graph = makeGraph([
        makeNode({ id: 'a' }),
        makeNode({ id: 'b' }),
      ]);
      const state: SchedulerState = { graph, activeNodeIds: new Set() };
      const ready = scheduler.getReadyNodes(state);
      assert.equal(ready.length, 2);
    });

    it('should not return non-leaf nodes', () => {
      const graph = makeGraph([
        makeNode({ id: 'root', type: 'goal' }),
        makeNode({ id: 'a', parentId: 'root' }),
      ]);
      const state: SchedulerState = { graph, activeNodeIds: new Set() };
      const ready = scheduler.getReadyNodes(state);
      assert.equal(ready.length, 1);
      assert.equal(ready[0].id, 'a');
    });

    it('should not return nodes whose upstream deps are incomplete', () => {
      const graph = makeGraph(
        [makeNode({ id: 'a' }), makeNode({ id: 'b' })],
        [{ from: 'a', to: 'b', type: 'sequence', contract: null, couplingType: 'data', couplingSource: 'static', couplingConfidence: 1 }],
      );
      const state: SchedulerState = { graph, activeNodeIds: new Set() };
      const ready = scheduler.getReadyNodes(state);
      assert.equal(ready.length, 1);
      assert.equal(ready[0].id, 'a');
    });

    it('should return node when upstream dep is completed', () => {
      const graph = makeGraph(
        [makeNode({ id: 'a', status: 'completed' }), makeNode({ id: 'b' })],
        [{ from: 'a', to: 'b', type: 'sequence', contract: null, couplingType: 'data', couplingSource: 'static', couplingConfidence: 1 }],
      );
      const state: SchedulerState = { graph, activeNodeIds: new Set() };
      const ready = scheduler.getReadyNodes(state);
      assert.equal(ready.length, 1);
      assert.equal(ready[0].id, 'b');
    });

    it('should not return already-active nodes', () => {
      const graph = makeGraph([makeNode({ id: 'a' })]);
      const state: SchedulerState = { graph, activeNodeIds: new Set(['a']) };
      const ready = scheduler.getReadyNodes(state);
      assert.equal(ready.length, 0);
    });

    it('should handle diamond dependencies', () => {
      const graph = makeGraph(
        [
          makeNode({ id: 'a', status: 'completed' }),
          makeNode({ id: 'b', status: 'completed' }),
          makeNode({ id: 'c' }),
        ],
        [
          { from: 'a', to: 'c', type: 'data', contract: null, couplingType: 'data', couplingSource: 'static', couplingConfidence: 1 },
          { from: 'b', to: 'c', type: 'data', contract: null, couplingType: 'data', couplingSource: 'static', couplingConfidence: 1 },
        ],
      );
      const state: SchedulerState = { graph, activeNodeIds: new Set() };
      const ready = scheduler.getReadyNodes(state);
      assert.equal(ready.length, 1);
      assert.equal(ready[0].id, 'c');
    });

    it('should block when one of multiple deps is incomplete', () => {
      const graph = makeGraph(
        [
          makeNode({ id: 'a', status: 'completed' }),
          makeNode({ id: 'b' }), // still pending
          makeNode({ id: 'c' }),
        ],
        [
          { from: 'a', to: 'c', type: 'data', contract: null, couplingType: 'data', couplingSource: 'static', couplingConfidence: 1 },
          { from: 'b', to: 'c', type: 'data', contract: null, couplingType: 'data', couplingSource: 'static', couplingConfidence: 1 },
        ],
      );
      const state: SchedulerState = { graph, activeNodeIds: new Set() };
      const ready = scheduler.getReadyNodes(state);
      // Only b is ready (a is completed, c is blocked by b)
      assert.equal(ready.length, 1);
      assert.equal(ready[0].id, 'b');
    });
  });

  describe('isGraphComplete()', () => {
    it('should return true when all leaves are completed', () => {
      const graph = makeGraph([
        makeNode({ id: 'a', status: 'completed' }),
        makeNode({ id: 'b', status: 'completed' }),
      ]);
      assert.equal(scheduler.isGraphComplete({ graph, activeNodeIds: new Set() }), true);
    });

    it('should return true when leaves are mixed completed/failed/skipped', () => {
      const graph = makeGraph([
        makeNode({ id: 'a', status: 'completed' }),
        makeNode({ id: 'b', status: 'failed' }),
        makeNode({ id: 'c', status: 'skipped' }),
      ]);
      assert.equal(scheduler.isGraphComplete({ graph, activeNodeIds: new Set() }), true);
    });

    it('should return false when a leaf is still pending', () => {
      const graph = makeGraph([
        makeNode({ id: 'a', status: 'completed' }),
        makeNode({ id: 'b', status: 'pending' }),
      ]);
      assert.equal(scheduler.isGraphComplete({ graph, activeNodeIds: new Set() }), false);
    });

    it('should return true for empty graph', () => {
      const graph = makeGraph([]);
      assert.equal(scheduler.isGraphComplete({ graph, activeNodeIds: new Set() }), true);
    });
  });

  describe('isDeadlocked()', () => {
    it('should return true when no ready nodes but incomplete work exists', () => {
      // Two nodes that depend on each other (circular)
      const graph = makeGraph(
        [makeNode({ id: 'a' }), makeNode({ id: 'b' })],
        [
          { from: 'a', to: 'b', type: 'sequence', contract: null, couplingType: 'data', couplingSource: 'static', couplingConfidence: 1 },
          { from: 'b', to: 'a', type: 'sequence', contract: null, couplingType: 'data', couplingSource: 'static', couplingConfidence: 1 },
        ],
      );
      assert.equal(scheduler.isDeadlocked({ graph, activeNodeIds: new Set() }), true);
    });

    it('should return false when graph is complete', () => {
      const graph = makeGraph([
        makeNode({ id: 'a', status: 'completed' }),
      ]);
      assert.equal(scheduler.isDeadlocked({ graph, activeNodeIds: new Set() }), false);
    });

    it('should return false when nodes are active', () => {
      const graph = makeGraph([
        makeNode({ id: 'a', status: 'active' }),
        makeNode({ id: 'b' }),
      ]);
      assert.equal(scheduler.isDeadlocked({ graph, activeNodeIds: new Set(['a']) }), false);
    });
  });

  describe('resolveParentStatus()', () => {
    it('should return completed when all children are completed', () => {
      const graph = makeGraph([
        makeNode({ id: 'parent', type: 'task' }),
        makeNode({ id: 'a', parentId: 'parent', status: 'completed' }),
        makeNode({ id: 'b', parentId: 'parent', status: 'completed' }),
      ]);
      assert.equal(scheduler.resolveParentStatus(graph, 'parent'), 'completed');
    });

    it('should return failed when any child is failed', () => {
      const graph = makeGraph([
        makeNode({ id: 'parent', type: 'task' }),
        makeNode({ id: 'a', parentId: 'parent', status: 'completed' }),
        makeNode({ id: 'b', parentId: 'parent', status: 'failed' }),
      ]);
      assert.equal(scheduler.resolveParentStatus(graph, 'parent'), 'failed');
    });

    it('should return active when children are still in progress', () => {
      const graph = makeGraph([
        makeNode({ id: 'parent', type: 'task' }),
        makeNode({ id: 'a', parentId: 'parent', status: 'completed' }),
        makeNode({ id: 'b', parentId: 'parent', status: 'pending' }),
      ]);
      assert.equal(scheduler.resolveParentStatus(graph, 'parent'), 'active');
    });

    it('should return completed when parent has no children', () => {
      const graph = makeGraph([makeNode({ id: 'parent', type: 'task' })]);
      assert.equal(scheduler.resolveParentStatus(graph, 'parent'), 'completed');
    });
  });
});

// ─── PromptBuilder ───

describe('buildNodePrompt()', () => {
  const flow = getFlowTemplate('feature');

  it('should include node description and acceptance criteria', () => {
    const node = makeNode({
      id: 'n1',
      description: 'Add login endpoint',
      acceptanceCriteria: ['POST /login returns 200', 'Invalid creds return 401'],
    });
    const graph = makeGraph([node]);
    const prompt = buildNodePrompt(node, flow, graph, emptyKnowledge());

    assert.ok(prompt.includes('Add login endpoint'));
    assert.ok(prompt.includes('POST /login returns 200'));
    assert.ok(prompt.includes('Invalid creds return 401'));
  });

  it('should include flow phases', () => {
    const node = makeNode({ id: 'n1' });
    const graph = makeGraph([node]);
    const prompt = buildNodePrompt(node, flow, graph, emptyKnowledge());

    assert.ok(prompt.includes('intent'));
    assert.ok(prompt.includes('spec'));
    assert.ok(prompt.includes('implement'));
    assert.ok(prompt.includes('verify'));
  });

  it('should include owned paths as scope boundary', () => {
    const node = makeNode({ id: 'n1', ownedPaths: ['src/auth/', 'src/routes/login.ts'] });
    const graph = makeGraph([node]);
    const prompt = buildNodePrompt(node, flow, graph, emptyKnowledge());

    assert.ok(prompt.includes('src/auth/'));
    assert.ok(prompt.includes('src/routes/login.ts'));
    assert.ok(prompt.includes('Scope Boundary'));
  });

  it('should include upstream artifact descriptions', () => {
    const nodeA = makeNode({
      id: 'a',
      status: 'completed',
      description: 'Create schema',
      outputs: [{ nodeId: 'a', artifactId: 'schema.sql', type: 'file' }],
    });
    const nodeB = makeNode({ id: 'b' });
    const graph = makeGraph(
      [nodeA, nodeB],
      [{ from: 'a', to: 'b', type: 'data', contract: null, couplingType: 'data', couplingSource: 'static', couplingConfidence: 1 }],
    );

    const prompt = buildNodePrompt(nodeB, flow, graph, emptyKnowledge());
    assert.ok(prompt.includes('Create schema'));
    assert.ok(prompt.includes('schema.sql'));
  });

  it('should include session knowledge (decisions and dead ends)', () => {
    const node = makeNode({ id: 'n1' });
    const graph = makeGraph([node]);
    const knowledge: SessionKnowledge = {
      decisions: [{ timestamp: '', nodeId: null, decision: 'Use JWT', rationale: 'Stateless' }],
      keyLocations: [],
      deadEnds: [{ approach: 'Session cookies', reason: 'Does not scale', discoveredAt: '' }],
      openQuestions: [],
    };

    const prompt = buildNodePrompt(node, flow, graph, knowledge);
    assert.ok(prompt.includes('Use JWT'));
    assert.ok(prompt.includes('Session cookies'));
    assert.ok(prompt.includes('Dead Ends'));
  });

  it('should include flow rules with MUST/SHOULD', () => {
    const node = makeNode({ id: 'n1' });
    const graph = makeGraph([node]);
    const prompt = buildNodePrompt(node, flow, graph, emptyKnowledge());

    assert.ok(prompt.includes('MUST'));
    assert.ok(prompt.includes('SHOULD'));
  });

  it('should include constraint reminders', () => {
    const node = makeNode({ id: 'n1' });
    const graph = makeGraph([node]);
    const prompt = buildNodePrompt(node, flow, graph, emptyKnowledge());

    assert.ok(prompt.includes('2-attempt cap'));
    assert.ok(prompt.includes('Mutation budget'));
    assert.ok(prompt.includes('Context gate'));
  });
});

// ─── MutationGuard ───

describe('createMutationGuard()', () => {
  it('should block writeFile when preMutation returns false', async () => {
    const tracker = new MutationTracker();
    // Exhaust consecutive cap
    tracker.postMutation('a.ts');
    tracker.postMutation('b.ts');

    const tools = mockToolContext();
    const guarded = createMutationGuard(tracker, tools);

    await assert.rejects(
      () => guarded.writeFile('c.ts', 'content'),
      /Mutation blocked/,
    );
  });

  it('should allow writeFile and call postMutation on success', async () => {
    const tracker = new MutationTracker();
    let writeCalled = false;
    const tools: ToolContext = {
      ...mockToolContext(),
      writeFile: async () => { writeCalled = true; },
    };

    const guarded = createMutationGuard(tracker, tools);
    await guarded.writeFile('a.ts', 'content');

    assert.ok(writeCalled);
    assert.equal(tracker.getState().totalMutations, 1);
  });

  it('should detect test commands and call recordTestRun', async () => {
    const tracker = new MutationTracker();
    tracker.postMutation('a.ts');

    const tools = mockToolContext();
    const guarded = createMutationGuard(tracker, tools);

    await guarded.exec('npm test');
    assert.equal(tracker.getState().consecutiveMutations, 0); // reset by test run
  });

  it('should not call recordTestRun for non-test commands', async () => {
    const tracker = new MutationTracker();
    tracker.postMutation('a.ts');

    const tools = mockToolContext();
    const guarded = createMutationGuard(tracker, tools);

    await guarded.exec('echo hello');
    assert.equal(tracker.getState().consecutiveMutations, 1); // not reset
  });

  it('should pass through readFile unchanged', async () => {
    const tracker = new MutationTracker();
    const tools: ToolContext = {
      ...mockToolContext(),
      readFile: async () => 'file content',
    };

    const guarded = createMutationGuard(tracker, tools);
    const content = await guarded.readFile('a.ts');
    assert.equal(content, 'file content');
  });
});

describe('isTestCommand()', () => {
  it('should detect common test runners', () => {
    assert.ok(isTestCommand('pytest'));
    assert.ok(isTestCommand('npm test'));
    assert.ok(isTestCommand('npm run test'));
    assert.ok(isTestCommand('node --test dist/test.js'));
    assert.ok(isTestCommand('jest --coverage'));
    assert.ok(isTestCommand('cargo test'));
    assert.ok(isTestCommand('go test ./...'));
  });

  it('should not match non-test commands', () => {
    assert.ok(!isTestCommand('echo hello'));
    assert.ok(!isTestCommand('npm install'));
    assert.ok(!isTestCommand('node server.js'));
  });
});

// ─── detectFlowType ───

describe('detectFlowType()', () => {
  it('should detect debug flow from bug/fix keywords', () => {
    assert.equal(detectFlowType('fix the login bug'), 'debug');
    assert.equal(detectFlowType('error in auth module'), 'debug');
    assert.equal(detectFlowType('regression in tests'), 'debug');
  });

  it('should detect refactor flow from refactor keywords', () => {
    assert.equal(detectFlowType('refactor the auth module'), 'refactor');
    assert.equal(detectFlowType('extract helper class'), 'refactor');
    assert.equal(detectFlowType('consolidate duplicate code'), 'refactor');
  });

  it('should detect feature flow from create/add keywords', () => {
    assert.equal(detectFlowType('implement user signup'), 'feature');
    assert.equal(detectFlowType('add new endpoint'), 'feature');
    assert.equal(detectFlowType('create dashboard'), 'feature');
  });

  it('should default to feature for ambiguous descriptions', () => {
    assert.equal(detectFlowType('update the system'), 'feature');
    assert.equal(detectFlowType('work on the thing'), 'feature');
  });
});

// ─── GraphExecutor integration tests ───

describe('GraphExecutor', () => {
  // Minimal mock session that works without disk I/O
  function mockSession(): SessionModel {
    const session = new SessionModel({ agentDir: '/tmp/crucible-test-agent' });
    // Pre-populate snapshot with knowledge to avoid disk reads
    session.snapshot.current.sessionKnowledge = emptyKnowledge();
    return session;
  }

  // Minimal mock graph store (in-memory)
  function mockGraphStore(): GraphStore {
    const store = new GraphStore('/tmp/crucible-test-runs');
    // Override methods to be no-ops for testing
    const original = store;
    return {
      saveGraph: async () => {},
      loadGraph: async (id: string) => ({ id } as unknown as DecompositionGraph),
      saveNodeDetail: async () => {},
      loadNodeDetail: async () => ({} as unknown as DecompositionNode),
      appendEvent: async () => {},
      loadEvents: async () => [],
      listGraphs: async () => [],
    } as unknown as GraphStore;
  }

  function mockSandboxFactory(
    agentBehavior: (node: DecompositionNode) => Promise<AgentOutput>,
  ): (node: DecompositionNode) => Promise<SandboxContext> {
    return async (node: DecompositionNode) => {
      let tokenCount = 0;
      const tools = mockToolContext();
      const wrappedLlmCall: LlmCallFn = async (messages, options) => {
        tokenCount += 15;
        return {
          content: 'done',
          usage: { promptTokens: 10, completionTokens: 5 },
          model: 'mock',
        };
      };

      return {
        tools,
        getTokenCount: () => tokenCount,
        wrappedLlmCall,
        destroy: async () => {},
      };
    };
  }

  function makeConfig(
    graph: DecompositionGraph,
    agentBehavior?: (node: DecompositionNode) => Promise<AgentOutput>,
  ): GraphExecutorConfig {
    const behavior = agentBehavior ?? (async () => ({ finalMessage: 'done' }));
    return {
      graph,
      session: mockSession(),
      graphStore: mockGraphStore(),
      nodeTokenBudget: 10000,
      nodeTtlSeconds: 60,
      loopDetection: { windowSize: 8, similarityThreshold: 0.92, consecutiveTurns: 5 },
      baseLlmCall: mockLlmCall(),
      agentFactory: (_node, _prompt) => async (llmCall, tools) => behavior(_node),
      sandboxFactory: mockSandboxFactory(behavior),
    };
  }

  it('should execute a single-node graph successfully', async () => {
    const graph = makeGraph([makeNode({ id: 'a' })]);
    const config = makeConfig(graph);
    const executor = new GraphExecutor(config);

    const result = await executor.execute();

    assert.equal(result.status, 'completed');
    assert.equal(result.nodesCompleted, 1);
    assert.equal(result.nodesFailed, 0);
  });

  it('should execute a two-node chain in order', async () => {
    const graph = makeGraph(
      [makeNode({ id: 'a' }), makeNode({ id: 'b' })],
      [{ from: 'a', to: 'b', type: 'sequence', contract: null, couplingType: 'data', couplingSource: 'static', couplingConfidence: 1 }],
    );

    const executionOrder: string[] = [];
    const config = makeConfig(graph, async (node) => {
      executionOrder.push(node.id);
      return { finalMessage: `done ${node.id}` };
    });
    const executor = new GraphExecutor(config);

    const result = await executor.execute();

    assert.equal(result.status, 'completed');
    assert.deepEqual(executionOrder, ['a', 'b']);
    assert.equal(result.nodesCompleted, 2);
  });

  it('should mark failed node and continue with remaining nodes', async () => {
    const graph = makeGraph([
      makeNode({ id: 'a' }),
      makeNode({ id: 'b' }),
    ]);

    const config = makeConfig(graph, async (node) => {
      if (node.id === 'a') throw new Error('boom');
      return { finalMessage: 'done' };
    });
    const executor = new GraphExecutor(config);

    const result = await executor.execute();

    // Graph should still complete (b succeeds even though a fails)
    assert.equal(result.nodesFailed, 1);
    assert.equal(result.nodesCompleted, 1);
    // One of a or b failed, so graph is failed
    assert.equal(result.status, 'failed');
  });

  it('should detect graph deadlock', async () => {
    // Circular dependency — both nodes depend on each other
    const graph = makeGraph(
      [makeNode({ id: 'a' }), makeNode({ id: 'b' })],
      [
        { from: 'a', to: 'b', type: 'sequence', contract: null, couplingType: 'data', couplingSource: 'static', couplingConfidence: 1 },
        { from: 'b', to: 'a', type: 'sequence', contract: null, couplingType: 'data', couplingSource: 'static', couplingConfidence: 1 },
      ],
    );
    const config = makeConfig(graph);
    const executor = new GraphExecutor(config);

    const result = await executor.execute();

    assert.equal(result.status, 'failed');
  });

  it('should emit lifecycle events', async () => {
    const graph = makeGraph([makeNode({ id: 'a' })]);
    const config = makeConfig(graph);
    const executor = new GraphExecutor(config);

    const events: string[] = [];
    executor.on('graph:event', (evt) => {
      events.push(evt.event);
    });

    await executor.execute();

    assert.ok(events.includes('graph_execution_started'));
    assert.ok(events.includes('node_status_changed'));
    assert.ok(events.includes('node_dispatch_started'));
    assert.ok(events.includes('node_dispatch_completed'));
    assert.ok(events.includes('graph_execution_completed'));
  });

  it('should handle budget exceeded error from agent', async () => {
    const graph = makeGraph([makeNode({ id: 'a' })]);
    const { BudgetExceededError } = await import('../types/index.js');

    const config = makeConfig(graph, async () => {
      throw new BudgetExceededError(5000, 4000);
    });
    const executor = new GraphExecutor(config);

    const result = await executor.execute();

    assert.equal(result.status, 'failed');
    assert.equal(result.nodesFailed, 1);
  });

  it('should resolve parent status when children complete', async () => {
    const graph = makeGraph([
      makeNode({ id: 'parent', type: 'task', status: 'pending' }),
      makeNode({ id: 'a', parentId: 'parent' }),
      makeNode({ id: 'b', parentId: 'parent' }),
    ]);
    const config = makeConfig(graph);
    const executor = new GraphExecutor(config);

    const result = await executor.execute();

    assert.equal(result.status, 'completed');
    // Parent should have been resolved to completed
    const parentNode = graph.nodes.find(n => n.id === 'parent');
    assert.equal(parentNode?.status, 'completed');
  });
});
