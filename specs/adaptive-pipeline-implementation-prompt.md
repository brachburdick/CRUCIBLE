# Implementation Prompt: CRUCIBLE Adaptive Pipeline — Phase 0 + Phase 1 + Phase 2

You are implementing the first three phases of CRUCIBLE's Adaptive Pipeline. These phases lay the foundation (data model), implement the readiness gate, and build the decomposition engine with three strategies. All three phases are described in `specs/adaptive-pipeline-plan.md` and specified in `specs/adaptive-pipeline-spec.md`.

---

## Context

CRUCIBLE is THE_FACTORY's experimental arm — a sandboxed agent evaluation harness. Phase 1 (MVP) is complete: it runs an agent in an E2B sandbox with kill switches (token budget, semantic loop detection, wall-clock TTL), traces via Langfuse, and outputs structured JSON results.

You are building Phase 2+: the ability to decompose tasks, assess readiness, walk decomposition graphs, and compare pipeline configurations. This session covers the data model (Phase 0), readiness gate (Phase 1), and decomposition engine (Phase 2).

**Stack:** TypeScript (ESM, NodeNext), Node 18+, E2B, Langfuse, OpenAI (embeddings only), Commander CLI, Fastify server, better-sqlite3.

**Critical rules:**
- Single convergent teardown path — all exits go through the same cleanup
- Middleware composed via `composeMiddleware()`, order matters (rightmost = outermost)
- OpenAI dependency is for embeddings only, not LLM calls
- ESM module resolution — use NodeNext, `.js` extensions in imports
- All new code is additive — do NOT modify existing types or break existing RunEngine behavior

---

## Existing Codebase (read these files first)

**Types:** `src/types/index.ts` — RunConfig, TaskPayload, KillReason, RunResult, LlmCallFn, AgentFn, Middleware, VariantConfig, CheckSpec, ScoreResult, ToolContext, error classes.

**Engine:** `src/engine/RunEngine.ts` — EventEmitter subclass. `startRun(config, agentName, agentConfig?)` creates sandbox, composes middleware, runs agent with TTL race, captures results. Emits `run:event` with RunEvent objects.

**Middleware:** `src/middleware/stack.ts` — `composeMiddleware(base, ...middlewares)`. `tokenBudget.ts` — per-run token tracking with 50%/80% warnings, BudgetExceededError at 100%. `loopDetector.ts` — OpenAI embedding similarity, LoopDetectedError.

**Variants:** `src/engine/variants.ts` — loads YAML configs from `variants/`. Resolves `.md` systemPrompt files and skill files.

**Agents:** `src/engine/agents.ts` — AGENTS registry (echo, looping, coder). `src/agents/coder.ts` — 4 tools (read_file, write_file, exec, task_complete), max 50 turns.

**Sandbox:** `src/sandbox/runner.ts` — `SandboxRunner.create(config)`, returns ToolContext. `src/sandbox/teardown.ts`.

**Scoring:** `src/engine/scorer.ts` — `runChecks(checks, tools)` returns ScoreResult.

**Server:** Fastify + WebSocket at `src/server/`. SQLite at `src/server/db.ts`.

**CLI:** `src/cli/run.ts`, `src/cli/compare.ts`.

---

## Phase 0: DecompositionGraph Data Model + Storage

### What to build

**1. `src/types/graph.ts`** — All graph-related TypeScript interfaces. Export everything. Do NOT modify `src/types/index.ts` — import from it where needed.

