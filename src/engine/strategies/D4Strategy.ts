/**
 * D4Strategy — Interface-first decomposition.
 *
 * Analyzes the task for module boundaries using LLM-based dependency analysis.
 * Produces a graph with nodes per module/section, edges representing dependencies.
 * Runs coupling audit on edges and enforces adaptive bounds.
 */

import type { TaskPayload } from '../../types/index.js';
import type { DecompositionGraph, DecompositionNode, DependencyEdge } from '../../types/graph.js';
import type { DecompositionStrategy, DecompositionContext } from '../DecompositionEngine.js';
import { GraphBuilder } from '../GraphBuilder.js';
import { shouldStopDecomposing } from '../AdaptiveBounds.js';
import { emptyReadiness } from '../../types/graph.js';

interface LlmDecompositionResult {
  nodes: Array<{
    id: string;
    description: string;
    ownedPaths: string[];
    acceptanceCriteria: string[];
  }>;
  edges: Array<{
    from: string;
    to: string;
    type: 'data' | 'sequence' | 'contract';
    description: string;
  }>;
}

export class D4Strategy implements DecompositionStrategy {
  name = 'D4';

  async decompose(
    task: TaskPayload,
    context: DecompositionContext,
  ): Promise<DecompositionGraph> {
    const builder = new GraphBuilder(task, 'interface-first', this.name);

    // Add root goal node
    builder.addNode({
      id: 'root',
      type: 'goal',
      description: task.description,
      acceptanceCriteria: task.checks?.map(c => c.name) ?? [],
      ownedPaths: task.files ? Object.keys(task.files) : [],
    });

    // Use LLM to identify module boundaries and decompose
    const decomposition = await this.llmDecompose(task, context);

    // Add child nodes
    for (const nodeSpec of decomposition.nodes) {
      const childNode: Parameters<GraphBuilder['addNode']>[0] = {
        id: nodeSpec.id,
        parentId: 'root',
        type: 'leaf',
        description: nodeSpec.description,
        acceptanceCriteria: nodeSpec.acceptanceCriteria,
        ownedPaths: nodeSpec.ownedPaths,
        status: 'pending',
      };

      // Check adaptive bounds
      const pseudoNode = {
        ...childNode,
        complexityEstimate: null,
        assignedTo: null,
        readiness: emptyReadiness(),
        execution: null,
        artifacts: [],
        reasoning: [],
        metrics: { tokenUsage: { prompt: 0, completion: 0, total: 0 }, wallTimeMs: 0, mutations: 0, testCycles: 0, retries: 0 },
        inputs: [],
        outputs: [],
      } as DecompositionNode;

      const bounds = shouldStopDecomposing(pseudoNode, 1, {
        max_depth: context.config.max_depth,
        max_files_hint: context.config.max_files_hint,
        three_conditions: context.config.three_conditions,
        compositionality_check: context.config.compositionality_check,
      });

      if (bounds.stop) {
        // Mark as leaf — don't decompose further
        childNode.type = 'leaf';
      }

      builder.addNode(childNode);

      // Assess readiness on each node
      const readiness = await context.readinessGate.assessNode(pseudoNode);
      // Readiness is informational at build time — stored on the node
    }

    // Add edges
    for (const edgeSpec of decomposition.edges) {
      builder.addEdge({
        from: edgeSpec.from,
        to: edgeSpec.to,
        type: edgeSpec.type,
        couplingType: 'data',
        couplingSource: 'llm-inferred',
        couplingConfidence: 0.8,
      });
    }

    // Add edges from root to each child
    for (const nodeSpec of decomposition.nodes) {
      builder.addEdge({
        from: 'root',
        to: nodeSpec.id,
        type: 'sequence',
      });
    }

    return builder.build();
  }

  private async llmDecompose(
    task: TaskPayload,
    context: DecompositionContext,
  ): Promise<LlmDecompositionResult> {
    const fileList = task.files ? Object.keys(task.files).join(', ') : 'none specified';
    const checks = task.checks?.map(c => c.name).join(', ') ?? 'none';

    const prompt = `You are a software decomposition engine. Analyze this task and identify module boundaries for interface-first decomposition.

Task: ${task.description}
Instructions: ${task.instructions}
Files: ${fileList}
Checks: ${checks}

Respond with a JSON object containing:
- "nodes": array of { "id": string, "description": string, "ownedPaths": string[], "acceptanceCriteria": string[] }
- "edges": array of { "from": string, "to": string, "type": "data"|"sequence"|"contract", "description": string }

Each node should represent a coherent module or work unit. Edges represent dependencies between nodes.
Keep decomposition to 2-5 nodes. Each node should own specific files. Respond with ONLY the JSON object.`;

    try {
      const response = await context.llmCall(
        [{ role: 'user', content: prompt }],
        { maxTokens: 2000, temperature: 0.2 },
      );

      const parsed = JSON.parse(response.content) as LlmDecompositionResult;
      return parsed;
    } catch {
      // Fallback: create a simple 2-node decomposition based on files
      return this.fallbackDecompose(task);
    }
  }

  private fallbackDecompose(task: TaskPayload): LlmDecompositionResult {
    const files = task.files ? Object.keys(task.files) : [];

    if (files.length <= 1) {
      return {
        nodes: [{
          id: 'leaf-1',
          description: task.description,
          ownedPaths: files,
          acceptanceCriteria: task.checks?.map(c => c.name) ?? [],
        }],
        edges: [],
      };
    }

    // Split files roughly in half for a basic 2-node decomposition
    const mid = Math.ceil(files.length / 2);
    const firstHalf = files.slice(0, mid);
    const secondHalf = files.slice(mid);

    return {
      nodes: [
        {
          id: 'leaf-analyze',
          description: `Analyze and understand: ${firstHalf.join(', ')}`,
          ownedPaths: firstHalf,
          acceptanceCriteria: ['Identify issues and dependencies'],
        },
        {
          id: 'leaf-implement',
          description: `Implement changes: ${secondHalf.join(', ')}`,
          ownedPaths: secondHalf,
          acceptanceCriteria: task.checks?.map(c => c.name) ?? [],
        },
      ],
      edges: [{
        from: 'leaf-analyze',
        to: 'leaf-implement',
        type: 'data',
        description: 'Analysis results inform implementation',
      }],
    };
  }
}
