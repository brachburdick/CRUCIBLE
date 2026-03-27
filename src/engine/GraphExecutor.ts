/**
 * Graph Executor — walks a DecompositionGraph, dispatches leaf nodes to
 * sandboxed agents with the right flow template and mutation budget,
 * handles failures/re-decomposition, and produces a final GraphExecutionResult.
 *
 * Extends EventEmitter to emit structured lifecycle events.
 * Sequential node execution (one at a time) — parallel is a future optimization.
 */

import { EventEmitter } from 'node:events';
import type {
  AgentFn,
  KillReason,
  LlmCallFn,
  RunConfig,
  ToolContext,
} from '../types/index.js';
import { BudgetExceededError, LoopDetectedError } from '../types/index.js';
import type {
  DecompositionGraph,
  DecompositionNode,
  ExecutionRecord,
  GraphEvent,
} from '../types/graph.js';
import { emptyNodeMetrics } from '../types/graph.js';
import type { SessionModel } from '../session/index.js';
import type { FlowType, SessionKnowledge } from '../session/types.js';
import { getFlowTemplate } from '../session/flow-templates.js';
import { GraphStore } from './GraphStore.js';
import { NodeScheduler } from './NodeScheduler.js';
import { buildNodePrompt } from './PromptBuilder.js';
import { createMutationGuard } from '../middleware/mutationGuard.js';
import { createTokenBudget } from '../middleware/tokenBudget.js';
import { createLoopDetector } from '../middleware/loopDetector.js';
import { composeMiddleware } from '../middleware/stack.js';
import { SandboxRunner } from '../sandbox/runner.js';

// ─── Config ───

export interface GraphExecutorConfig {
  graph: DecompositionGraph;
  session: SessionModel;
  graphStore: GraphStore;
  /** Per-node token budget (not graph-wide) */
  nodeTokenBudget: number;
  /** Per-node wall-clock TTL in seconds */
  nodeTtlSeconds: number;
  /** Loop detection config (passed to each node's middleware stack) */
  loopDetection: { windowSize: number; similarityThreshold: number; consecutiveTurns: number };
  /** Base LLM call function — middleware is stacked on top per-node */
  baseLlmCall: LlmCallFn;
  /** Agent factory — creates an AgentFn from a node's context and system prompt */
  agentFactory: (node: DecompositionNode, systemPrompt: string) => AgentFn;
  /** Allow re-decomposition of failed nodes (D5-style). Default: false */
  allowRedecomposition?: boolean;
  /** Optional: create a sandbox for a node. Override for testing. */
  sandboxFactory?: (node: DecompositionNode) => Promise<SandboxContext>;
}

export interface SandboxContext {
  tools: ToolContext;
  getTokenCount: () => number;
  wrappedLlmCall: LlmCallFn;
  destroy: () => Promise<void>;
}

// ─── Result ───

export interface GraphExecutionResult {
  graphId: string;
  status: DecompositionGraph['status'];
  nodesCompleted: number;
  nodesFailed: number;
  totalTokens: number;
  totalWallTimeMs: number;
}

// ─── Events ───

export interface GraphExecutorEvent {
  graphId: string;
  event: string;
  nodeId?: string;
  data: Record<string, unknown>;
  timestamp: string;
}

// ─── Flow type detection ───

const FLOW_KEYWORDS: Array<{ pattern: RegExp; type: FlowType }> = [
  { pattern: /\b(?:fix|bug|error|broken|regression|failing)\b/i, type: 'debug' },
  { pattern: /\b(?:refactor|extract|consolidate|simplify)\b/i, type: 'refactor' },
  { pattern: /\b(?:implement|add|create|new|build|feature)\b/i, type: 'feature' },
];

export function detectFlowType(description: string): FlowType {
  for (const { pattern, type } of FLOW_KEYWORDS) {
    if (pattern.test(description)) return type;
  }
  return 'feature'; // default
}

// ─── GraphExecutor ───

export class GraphExecutor extends EventEmitter {
  private readonly config: GraphExecutorConfig;
  private readonly scheduler: NodeScheduler;
  private readonly activeNodeIds: Set<string> = new Set();
  private graph: DecompositionGraph;
  private startedAt: Date | null = null;

