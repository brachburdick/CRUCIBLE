/**
 * Phase 0 tests: GraphStore round-trip, GraphBuilder validation, example graph.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { GraphStore } from '../engine/GraphStore.js';
import { GraphBuilder } from '../engine/GraphBuilder.js';
import type { TaskPayload } from '../types/index.js';
import type { DecompositionGraph, GraphEvent } from '../types/graph.js';

const SAMPLE_TASK: TaskPayload = {
  description: 'Fix a bug in pricing module',
  instructions: 'Debug the discount calculation and fix it. Run python test_orders.py to verify.',
  files: { 'pricing.py': 'def calc(): pass', 'orders.py': 'import pricing' },
  checks: [{ name: 'tests pass', type: 'exec', command: 'python test_orders.py' }],
};

describe('GraphBuilder', () => {
  it('produces a valid DecompositionGraph with one node', () => {
    const graph = new GraphBuilder(SAMPLE_TASK, 'test-pipeline', 'D0')
      .addNode({ id: 'root', type: 'leaf', description: 'Do the thing' })
      .build();

    assert.equal(graph.rootNodeId, 'root');
    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.edges.length, 0);
    assert.equal(graph.status, 'decomposing');
    assert.equal(graph.strategyUsed, 'D0');
    assert.equal(graph.pipelineDefinition, 'test-pipeline');
    assert.deepEqual(graph.taskOrigin, SAMPLE_TASK);
    assert.equal(graph.metrics.nodeCount, 1);
    assert.equal(graph.metrics.leafCount, 1);
    assert.equal(graph.metrics.maxDepth, 0);
  });

  it('produces a multi-node graph with correct metrics', () => {
    const graph = new GraphBuilder(SAMPLE_TASK, 'test-pipeline', 'D4')
      .addNode({ id: 'root', type: 'goal', description: 'Fix pricing bug' })
      .addNode({ id: 'leaf-1', parentId: 'root', type: 'leaf', description: 'Diagnose' })
      .addNode({ id: 'leaf-2', parentId: 'root', type: 'leaf', description: 'Fix' })
      .addEdge({ from: 'leaf-1', to: 'leaf-2', type: 'data' })
      .addEdge({ from: 'root', to: 'leaf-1', type: 'sequence' })
      .addEdge({ from: 'root', to: 'leaf-2', type: 'sequence' })
      .build();

    assert.equal(graph.rootNodeId, 'root');
    assert.equal(graph.nodes.length, 3);
    assert.equal(graph.edges.length, 3);
    assert.equal(graph.metrics.nodeCount, 3);
    assert.equal(graph.metrics.leafCount, 2);
    assert.equal(graph.metrics.maxDepth, 1);
    assert.equal(graph.metrics.averageCouplingConfidence, 1.0);
  });

  it('throws when no root node is defined', () => {
    const builder = new GraphBuilder(SAMPLE_TASK, 'test', 'D0');
    assert.throws(() => builder.build(), /no root node defined/);
  });

  it('defaults node fields correctly', () => {
    const graph = new GraphBuilder(SAMPLE_TASK, 'test', 'D0')
      .addNode({ id: 'root', type: 'leaf', description: 'Minimal node' })
      .build();

    const node = graph.nodes[0]!;
    assert.equal(node.parentId, null);
    assert.equal(node.status, 'pending');
    assert.equal(node.complexityEstimate, null);
    assert.equal(node.assignedTo, null);
    assert.equal(node.execution, null);
    assert.deepEqual(node.acceptanceCriteria, []);
    assert.deepEqual(node.ownedPaths, []);
    assert.deepEqual(node.artifacts, []);
    assert.deepEqual(node.reasoning, []);
    assert.equal(node.readiness.gateMode, 'triage');
    assert.equal(node.metrics.tokenUsage.total, 0);
  });
});

describe('GraphStore', () => {
  let tmpDir: string;
  let store: GraphStore;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crucible-test-'));
    store = new GraphStore(tmpDir);
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('saves and loads a graph (round-trip)', async () => {
    const graph = new GraphBuilder(SAMPLE_TASK, 'test-pipeline', 'D0', 'test-run-001')
      .addNode({ id: 'root', type: 'leaf', description: 'Round trip test' })
      .build();

    await store.saveGraph(graph);
    const loaded = await store.loadGraph('test-run-001');

    assert.equal(loaded.id, graph.id);
    assert.equal(loaded.rootNodeId, graph.rootNodeId);
    assert.equal(loaded.nodes.length, graph.nodes.length);
    assert.equal(loaded.strategyUsed, graph.strategyUsed);
    assert.deepEqual(loaded.taskOrigin, graph.taskOrigin);
    assert.deepEqual(loaded.metrics, graph.metrics);
  });

  it('saves and loads per-node detail', async () => {
    const graph = new GraphBuilder(SAMPLE_TASK, 'test-pipeline', 'D0', 'test-run-002')
      .addNode({ id: 'root', type: 'leaf', description: 'Node detail test' })
      .build();

    await store.saveGraph(graph);
    const nodeDetail = await store.loadNodeDetail('test-run-002', 'root');

    assert.equal(nodeDetail.id, 'root');
    assert.equal(nodeDetail.type, 'leaf');
    assert.equal(nodeDetail.description, 'Node detail test');
  });

  it('appends and loads events', async () => {
    const runId = 'test-run-003';
    // Ensure run dir exists
    const graph = new GraphBuilder(SAMPLE_TASK, 'test-pipeline', 'D0', runId)
      .addNode({ id: 'root', type: 'leaf', description: 'Event test' })
      .build();
    await store.saveGraph(graph);

    const event1: GraphEvent = {
      timestamp: new Date().toISOString(),
      type: 'graph_created',
      nodeId: null,
      detail: { strategy: 'D0' },
    };
    const event2: GraphEvent = {
      timestamp: new Date().toISOString(),
      type: 'node_status_changed',
      nodeId: 'root',
      detail: { from: 'pending', to: 'ready' },
    };

    await store.appendEvent(runId, event1);
    await store.appendEvent(runId, event2);

    const events = await store.loadEvents(runId);
    assert.equal(events.length, 2);
    assert.equal(events[0]!.type, 'graph_created');
    assert.equal(events[1]!.type, 'node_status_changed');
    assert.equal(events[1]!.nodeId, 'root');
  });

  it('lists graphs', async () => {
    const ids = await store.listGraphs();
    assert.ok(ids.includes('test-run-001'));
    assert.ok(ids.includes('test-run-002'));
    assert.ok(ids.includes('test-run-003'));
  });

  it('returns empty events for non-existent run', async () => {
    const events = await store.loadEvents('non-existent-run');
    assert.deepEqual(events, []);
  });
});

describe('Example graph file', () => {
  it('is valid JSON and has required fields', async () => {
    const examplePath = path.resolve('tasks/examples/bugfix-decomposition.json');
    const content = await fs.readFile(examplePath, 'utf-8');
    const graph = JSON.parse(content) as DecompositionGraph;

    assert.ok(graph.id);
    assert.ok(graph.taskOrigin);
    assert.ok(graph.rootNodeId);
    assert.ok(Array.isArray(graph.nodes));
    assert.ok(Array.isArray(graph.edges));
    assert.ok(graph.metrics);
    assert.equal(graph.status, 'completed');
    assert.equal(graph.nodes.length, 3);
    assert.equal(graph.edges.length, 1);

    // Root node exists
    const root = graph.nodes.find(n => n.id === graph.rootNodeId);
    assert.ok(root);
    assert.equal(root!.parentId, null);
    assert.equal(root!.type, 'goal');

    // Leaf nodes
    const leaves = graph.nodes.filter(n => n.type === 'leaf');
    assert.equal(leaves.length, 2);
  });
});
