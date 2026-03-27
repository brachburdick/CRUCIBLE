# CRUCIBLE Phase 3: Graph Executor (RunEngine v2)

## Context
CRUCIBLE is an adaptive agent pipeline at /Users/brach/Documents/THE_FACTORY/projects/CRUCIBLE.
It has:
- **Phase 0**: GraphBuilder, GraphStore — graph data model and persistence
- **Phase 1**: ReadinessGate, QuestionGenerator — task readiness assessment (6 global checks)
- **Phase 2**: DecompositionEngine with D0/D4/D5 strategies, ComplexityEstimator, CouplingAudit, AdaptiveBounds
- **Phase 2.5**: SessionModel — state snapshots, task management, question queue, run records, mutation tracking, flow templates

Phase 3 is the **Graph Executor** — it walks a DecompositionGraph, dispatches each leaf node to a sandboxed agent with the right flow template and mutation budget, handles failures/re-decomposition, and produces a final RunResult.

Read the existing code before writing anything. Understand the architecture, patterns, and type contracts.

## Architecture Overview

### What exists today

**Current RunEngine** (`src/engine/RunEngine.ts`):
- Extends EventEmitter, runs a single agent in an E2B sandbox
- Composes middleware: tokenBudget → loopDetector → tracer
- Races agent execution against a TTL timer
- Runs acceptance checks, then convergent teardown
- Emits events: run_started, sandbox_created, token_warning, loop_warning, agent_completed, checks_completed, run_completed

**DecompositionGraph** (`src/types/graph.ts`):
- Nodes have types: goal | milestone | task | leaf
- Node statuses: pending | ready | active | completed | failed | blocked | skipped
- Edges have types: data | sequence | contract
- Each node has: acceptanceCriteria, ownedPaths, inputs/outputs (ArtifactRef), execution (ExecutionRecord), readiness (ReadinessAssessment)
- ExecutionRecord tracks: tokenUsage, wallTimeMs, mutations, testCycles, toolCalls, verificationResults
- ExecutionRecord.exitReason extends KillReason with `{type: 'escalated'; question: string}` and `{type: 'redecomposed'}`

**SessionModel** (`src/session/index.ts`):
- `StateSnapshotManager` — load/save session state, track decisions/dead-ends/key-locations
- `TaskManager` — JSONL persistence, `ready()` dependency resolver with priority sort, claim/complete lifecycle
- `QuestionQueue` — non-blocking async question/answer, filter by task
- `RunRecordStore` — append-only audit trail
- `MutationTracker` — preMutation(filePath) → allowed/blocked, postMutation(), recordTestRun(), resetNode(), resetBudget()
  - Per-node: 2 consecutive mutations without test = blocked
  - Per-graph: 10 total mutations compound budget
  - Circuit breakers: 4 edit-test cycles per node = halt, 10 unique files = halt
- Flow templates: `getFlowTemplate(type)`, `validatePhaseTransition(flow, from, to)`, `getPhaseNames(type)`
  - Debug: reproduce → isolate → diagnose → fix → verify
  - Feature: intent → spec → plan → implement → test → verify
  - Refactor: scope → snapshot → transform → verify

**Sandbox** (`src/sandbox/`):
- `SandboxRunner.create(config)` — creates E2B sandbox with TTL, uploads files
- `SandboxRunner.getToolContext()` — returns {exec, writeFile, readFile}
- `SandboxRunner.flushArtifacts(runId)` — downloads all files from sandbox
- `SandboxRunner.destroy()` — kills sandbox
- `teardown(context, killReason)` — single convergent path: log kill → flush artifacts → close tracer → destroy sandbox → write result
- `createIdempotentTeardown(context)` — once-only wrapper

**Middleware** (`src/middleware/`):
- `composeMiddleware(base, ...middlewares)` — left-fold composition, last = outermost
- `createTokenBudget(config)` — returns {middleware, getTokenCount}
- `createLoopDetector(config)` — returns {middleware} (OpenAI embeddings for semantic similarity)

**Key types** (`src/types/index.ts`):
- `AgentFn = (llmCall: LlmCallFn, tools: ToolContext) => Promise<AgentOutput>`
- `Middleware = (next: LlmCallFn) => LlmCallFn`
- `KillReason` — completed | budget_exceeded | loop_detected | ttl_exceeded
- `RunConfig` — taskPayload, variantLabel, tokenBudget, ttlSeconds, loopDetection
- `RunResult` — runId, variantLabel, exitReason, tokenUsage, wallTimeMs, artifacts