```typescript
// Core graph
interface DecompositionGraph {
  id: string;
  taskOrigin: TaskPayload;              // from types/index.ts
  pipelineDefinition: string;           // name of PipelineDefinition that produced this
  strategyUsed: string;
  createdAt: string;                    // ISO 8601
  updatedAt: string;
  rootNodeId: string;
  nodes: DecompositionNode[];
  edges: DependencyEdge[];
  status: "decomposing" | "executing" | "completed" | "failed" | "budget_exceeded";
  metrics: GraphMetrics;
}

interface DecompositionNode {
  id: string;
  parentId: string | null;
  type: "goal" | "milestone" | "task" | "leaf";
  description: string;
  acceptanceCriteria: string[];
  ownedPaths: string[];
  inputs: ArtifactRef[];
  outputs: ArtifactRef[];
  status: "pending" | "ready" | "active" | "completed" | "failed" | "blocked" | "skipped";
  complexityEstimate: "simple" | "moderate" | "complex" | null;
  assignedTo: string | null;
  readiness: ReadinessAssessment;
  execution: ExecutionRecord | null;
  artifacts: Artifact[];
  reasoning: ReasoningEntry[];
  metrics: NodeMetrics;
}

interface DependencyEdge {
  from: string;
  to: string;
  type: "data" | "sequence" | "contract";
  contract: InterfaceContract | null;
  couplingType: "data" | "stamp" | "control" | "common" | "content";
  couplingSource: "static" | "llm-inferred" | "hybrid";
  couplingConfidence: number;           // 0.0–1.0
}

interface ReadinessAssessment {
  gateMode: "hard-block" | "triage";
  globalScore: number;
  dynamicScore: number;
  compositeScore: number;
  globalWeight: number;                 // default 0.7
  checks: ReadinessCheck[];
  questionsGenerated: QuestionRef[];
  passedAt: string | null;
  falsePositiveHistory: number | null;
}

interface ReadinessCheck {
  rule: string;
  source: "global" | "dynamic";
  binding: "hard" | "advisory";
  passed: boolean;
  detail: string;
}
```

Also define: `InterfaceContract`, `ArtifactRef`, `Artifact`, `ExecutionRecord`, `ReasoningEntry`, `NodeMetrics`, `GraphMetrics`, `QuestionRef`, `GraphEvent` (for event stream). See the spec §3 for full field lists.

**2. `src/engine/GraphStore.ts`** — Read/write DecompositionGraph as JSON files.

```
runs/{runId}/
  result.json           # Existing RunResult
  graph.json            # DecompositionGraph
  nodes/{nodeId}.json   # Per-node detail
  events.jsonl          # Timestamped event stream
```

Methods: `saveGraph(graph)`, `loadGraph(runId)`, `saveNodeDetail(runId, nodeId, detail)`, `appendEvent(runId, event)`, `listGraphs()`.

**3. `src/engine/GraphBuilder.ts`** — Fluent API for constructing graphs programmatically.

```typescript
const graph = new GraphBuilder(taskPayload, "my-pipeline", "D0")
  .addNode({ id: "root", type: "goal", description: "..." })
  .addNode({ id: "leaf-1", type: "leaf", parentId: "root", ... })
  .addEdge({ from: "root", to: "leaf-1", type: "sequence", ... })
  .build();
```

**4. `.agent/schemas/graph.schema.json`** — JSON Schema for graph.json validation.

**5. Unit tests** — GraphStore round-trip (save/load), GraphBuilder produces valid graphs, schema validation passes.

**6. Example graph** — `tasks/examples/bugfix-decomposition.json` showing the data model applied to `bugfix-cross-file-diagnosis.json`.

### Definition of done
- `npm run typecheck` passes
- GraphStore saves and loads graphs from `runs/` directory
- GraphBuilder produces valid DecompositionGraph objects
- Example graph is valid per schema
- No changes to existing types or RunEngine

---

## Phase 1: Global Readiness Gate

### What to build

**1. `src/engine/ReadinessGate.ts`**

Evaluates a task or DecompositionNode against global readiness rules.

```typescript
export interface ReadinessGateConfig {
  gateMode: "hard-block" | "triage";    // default: "triage"
  readinessThreshold: number;            // default: 0.8
  globalWeight: number;                  // default: 0.7
}

export class ReadinessGate {
  constructor(config?: Partial<ReadinessGateConfig>);

  async assess(task: TaskPayload): Promise<ReadinessAssessment>;
  async assessNode(node: DecompositionNode): Promise<ReadinessAssessment>;
}
```

