/**
 * D5Strategy — Adaptive/as-needed decomposition (ADaPT pattern).
 *
 * Starts by wrapping the task as a single leaf (like D0).
 * On execution failure, decomposes the failed node using a fallback
 * strategy (typically D4), injecting failure evidence as context.
 */

import type { TaskPayload } from '../../types/index.js';
import type { DecompositionGraph, DecompositionNode, ExecutionRecord } from '../../types/graph.js';
import type { DecompositionStrategy, DecompositionContext } from '../DecompositionEngine.js';
import { GraphBuilder } from '../GraphBuilder.js';

export class D5Strategy implements DecompositionStrategy {
  name = 'D5';

  constructor(private fallbackStrategy: DecompositionStrategy) {}

  async decompose(
    task: TaskPayload,
    _context: DecompositionContext,
  ): Promise<DecompositionGraph> {
    // Start as a single leaf — same as D0
    const builder = new GraphBuilder(task, 'adaptive', this.name);

    builder.addNode({
      id: 'root',
      type: 'leaf',
      description: task.description,
      acceptanceCriteria: task.checks?.map(c => c.name) ?? [],
      ownedPaths: task.files ? Object.keys(task.files) : [],
      status: 'ready',
    });

    return builder.build();
  }

  /**
   * Called by the execution layer when a leaf fails.
   * Re-decomposes the failed node's parent using the fallback strategy,
   * injecting failure evidence as additional context.
   */
  async redecompose(
    failedNode: DecompositionNode,
    failureEvidence: ExecutionRecord,
    graph: DecompositionGraph,
    context: DecompositionContext,
  ): Promise<DecompositionGraph> {
    // Build an augmented task with failure evidence
    const augmentedTask: TaskPayload = {
      ...graph.taskOrigin,
      instructions: this.augmentInstructions(
        graph.taskOrigin.instructions,
        failedNode,
        failureEvidence,
      ),
    };

    // Decompose using the fallback strategy
    const newGraph = await this.fallbackStrategy.decompose(augmentedTask, context);

    // Merge the new graph into the existing one:
    // - Mark the failed node as 'redecomposed'
    // - Add new child nodes under the failed node's parent
    const updatedNodes = graph.nodes.map(n => {
      if (n.id === failedNode.id) {
        return {
          ...n,
          status: 'failed' as const,
          execution: {
            ...failureEvidence,
            exitReason: { type: 'redecomposed' as const },
          },
        };
      }
      return n;
    });

    // Add new nodes from fallback decomposition (skip its root, reparent children)
    const fallbackRoot = newGraph.nodes.find(n => n.id === newGraph.rootNodeId);
    const fallbackChildren = newGraph.nodes.filter(n => n.id !== newGraph.rootNodeId);

    for (const child of fallbackChildren) {
      child.parentId = failedNode.parentId;
      updatedNodes.push(child);
    }

    // Add fallback edges (excluding root edges)
    const updatedEdges = [
      ...graph.edges,
      ...newGraph.edges.filter(e => e.from !== newGraph.rootNodeId && e.to !== newGraph.rootNodeId),
    ];

    return {
      ...graph,
      nodes: updatedNodes,
      edges: updatedEdges,
      updatedAt: new Date().toISOString(),
      metrics: {
        ...graph.metrics,
        nodeCount: updatedNodes.length,
        leafCount: updatedNodes.filter(n => n.type === 'leaf').length,
      },
    };
  }

  private augmentInstructions(
    original: string,
    failedNode: DecompositionNode,
    evidence: ExecutionRecord,
  ): string {
    const failureInfo = [
      '',
      '--- FAILURE EVIDENCE (from prior attempt) ---',
      `Failed node: ${failedNode.description}`,
      `Exit reason: ${JSON.stringify(evidence.exitReason)}`,
      `Token usage: ${evidence.tokenUsage.total} tokens`,
      `Wall time: ${evidence.wallTimeMs}ms`,
      `Mutations: ${evidence.mutations}`,
      `Test cycles: ${evidence.testCycles}`,
    ];

    if (evidence.verificationResults.length > 0) {
      failureInfo.push('Verification results:');
      for (const vr of evidence.verificationResults) {
        failureInfo.push(`  - ${vr.checkName}: ${vr.passed ? 'PASS' : 'FAIL'} (exit ${vr.exitCode})`);
        if (vr.stderr) failureInfo.push(`    stderr: ${vr.stderr.slice(0, 200)}`);
      }
    }

    failureInfo.push('--- END FAILURE EVIDENCE ---');

    return original + failureInfo.join('\n');
  }
}
