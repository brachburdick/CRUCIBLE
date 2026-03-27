/**
 * Node Scheduler — extracts graph scheduling logic into a testable unit.
 *
 * Computes ready nodes, checks graph completion/deadlock, and resolves
 * virtual (non-leaf) node statuses based on their children.
 */

import type { DecompositionGraph, DecompositionNode, DependencyEdge } from '../types/graph.js';

export interface SchedulerState {
  graph: DecompositionGraph;
  /** Set of node IDs currently being executed */
  activeNodeIds: Set<string>;
}

export class NodeScheduler {
  /**
   * Returns nodes that are ready to execute: status='pending', all upstream
   * dependencies (edges where `to=thisNode`) have source node status='completed',
   * and the node is not already active.
   */
  getReadyNodes(state: SchedulerState): DecompositionNode[] {
    const { graph, activeNodeIds } = state;
    const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));

    // Build a map of incoming edges per node
    const incomingEdges = new Map<string, DependencyEdge[]>();
    for (const edge of graph.edges) {
      const existing = incomingEdges.get(edge.to) ?? [];
      existing.push(edge);
      incomingEdges.set(edge.to, existing);
    }

    return graph.nodes.filter(node => {
      // Only pending nodes can become ready
      if (node.status !== 'pending') return false;

      // Not already being executed
      if (activeNodeIds.has(node.id)) return false;

      // Only leaf nodes are directly executable
      if (node.type !== 'leaf') return false;

      // All upstream dependencies must be completed
      const deps = incomingEdges.get(node.id) ?? [];
      return deps.every(edge => {
        const source = nodeMap.get(edge.from);
        return source !== undefined && source.status === 'completed';
      });
    });
  }

  /**
   * Check if graph execution is complete: all leaf nodes are in a
   * terminal state (completed, failed, or skipped).
   */
  isGraphComplete(state: SchedulerState): boolean {
    const leaves = state.graph.nodes.filter(n => n.type === 'leaf');
    if (leaves.length === 0) return true;
    return leaves.every(n =>
      n.status === 'completed' || n.status === 'failed' || n.status === 'skipped',
    );
  }

  /**
   * Check if graph is deadlocked: no ready nodes and no active nodes,
   * but incomplete leaf nodes exist.
   */
  isDeadlocked(state: SchedulerState): boolean {
    if (this.isGraphComplete(state)) return false;
    if (state.activeNodeIds.size > 0) return false;

    const readyNodes = this.getReadyNodes(state);
    return readyNodes.length === 0;
  }

  /**
   * Update a virtual (non-leaf) node's status based on its children.
   * - All children completed → parent completed
   * - Any child failed → parent failed
   * - Otherwise → parent remains active
   */
  resolveParentStatus(
    graph: DecompositionGraph,
    nodeId: string,
  ): 'completed' | 'failed' | 'active' {
    const children = graph.nodes.filter(n => n.parentId === nodeId);
    if (children.length === 0) return 'completed';

    const allCompleted = children.every(c => c.status === 'completed');
    if (allCompleted) return 'completed';

    const anyFailed = children.some(c => c.status === 'failed');
    if (anyFailed) return 'failed';

    return 'active';
  }
}