**Global rules (6 checks):**

| Rule | Check | Binding |
|------|-------|---------|
| `has_acceptance_criteria` | Task has ≥1 testable criterion (checks array non-empty, or description contains measurable outcomes) | hard |
| `has_scope_boundary` | Task specifies file paths, module, or section (files/seedDir present, or instructions reference specific files) | hard |
| `has_verification_command` | Task includes checks or explicit test command | hard |
| `dependencies_resolved` | All declared dependencies exist (check inputs/ArtifactRefs) | hard |
| `no_ambiguous_terms` | No unqualified "fast," "safe," "minimal," "better," "clean" without measurable criteria | **advisory** |
| `risk_classified` | Task has risk metadata or risk is inferable | hard |

**Implementation notes:**
- Rules 1–4 and 6 are deterministic (inspect TaskPayload/node fields directly)
- Rule 5 (ambiguity) uses a simple keyword scan + optional LLM call for borderline cases. It is advisory — it contributes to the score but does not block in triage mode.
- In `triage` mode: failed hard checks generate questions and flag for review, but don't hard-block unless compositeScore < readinessThreshold. In `hard-block` mode: any failed hard check blocks.
- Composite score: `(globalWeight * globalScore) + ((1 - globalWeight) * dynamicScore)`. dynamicScore is 1.0 when no dynamic gate is configured (Phase 1 has no dynamic gate yet).

**2. `src/engine/QuestionGenerator.ts`**

Produces structured questions from readiness failures, compatible with THE_FACTORY's `questions.jsonl` schema:

```typescript
interface GeneratedQuestion {
  id: string;                    // auto-generated
  task: string;                  // task identifier
  question: string;
  options: string[];
  default: string;
  impact: string;
  status: "pending";
  asked: string;                 // ISO 8601
}

export function generateQuestions(
  assessment: ReadinessAssessment,
  taskId: string
): GeneratedQuestion[];
```

Each failed check maps to a specific question template. See spec §4.1.1 for the question text per rule.

**3. Integration with RunEngine**

Add a pre-flight check path. Do NOT modify `RunEngine.startRun()` directly — instead, create a wrapper or new method:

```typescript
// In a new file or extension
export async function preflight(
  task: TaskPayload,
  gate: ReadinessGate,
): Promise<{ passed: boolean; assessment: ReadinessAssessment; questions: GeneratedQuestion[] }>;
```

The CLI or BatchRunner calls `preflight()` before `startRun()`. If readiness fails, it skips execution and returns the questions.

**4. Tests:**
- `bugfix-cross-file-diagnosis.json` should pass readiness (has checks, has files, has instructions)
- A deliberately vague task `{ description: "make it faster", instructions: "improve performance" }` should fail with specific questions
- `no_ambiguous_terms` failure should be advisory, not blocking in triage mode
- Question generation produces valid question objects

### Definition of done
- Well-specified tasks pass the gate
- Vague tasks fail with actionable questions
- Triage mode does not hard-block on advisory failures
- `npm run typecheck` passes
- No changes to existing RunEngine behavior

---

## Phase 2: Decomposition Engine (D0 + D4 + D5)

### What to build

**1. `src/engine/DecompositionEngine.ts`** — Core engine with pluggable strategy interface.

```typescript
export interface DecompositionStrategy {
  name: string;
  decompose(
    task: TaskPayload,
    context: DecompositionContext,
  ): Promise<DecompositionGraph>;
}

export interface DecompositionContext {
  llmCall: LlmCallFn;                   // For LLM-based decomposition
  readinessGate: ReadinessGate;
  config: DecompositionStrategyConfig;
}

export interface DecompositionStrategyConfig {
  decomposition_trigger: "preemptive" | "on-failure" | "hybrid";
  max_depth: number;                     // default: 3
  max_files_hint: number;                // soft hint, default: 3
  three_conditions: boolean;             // default: true
  compositionality_check: boolean;       // default: true
}

export class DecompositionEngine {
  constructor(strategies: Map<string, DecompositionStrategy>);

  async decompose(
    task: TaskPayload,
    strategyName: string,
    context: DecompositionContext,
  ): Promise<DecompositionGraph>;
}
```

