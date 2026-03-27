/**
 * GraphBuilder — Fluent API for constructing DecompositionGraph objects.
 */

import type { TaskPayload } from '../types/index.js';
import type {
  DecompositionGraph,
  DecompositionNode,
  DependencyEdge,
  ArtifactRef,
  ReadinessAssessment,
  NodeMetrics,
  GraphMetrics,
} from '../types/graph.js';
import { emptyReadiness, emptyNodeMetrics, emptyGraphMetrics } from '../types/graph.js';

export interface NodeInput {
  id: string;
  parentId?: string | null;
  type: DecompositionNode['type'];
  description: string;
  acceptanceCriteria?: string[];
  ownedPaths?: string[];
  inputs?: ArtifactRef[];
  outputs?: ArtifactRef[];
  status?: DecompositionNode['status'];
  complexityEstimate?: DecompositionNode['complexityEstimate'];
  assignedTo?: string | null;
  readiness?: ReadinessAssessment;
  metrics?: NodeMetrics;
}

export interface EdgeInput {
  from: string;
  to: string;
  type: DependencyEdge['type'];
  couplingType?: DependencyEdge['couplingType'];
  couplingSource?: DependencyEdge['couplingSource'];
  couplingConfidence?: number;
  contract?: DependencyEdge['contract'];
}

export class GraphBuilder {
  private nodes: DecompositionNode[] = [];
  private edges: DependencyEdge[] = [];
  private graphId: string;
  private rootNodeId: string | null = null;

  constructor(
    private readonly taskPayload: TaskPayload,
    private readonly pipelineDefinition: string,
    private readonly strategyUsed: string,
    graphId?: string,
  ) {
    this.graphId = graphId ?? `graph-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  addNode(input: NodeInput): this {
    const node: DecompositionNode = {
      id: input.id,
      parentId: input.parentId ?? null,
      type: input.type,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      ownedPaths: input.ownedPaths ?? [],
      inputs: input.inputs ?? [],
      outputs: input.outputs ?? [],
      status: input.status ?? 'pending',
      complexityEstimate: input.complexityEstimate ?? null,
      assignedTo: input.assignedTo ?? null,
      readiness: input.readiness ?? emptyReadiness(),
      execution: null,
      artifacts: [],
      reasoning: [],
      metrics: input.metrics ?? emptyNodeMetrics(),
    };
    this.nodes.push(node);

    // First node with no parent becomes root
    if (node.parentId === null && this.rootNodeId === null) {
      this.rootNodeId = node.id;
    }

    return this;
  }

  addEdge(input: EdgeInput): this {
    const edge: DependencyEdge = {
      from: input.from,
      to: input.to,
      type: input.type,
      contract: input.contract ?? null,
      couplingType: input.couplingType ?? 'data',
      couplingSource: input.couplingSource ?? 'static',
      couplingConfidence: input.couplingConfidence ?? 1.0,
    };
    this.edges.push(edge);
    return this;
  }

  setRootNodeId(nodeId: string): this {
    this.rootNodeId = nodeId;
    return this;
  }

  build(): DecompositionGraph {
    if (this.rootNodeId === null) {
      throw new Error('GraphBuilder: no root node defined. Add at least one node with parentId=null.');
    }

    const now = new Date().toISOString();
    const metrics = this.computeMetrics();

    return {
      id: this.graphId,
      taskOrigin: this.taskPayload,
      pipelineDefinition: this.pipelineDefinition,
      strategyUsed: this.strategyUsed,
      createdAt: now,
      updatedAt: now,
      rootNodeId: this.rootNodeId,
      nodes: this.nodes,
      edges: this.edges,
      status: 'decomposing',
      metrics,
    };
  }

  private computeMetrics(): GraphMetrics {
    const base = emptyGraphMetrics();
    base.nodeCount = this.nodes.length;
    base.leafCount = this.nodes.filter(n => n.type === 'leaf').length;
    base.completedCount = this.nodes.filter(n => n.status === 'completed').length;
    base.failedCount = this.nodes.filter(n => n.status === 'failed').length;

    // Compute max depth via parent chain
    const parentMap = new Map(this.nodes.map(n => [n.id, n.parentId]));
    let maxDepth = 0;
    for (const node of this.nodes) {
      let depth = 0;
      let current: string | null = node.id;
      while (current !== null) {
        const parent: string | null | undefined = parentMap.get(current) ?? null;
        if (parent === null) break;
        depth++;
        current = parent;
      }
      if (depth > maxDepth) maxDepth = depth;
    }
    base.maxDepth = maxDepth;

    // Average coupling confidence
    if (this.edges.length > 0) {
      const sum = this.edges.reduce((acc, e) => acc + e.couplingConfidence, 0);
      base.averageCouplingConfidence = sum / this.edges.length;
    }

    return base;
  }
}