### Codebase patterns to follow
- TypeScript ESM with NodeNext — all imports use explicit `.js` extensions
- `node:` prefix for Node built-ins
- Named exports only (no default exports)
- Interfaces for data, classes for services
- Discriminated unions with `type` field
- `private readonly` for constructor-injected dependencies
- Factory functions for default values (e.g., `emptyNodeMetrics()`)
- Tests use `node:test` with `describe/it` and `node:assert/strict`
- Event-driven communication via EventEmitter

## What to build

### 1. GraphExecutor class (`src/engine/GraphExecutor.ts`)

The core orchestrator that walks a DecompositionGraph and dispatches leaf nodes.

```typescript
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
  /** How to get the LLM call function for a node */
  baseLlmCall: LlmCallFn;
  /** Agent factory — creates an AgentFn from a node's context */
  agentFactory: (node: DecompositionNode, systemPrompt: string) => AgentFn;
}
```

**Execution algorithm:**
1. Initialize: set graph status to 'executing', save snapshot
2. **Scheduling loop** — repeat until graph is completed/failed/budget_exceeded:
   a. Compute ready nodes: status='pending', all upstream deps (edges where `to=thisNode`) have source node status='completed'
   b. For each ready node, mark status='ready', run readiness gate
   c. If readiness passes, dispatch the node (see below)
   d. If readiness fails and generates questions, write them to session.questions, mark node 'blocked'
   e. After each node completes, update graph metrics, persist graph + node detail, save snapshot
   f. Check graph-level termination conditions
3. On completion: set graph status, write run record, finalize session

**Node dispatch** (for leaf nodes):
1. Mark node status='active', record startedAt in ExecutionRecord
2. Determine flow type from node context (task description keywords → debug/feature/refactor)
3. Build system prompt: base instructions + flow template phases/rules + node's acceptanceCriteria + ownedPaths
4. Call session.mutations.resetNode() for fresh per-node budget
5. Create a SandboxRunner for this node
6. Stack middleware: tokenBudget → loopDetector → (mutation-aware wrapper)
7. The mutation-aware middleware intercepts tool calls to writeFile/exec and calls session.mutations.preMutation/postMutation
8. Run the agent via agentFactory(node, systemPrompt)
9. Handle the result:
   - **Success**: mark node 'completed', record ExecutionRecord, run acceptance criteria checks
   - **Budget exceeded / Loop detected / TTL exceeded**: mark node 'failed', record exit reason
   - **Escalated**: write question to session.questions, mark node 'blocked'
10. Teardown sandbox for this node
11. Persist node detail to GraphStore

**Non-leaf node handling:**
- goal/milestone/task nodes are "virtual" — they complete when all children complete
- Track completion by checking if all child nodes (nodes with parentId = this node) are completed
- If any child fails, the parent is marked failed (unless re-decomposition is triggered)

**Re-decomposition (D5-style):**
- When a leaf node fails and the strategy supports it (D5), the executor can:
  1. Mark the failed node with exitReason `{type: 'redecomposed'}`
  2. Call DecompositionEngine to re-decompose that subtree
  3. Splice new nodes/edges into the graph
  4. Continue the scheduling loop
- Gate this behind a config flag `allowRedecomposition: boolean`
- Limit re-decomposition depth (max 1 re-decompose per original node)

### 2. System Prompt Builder (`src/engine/PromptBuilder.ts`)

Constructs the system prompt injected into each node's agent.

```typescript
export function buildNodePrompt(
  node: DecompositionNode,
  flow: FlowTemplate,
  graph: DecompositionGraph,
  sessionKnowledge: SessionKnowledge
): string
```

The prompt should include:
- **Role**: "You are an agent executing node {id} of a decomposition graph."
- **Task**: node.description + node.acceptanceCriteria
- **Scope boundary**: node.ownedPaths (files you may modify), warn about out-of-scope edits
- **Flow phases**: list the phases with entry/exit gates
- **Flow rules**: list hard rules as MUST, advisory as SHOULD
- **Inputs**: describe artifacts available from upstream nodes (from edges where to=this node)
- **Prior knowledge**: inject relevant decisions and dead ends from sessionKnowledge
- **Constraints**: mutation budget limits, 2-attempt cap, context gate (turn > 40 = partial)

### 3. Node Scheduler (`src/engine/NodeScheduler.ts`)

Extracts the scheduling logic into a testable unit.