**2. `src/engine/strategies/D0Strategy.ts`** — Direct execution (no decomposition).

Wraps the entire task as a single leaf node. Trivial — builds a 1-node graph using GraphBuilder.

**3. `src/engine/strategies/D4Strategy.ts`** — Interface-first decomposition.

- Analyzes the task for module boundaries using LLM-based dependency analysis
- If section contracts are available (ownedPaths in task metadata), uses them as cut boundaries
- Produces a graph with nodes per module/section, edges representing dependencies
- Runs hybrid coupling audit on all edges (see below)
- Enforces adaptive bounds: depth cap at 3, soft complexity hints
- Applies readiness gate to each generated node

**4. `src/engine/strategies/D5Strategy.ts`** — Adaptive/as-needed (ADaPT pattern).

- Wraps the task as a single leaf (like D0)
- On execution failure (called back by the RunEngine), decomposes the failed node's parent using D4 as the fallback strategy
- Injects failure evidence (error messages, failed checks) as additional context for the decomposition LLM call
- Re-assesses readiness on the new child nodes
- Depth naturally calibrates to task complexity

```typescript
export class D5Strategy implements DecompositionStrategy {
  constructor(private fallbackStrategy: DecompositionStrategy); // Usually D4

  async decompose(task, context): Promise<DecompositionGraph>;

  // Called by RunEngine when a leaf fails
  async redecompose(
    failedNode: DecompositionNode,
    failureEvidence: ExecutionRecord,
    graph: DecompositionGraph,
    context: DecompositionContext,
  ): Promise<DecompositionGraph>;
}
```

**5. `src/engine/ComplexityEstimator.ts`** — Fast-path triage.

```typescript
export interface ComplexityEstimate {
  level: "simple" | "moderate" | "complex";
  signals: {
    fileCount: number;
    sectionCrossings: number;
    estimatedScope: string;
    hasDependencies: boolean;
  };
}

export function estimateComplexity(task: TaskPayload): ComplexityEstimate;
```

Rules:
- **Simple:** single file mentioned (or no files + short instructions), no cross-references, no multi-step acceptance criteria
- **Complex:** 5+ files, multiple sections, multi-step acceptance criteria, dependencies between work items
- **Moderate:** everything else

Simple tasks skip decomposition entirely (D0 fast path). This is step 0 of the graph execution loop.

**6. `src/engine/CouplingAudit.ts`** — Hybrid coupling classification.

```typescript
export interface CouplingResult {
  couplingType: "data" | "stamp" | "control" | "common" | "content";
  couplingSource: "static" | "llm-inferred" | "hybrid";
  couplingConfidence: number;
  detail: string;
}

// Phase 1: static analysis (for TypeScript projects)
export function analyzeStaticCoupling(
  fromPaths: string[],
  toPaths: string[],
  projectFiles: Record<string, string>,
): CouplingResult;

// Phase 2: LLM semantic classification
export async function classifyCouplingSemantic(
  edge: DependencyEdge,
  nodeDescriptions: { from: string; to: string },
  llmCall: LlmCallFn,
): Promise<CouplingResult>;

// Combined
export async function auditCoupling(
  edge: DependencyEdge,
  context: { projectFiles?: Record<string, string>; llmCall: LlmCallFn; nodeDescriptions: { from: string; to: string } },
): Promise<CouplingResult>;
```

Static analysis: scan for imports, shared variables, function calls between file sets. Reliable for data and stamp coupling.

LLM classification: prompt the LLM to classify control/common/content coupling based on node descriptions and code context. Include confidence score. Flag edges with confidence < 0.7 for review.