  constructor(config: GraphExecutorConfig) {
    super();
    this.config = config;
    this.graph = config.graph;
    this.scheduler = new NodeScheduler();
  }

  /** Emit a structured graph executor event. */
  private emitEvent(event: string, data: Record<string, unknown>, nodeId?: string): void {
    const evt: GraphExecutorEvent = {
      graphId: this.graph.id,
      event,
      nodeId,
      data,
      timestamp: new Date().toISOString(),
    };
    this.emit('graph:event', evt);
  }

  /** Append event to graph store (best-effort). */
  private async appendGraphEvent(
    type: GraphEvent['type'],
    nodeId: string | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.config.graphStore.appendEvent(this.graph.id, {
        timestamp: new Date().toISOString(),
        type,
        nodeId,
        detail,
      });
    } catch {
      // Non-critical — don't block execution
    }
  }

  /** Find a node by ID in the graph. */
  private findNode(nodeId: string): DecompositionNode | undefined {
    return this.graph.nodes.find(n => n.id === nodeId);
  }

  /** Update a node's status and persist. */
  private async setNodeStatus(
    nodeId: string,
    status: DecompositionNode['status'],
  ): Promise<void> {
    const node = this.findNode(nodeId);
    if (!node) return;

    const oldStatus = node.status;
    node.status = status;
    this.graph.updatedAt = new Date().toISOString();

    this.emitEvent('node_status_changed', { oldStatus, newStatus: status }, nodeId);
    await this.appendGraphEvent('node_status_changed', nodeId, { oldStatus, newStatus: status });
  }

  /**
   * Execute the full graph. Returns when all nodes are done, failed,
   * or the graph is deadlocked/budget-exceeded.
   */
  async execute(): Promise<GraphExecutionResult> {
    this.startedAt = new Date();
    let totalTokens = 0;

    // Step 1: Set graph status to 'executing'
    this.graph.status = 'executing';
    this.graph.updatedAt = new Date().toISOString();
    await this.config.graphStore.saveGraph(this.graph);
    this.emitEvent('graph_execution_started', {});

    // Step 2: Scheduling loop
    while (true) {
      const state = { graph: this.graph, activeNodeIds: this.activeNodeIds };

      // Check termination
      if (this.scheduler.isGraphComplete(state)) {
        break;
      }

      if (this.scheduler.isDeadlocked(state)) {
        this.emitEvent('graph_deadlocked', {});
        this.graph.status = 'failed';
        break;
      }

      // Check graph-level mutation halt
      if (this.config.session.mutations.isHalted) {
        this.emitEvent('graph_budget_exceeded', {
          reason: this.config.session.mutations.getState().haltReason,
        });
        this.graph.status = 'budget_exceeded';
        break;
      }

      // Get ready nodes
      const readyNodes = this.scheduler.getReadyNodes(state);
      if (readyNodes.length === 0) {
        // No ready nodes but not complete and not deadlocked — shouldn't happen,
        // but break to avoid infinite loop
        break;
      }

      // Sequential execution: dispatch one node at a time
      const node = readyNodes[0];
      await this.setNodeStatus(node.id, 'ready');

      // Dispatch the leaf node
      const nodeTokens = await this.dispatchNode(node);
      totalTokens += nodeTokens;

      // After dispatch, resolve parent statuses
      await this.resolveAncestors(node.id);

      // Persist graph state
      await this.config.graphStore.saveGraph(this.graph);
    }

    // Step 3: Finalize
    if (this.graph.status === 'executing') {
      // Determine final status from node states
      const leaves = this.graph.nodes.filter(n => n.type === 'leaf');
      const anyFailed = leaves.some(n => n.status === 'failed');
      this.graph.status = anyFailed ? 'failed' : 'completed';
    }

    // Update graph metrics
    const wallTimeMs = Date.now() - this.startedAt.getTime();
    this.graph.metrics.totalTokens = totalTokens;
    this.graph.metrics.totalWallTimeMs = wallTimeMs;
    this.graph.metrics.completedCount = this.graph.nodes.filter(n => n.status === 'completed').length;
    this.graph.metrics.failedCount = this.graph.nodes.filter(n => n.status === 'failed').length;
    this.graph.updatedAt = new Date().toISOString();

    await this.config.graphStore.saveGraph(this.graph);
    await this.appendGraphEvent('graph_completed', null, { status: this.graph.status });
    this.emitEvent('graph_execution_completed', {
      status: this.graph.status,
      totalTokens,
      wallTimeMs,
    });

    // Write session run record
    await this.config.session.finalize();

    return {
      graphId: this.graph.id,
      status: this.graph.status,
      nodesCompleted: this.graph.metrics.completedCount,
      nodesFailed: this.graph.metrics.failedCount,
      totalTokens,
      totalWallTimeMs: wallTimeMs,
    };
  }

  /**
   * Dispatch a single leaf node: create sandbox, stack middleware,
   * run the agent, handle the result, teardown.
   */
  private async dispatchNode(node: DecompositionNode): Promise<number> {
    this.activeNodeIds.add(node.id);
    await this.setNodeStatus(node.id, 'active');

    const nodeStartedAt = new Date();
    node.execution = {
      startedAt: nodeStartedAt.toISOString(),
      completedAt: null,
      exitReason: { type: 'completed' },
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      wallTimeMs: 0,
      mutations: 0,
      testCycles: 0,
      toolCalls: [],
      verificationResults: [],
    };

    this.emitEvent('node_dispatch_started', { description: node.description }, node.id);
    await this.appendGraphEvent('node_execution_started', node.id, {});

    // Determine flow type
    const flowType = detectFlowType(node.description);
    const flow = getFlowTemplate(flowType);

    // Build system prompt
    const sessionKnowledge = this.config.session.snapshot.current.sessionKnowledge;
    const systemPrompt = buildNodePrompt(node, flow, this.graph, sessionKnowledge);

    // Reset per-node mutation budget
    this.config.session.mutations.resetNode();

    let tokenCount = 0;
    let killReason: KillReason | { type: 'escalated'; question: string } = { type: 'completed' };

    // Use sandboxFactory if provided (tests), otherwise create real sandbox
    let sandboxCtx: SandboxContext | null = null;

    try {
      if (this.config.sandboxFactory) {
        sandboxCtx = await this.config.sandboxFactory(node);
      } else {
        sandboxCtx = await this.createNodeSandbox(node);
      }

      // Wrap tools with mutation guard
      const guardedTools = createMutationGuard(
        this.config.session.mutations,
        sandboxCtx.tools,
      );

      // Create agent and run
      const agentFn = this.config.agentFactory(node, systemPrompt);

      // TTL timer
      const ttlMs = this.config.nodeTtlSeconds * 1000;
      let ttlFired = false;

      const ttlPromise = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          ttlFired = true;
          resolve();
        }, ttlMs);
        timer.unref();
      });

      const agentResult = await Promise.race([
        agentFn(sandboxCtx.wrappedLlmCall, guardedTools),
        ttlPromise.then(() => null),
      ]);

      tokenCount = sandboxCtx.getTokenCount();

      if (agentResult === null || ttlFired) {
        const wallTimeMs = Date.now() - nodeStartedAt.getTime();
        killReason = { type: 'ttl_exceeded', wallTimeMs, ttlMs };
      } else {
        killReason = { type: 'completed' };
      }
    } catch (err) {
      tokenCount = sandboxCtx?.getTokenCount() ?? 0;

      if (err instanceof BudgetExceededError) {
        killReason = { type: 'budget_exceeded', tokenCount: err.tokenCount, budget: err.budget };
      } else if (err instanceof LoopDetectedError) {
        killReason = {
          type: 'loop_detected',
          similarityScore: err.similarityScore,
          consecutiveCount: err.consecutiveCount,
          lastMessages: err.lastMessages,
        };
      } else if (err instanceof Error && err.message.startsWith('Mutation blocked:')) {
        // Mutation budget halt — treat as budget exceeded at graph level
        killReason = { type: 'budget_exceeded', tokenCount, budget: this.config.nodeTokenBudget };
      } else {
        // Unknown error — mark node as failed
        this.emitEvent('node_error', {
          error: err instanceof Error ? err.message : String(err),
        }, node.id);
        // Use budget_exceeded as the exit reason to signal failure
        killReason = { type: 'budget_exceeded', tokenCount, budget: this.config.nodeTokenBudget };
      }
    } finally {
      // Teardown sandbox
      if (sandboxCtx) {
        try {
          await sandboxCtx.destroy();
        } catch {
          // Teardown must not throw
        }
      }
    }

    // Record execution result
    const nodeCompletedAt = new Date();
    const wallTimeMs = nodeCompletedAt.getTime() - nodeStartedAt.getTime();
    const mutationState = this.config.session.mutations.getState();

    node.execution!.completedAt = nodeCompletedAt.toISOString();
    node.execution!.exitReason = killReason;
    node.execution!.tokenUsage = { prompt: 0, completion: 0, total: tokenCount };
    node.execution!.wallTimeMs = wallTimeMs;
    node.execution!.mutations = mutationState.totalMutations;
    node.execution!.testCycles = mutationState.editTestCycles;

    // Update node metrics
    node.metrics.tokenUsage = { prompt: 0, completion: 0, total: tokenCount };
    node.metrics.wallTimeMs = wallTimeMs;
    node.metrics.mutations = mutationState.totalMutations;
    node.metrics.testCycles = mutationState.editTestCycles;

    // Set final status
    if (killReason.type === 'completed') {
      await this.setNodeStatus(node.id, 'completed');
    } else if ('question' in killReason) {
      // Escalated — node has a question that needs answering
      await this.setNodeStatus(node.id, 'blocked');
    } else {
      await this.setNodeStatus(node.id, 'failed');
    }

    // Persist node detail
    try {
      await this.config.graphStore.saveNodeDetail(this.graph.id, node.id, node);
    } catch {
      // Non-critical
    }

    await this.appendGraphEvent('node_execution_completed', node.id, {
      exitReason: killReason,
      tokenCount,
      wallTimeMs,
    });

    this.emitEvent('node_dispatch_completed', {
      exitReason: killReason,
      tokenCount,
      wallTimeMs,
    }, node.id);

    this.activeNodeIds.delete(node.id);
    return tokenCount;
  }

  /**
   * Create a real sandbox context for a node (production path).
   */
  private async createNodeSandbox(node: DecompositionNode): Promise<SandboxContext> {
    const runConfig: RunConfig = {
      taskPayload: {
        description: node.description,
        instructions: node.description,
      },
      variantLabel: `node-${node.id}`,
      tokenBudget: this.config.nodeTokenBudget,
      ttlSeconds: this.config.nodeTtlSeconds,
      loopDetection: this.config.loopDetection,
    };

    const sandboxRunner = await SandboxRunner.create(runConfig);
    const tools = sandboxRunner.getToolContext();

    // Create middleware stack
    const { middleware: tokenBudgetMW, getTokenCount } = createTokenBudget({
      budget: this.config.nodeTokenBudget,
      onWarning: (threshold, currentCount, budget) => {
        this.emitEvent('token_warning', { threshold, currentCount, budget }, node.id);
      },
    });

    const loopDetectorMW = createLoopDetector({
      ...this.config.loopDetection,
      onWarning: (meanSimilarity, consecutiveCount) => {
        this.emitEvent('loop_warning', { meanSimilarity, consecutiveCount }, node.id);
      },
    });

    const wrappedLlmCall = composeMiddleware(this.config.baseLlmCall, tokenBudgetMW, loopDetectorMW);

    return {
      tools,
      getTokenCount,
      wrappedLlmCall,
      destroy: async () => sandboxRunner.destroy(),
    };
  }

  /**
   * Walk up from a node, resolving parent statuses.
   */
  private async resolveAncestors(nodeId: string): Promise<void> {
    const node = this.findNode(nodeId);
    if (!node?.parentId) return;

    let currentParentId: string | null = node.parentId;
    while (currentParentId) {
      const parentNode = this.findNode(currentParentId);
      if (!parentNode) break;

      const resolvedStatus = this.scheduler.resolveParentStatus(this.graph, currentParentId);
      if (resolvedStatus !== 'active' && parentNode.status !== resolvedStatus) {
        await this.setNodeStatus(currentParentId, resolvedStatus);
      }

      currentParentId = parentNode.parentId;
    }
  }
}