```typescript
export interface SchedulerState {
  graph: DecompositionGraph;
  /** Set of node IDs currently being executed */
  activeNodeIds: Set<string>;
}

export class NodeScheduler {
  /** Returns nodes that are ready to execute (all deps complete, not already active) */
  getReadyNodes(state: SchedulerState): DecompositionNode[]

  /** Check if graph execution is complete (all leaves completed/failed/skipped) */
  isGraphComplete(state: SchedulerState): boolean

  /** Check if graph is deadlocked (no ready nodes, but incomplete leaves exist) */
  isDeadlocked(state: SchedulerState): boolean

  /** Update a virtual (non-leaf) node's status based on its children */
  resolveParentStatus(graph: DecompositionGraph, nodeId: string): 'completed' | 'failed' | 'active'
}
```

### 4. Mutation-Aware Middleware (`src/middleware/mutationGuard.ts`)

Wraps tool calls to enforce mutation budget at the middleware level.

```typescript
export function createMutationGuard(
  tracker: MutationTracker,
  tools: ToolContext
): ToolContext
```

Returns a new ToolContext where:
- `writeFile(path, content)` calls `tracker.preMutation(path)` first — if blocked, throws a descriptive error that the agent sees
- After successful write, calls `tracker.postMutation(path)`
- `exec(cmd)` checks if the command looks like a test runner (pytest, jest, npm test, etc.) and if so, calls `tracker.recordTestRun()` after execution

### 5. Update existing engine barrel (`src/engine/index.ts`)

Add exports for GraphExecutor, PromptBuilder, NodeScheduler.

### 6. Tests (`src/test/phase3.test.ts`)

Write tests for:

**NodeScheduler tests:**
- Ready node computation with various dependency configurations
- Graph completion detection (all leaves done)
- Deadlock detection (no ready nodes, incomplete work)
- Parent status resolution (all children done → parent done, any child failed → parent failed)

**PromptBuilder tests:**
- Prompt includes node description and acceptance criteria
- Prompt includes flow phases for the detected flow type
- Prompt includes owned paths as scope boundary
- Prompt includes upstream artifact descriptions
- Prompt includes session knowledge (decisions, dead ends)

**MutationGuard tests:**
- writeFile blocked when preMutation returns false
- writeFile allowed and postMutation called on success
- Test command detection triggers recordTestRun

**GraphExecutor integration tests (with mocks):**
- Single-node graph: dispatches, completes, produces RunResult
- Two-node chain: A → B, executes in order
- Node failure marks node as failed, graph continues with remaining nodes
- Question escalation: node writes question, gets marked blocked
- Mutation budget halt stops node execution
- Graph-level budget exhaustion ends execution

## Constraints

- TypeScript ESM, consistent with existing patterns (`.js` extensions, `node:` prefix, named exports)
- Do NOT modify existing Phase 0/1/2/2.5 code — this is purely additive
- The GraphExecutor should work with the existing SandboxRunner and middleware stack
- Mock the sandbox and LLM in tests — do not require E2B credentials
- All new types go in existing type files or a new `src/types/executor.ts` if needed
- Follow the event-driven pattern: GraphExecutor should extend EventEmitter and emit events for node lifecycle changes
- The existing RunEngine stays as-is — GraphExecutor is a new class that the RunEngine can delegate to for graph-based execution

## File inventory

New files to create:
```
src/engine/GraphExecutor.ts    — core graph walking + node dispatch
src/engine/PromptBuilder.ts    — system prompt construction for nodes
src/engine/NodeScheduler.ts    — ready-node computation, completion/deadlock checks
src/middleware/mutationGuard.ts — mutation-budget-aware ToolContext wrapper
src/test/phase3.test.ts        — unit + integration tests
```

Files to modify:
```
src/engine/index.ts            — add Phase 3 exports
package.json                   — add phase3 test to test script
```

## Key design decisions

1. **Sequential node execution first.** Start with dispatching one node at a time. Parallel execution (multiple sandboxes) is a future optimization — the scheduler should support it structurally but the executor runs sequentially.

2. **Sandbox-per-node.** Each leaf node gets its own sandbox. This provides isolation but means artifacts must be explicitly passed between nodes (via GraphStore, not shared filesystem).

3. **Flow type detection.** Infer from node description using the same keyword signals as THE_FACTORY's flow routing: fix/bug/error → debug, implement/add/create → feature, refactor/extract/consolidate → refactor. Default to feature if ambiguous.

4. **Graceful degradation.** If the readiness gate fails for a node, don't halt the graph. Mark it blocked, continue with other ready nodes, and let the operator answer questions async.

5. **Budget accounting.** Track per-node token usage in NodeMetrics AND aggregate into GraphMetrics. The graph-level compound mutation budget spans all nodes.