**7. `src/engine/AdaptiveBounds.ts`** — Decomposition stop conditions.

```typescript
export interface BoundsConfig {
  max_depth: number;            // default: 3
  max_files_hint: number;       // soft, default: 3
  three_conditions: boolean;
  compositionality_check: boolean;
}

export function shouldStopDecomposing(
  node: DecompositionNode,
  depth: number,
  config: BoundsConfig,
): { stop: boolean; reason: string };
```

Stop conditions (any one triggers stop):
1. Complexity estimate is "simple"
2. Three Conditions violated (node can't be split into independent, mergeable pieces)
3. Decomposition cost exceeds benefit (estimated tokens for decomposition > estimated tokens for execution)
4. 100% acceptance criteria coverage achieved
5. Depth limit reached (default: 3)
6. Cynefin classification is Complex/Chaotic (if available)

**8. Strategy config in variant YAML**

Extend VariantConfig loading to parse decomposition strategy config:

```yaml
name: adaptive-d5
description: Adaptive decomposition with D4 fallback
agent: coder
decomposition_strategy:
  name: "D5"
  decomposition_trigger: "on-failure"
  fallback: "D4"
  max_depth: 3
  max_files_hint: 3
  three_conditions: true
```

**9. Tests:**
- D0 produces a 1-node graph for any task
- D4 produces a multi-node graph for `bugfix-cross-file-diagnosis.json` (which touches 2 files)
- D5 starts as a 1-node graph, can be redecomposed on simulated failure
- ComplexityEstimator classifies `example-simple.json` as simple and `feature-inventory-search.json` as moderate
- CouplingAudit produces static coupling results for TypeScript import patterns
- AdaptiveBounds stops at depth 3
- Variant YAML with `decomposition_strategy` loads correctly

### Definition of done
- All three strategies (D0, D4, D5) produce valid DecompositionGraph objects
- Complexity triage correctly routes simple tasks to D0
- Hybrid coupling audit produces results with confidence scores
- Adaptive bounds enforce depth cap of 3
- Strategy is selected via variant YAML config
- `npm run typecheck` passes
- No changes to existing types, RunEngine, or middleware

---

## Implementation Order

```
Phase 0 (types + storage)
  ↓
Phase 1 (readiness gate) ─── can run in parallel with ──→ Phase 2 (strategies)
```

Start with Phase 0 — it's the foundation everything else depends on. Then Phase 1 and Phase 2 can proceed in parallel (readiness gate and decomposition strategies are independent). But within this session, do them sequentially: Phase 0 → Phase 1 → Phase 2.

## File creation summary

New files to create:
```
src/types/graph.ts
src/engine/GraphStore.ts
src/engine/GraphBuilder.ts
src/engine/ReadinessGate.ts
src/engine/QuestionGenerator.ts
src/engine/DecompositionEngine.ts
src/engine/ComplexityEstimator.ts
src/engine/CouplingAudit.ts
src/engine/AdaptiveBounds.ts
src/engine/strategies/D0Strategy.ts
src/engine/strategies/D4Strategy.ts
src/engine/strategies/D5Strategy.ts
.agent/schemas/graph.schema.json
tasks/examples/bugfix-decomposition.json
```

Files to extend (not break):
```
src/engine/variants.ts  — add decomposition_strategy parsing
src/engine/index.ts     — re-export new modules
```

Files to NOT modify:
```
src/types/index.ts      — existing types are frozen
src/engine/RunEngine.ts — Phase 3 extends this, not Phase 2
src/middleware/*         — unchanged
src/sandbox/*           — unchanged
src/agents/*            — unchanged
```

## Verification

After each phase:
1. `npm run typecheck` — must pass
2. Run any unit tests you've written
3. Verify the example graph in `tasks/examples/` is valid per the JSON schema
4. Verify existing CLI still works: `npx crucible run --task tasks/example-simple.json --variant bare`
