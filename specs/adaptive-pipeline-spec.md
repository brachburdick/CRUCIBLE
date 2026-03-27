---
status: DRAFT
created: 2026-03-27
project: CRUCIBLE
revision_of: docs/benchmark-program.md
supersedes: none
superseded_by: none
research_inputs:
  - "deep-research-report Software Decomposition.md"
  - "deep-research-report Human Involvement.md"
  - "THE_FACTORY_claude_software_decomposition"
  - "THE_FACTORY_human_oversight"
  - "SYNTROPY.md"
  - "CLAUDE_CRUCIBLE_assessment_DR.md (2026-03 external critique vs. 2024–2026 literature)"
---

# Adaptive Pipeline Spec: Configurable Decomposition, Autonomous Execution, Comparative Observation

## 1. Problem Statement

THE_FACTORY currently operates as a manually-iterated pipeline: one operator, one agent session, continual approval clicks, handoff prompts between sessions. This works but doesn't scale to overnight autonomy or comparative experimentation.

CRUCIBLE Phase 1 proved sandboxed execution with kill switches. The benchmark program (Phase 2 draft) defined the D/V/T experimental matrix. But two capabilities are missing:

1. **The pipeline cannot decompose problems itself.** Tasks are pre-decomposed by the operator. The system has no way to take "build the Analysis Viewer" and break it into section-scoped work units, assess whether each unit is well-defined enough to attempt, and route incomplete units to a question queue.

2. **The pipeline cannot run unattended and produce comparative insights.** There is no mechanism to run multiple decomposition strategies against the same task in parallel, capture intermediate artifacts (not just final pass/fail), and present a human-readable comparison of HOW each strategy worked — not just WHETHER it worked.

### What Success Looks Like

The operator defines a batch of tasks and a set of pipeline configurations. The system:
- Pre-flights each task against readiness criteria
- Decomposes qualifying tasks using each configuration's strategy
- Executes all configurations in parallel with budget/TTL/loop kill switches
- Accumulates questions for tasks that fail readiness (rather than guessing)
- Produces a visual graph comparison showing how each configuration decomposed and executed the work
- Presents the operator with a question queue and a scored comparison in the morning

### Governing Constraint: THE_FACTORY ↔ CRUCIBLE Convergence

CRUCIBLE is not a separate tool. It is THE_FACTORY's experimental arm. The relationship is:

```
THE_FACTORY (manual pipeline, current patterns)
    ↓ extracts patterns into
CRUCIBLE (experimental harness)
    ↓ discovers which patterns work via
Benchmark Runs (comparative experiments)
    ↓ promotes winning configurations back to
THE_FACTORY (empirically-validated pipeline)
    ↓ which surfaces new questions for
CRUCIBLE (next experiment cycle)
```

This means CRUCIBLE should import THE_FACTORY's patterns directly (skill files, hook definitions, section contracts, question queue schema, run record schema) — not reimplement them. Findings from CRUCIBLE experiments are used to improve THE_FACTORY. Eventually, the best-performing pipeline configuration discovered by CRUCIBLE becomes THE_FACTORY's default operating mode, and the system runs experiments on itself to keep improving.

---

## 2. Architecture Overview

Four layers plus a shared data model:

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 0: Decomposition Graph (shared data model)           │
│  - Nodes, edges, artifacts, reasoning, metrics              │
│  - Written by Layers 1 & 2, read by Layer 3 and Node UI    │
└─────────────────────────────────────────────────────────────┘

┌──────────────────────┐  ┌───────────────────────────────────┐
│  Layer 1:            │  │  Layer 2:                         │
│  Task Readiness &    │──│  Pipeline Execution               │
│  Recursive           │  │  (extended RunEngine)             │
│  Decomposition       │  │                                   │
│                      │  │  Walks the graph, executes leaves │
│  Global gate +       │  │  per coordination protocol,       │
│  dynamic gate +      │  │  enforces verification gates,     │
│  SYNTROPY bounds     │  │  captures per-node artifacts      │
└──────────────────────┘  └───────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Layer 3: Comparative Observation                           │
│  - Per-variant run recording (graph + decisions + metrics)  │
│  - Cross-variant structural diffing                         │
│  - Node UI visualization (read-only → editable)            │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Layer 0: Decomposition Graph Data Model

The Decomposition Graph is the central artifact. Everything else produces or consumes it. It represents how a task was broken down, what happened at each node, and why.

### 3.1 Core Types

```typescript
interface DecompositionGraph {
  id: string;                          // Unique graph ID
  taskOrigin: TaskPayload;             // The original task (extended with benchmarkProvenance, see §7.5)
  pipelineDefinition: string;          // Which PipelineDefinition produced this graph
  strategyUsed: string;                // Decomposition strategy name
  createdAt: string;                   // ISO 8601
  updatedAt: string;                   // ISO 8601
  rootNodeId: string;                  // Entry point
  nodes: DecompositionNode[];
  edges: DependencyEdge[];
  status: "decomposing" | "executing" | "completed" | "failed" | "budget_exceeded";
  metrics: GraphMetrics;
}

interface DecompositionNode {
  id: string;
  parentId: string | null;            // null for root
  type: "goal" | "milestone" | "task" | "leaf";
  description: string;
  acceptanceCriteria: string[];
  ownedPaths: string[];               // From SYNTROPY section contracts
  inputs: ArtifactRef[];              // What this node needs
  outputs: ArtifactRef[];             // What this node produces
  status: "pending" | "ready" | "active" | "completed" | "failed" | "blocked" | "skipped";
  complexityEstimate: "simple" | "moderate" | "complex" | null;  // From triage step (§5.2.1)
  assignedTo: string | null;          // Agent/unit identifier

  // Readiness assessment (Layer 1)
  readiness: ReadinessAssessment;

  // Execution record (Layer 2)
  execution: ExecutionRecord | null;

  // Artifacts produced during execution
  artifacts: Artifact[];

  // Decision log: WHY the agent made choices
  reasoning: ReasoningEntry[];

  // Per-node metrics
  metrics: NodeMetrics;
}

interface DependencyEdge {
  from: string;                        // Node ID
  to: string;                          // Node ID
  type: "data" | "sequence" | "contract";
  contract: InterfaceContract | null;  // SYNTROPY-style typed boundary
  couplingType: "data" | "stamp" | "control" | "common" | "content";
  couplingSource: "static" | "llm-inferred" | "hybrid";
  couplingConfidence: number;          // 0.0–1.0; <0.7 flagged for operator review
}

interface InterfaceContract {
  inputTypes: TypeSpec[];
  outputTypes: TypeSpec[];
  invariants: string[];
  verifyCommand: string | null;
}
```

### 3.2 Readiness Assessment

Each node carries a readiness score computed by Layer 1's gates.

```typescript
interface ReadinessAssessment {
  gateMode: "hard-block" | "triage";   // Default: "triage"
  globalScore: number;                 // 0.0–1.0, from global rules
  dynamicScore: number;                // 0.0–1.0, from strategy-specific rules
  compositeScore: number;              // Weighted combination
  globalWeight: number;                // Tunable: default 0.7
  checks: ReadinessCheck[];
  questionsGenerated: QuestionRef[];   // Questions queued due to readiness failure
  passedAt: string | null;             // ISO 8601, null if not yet passed
  falsePositiveHistory: number | null; // Historical false-positive rate for calibration
}

interface ReadinessCheck {
  rule: string;                        // e.g., "has_acceptance_criteria"
  source: "global" | "dynamic";
  binding: "hard" | "advisory";        // Advisory checks inform but don't block
  passed: boolean;
  detail: string;                      // Why it passed or failed
}
```

### 3.3 Execution Record

Captures what happened when a node was executed.

```typescript
interface ExecutionRecord {
  startedAt: string;
  completedAt: string | null;
  exitReason: KillReason | { type: "escalated"; question: string } | { type: "redecomposed" };
  tokenUsage: { prompt: number; completion: number; total: number };
  wallTimeMs: number;
  mutations: number;                   // Edit/Write count
  testCycles: number;                  // edit-test loop count
  toolCalls: ToolCallSummary[];
  verificationResults: VerificationResult[];
}

interface ReasoningEntry {
  timestamp: string;
  phase: string;                       // e.g., "decomposition", "implementation", "verification"
  decision: string;                    // What was decided
  alternatives: string[];              // What was considered
  rationale: string;                   // Why this choice
  confidence: number;                  // 0.0–1.0 self-assessed
}
```

### 3.4 Storage

**Initial implementation:** JSON files per run.

```
runs/
  run-{id}/
    result.json              # Existing CRUCIBLE RunResult
    graph.json               # DecompositionGraph
    nodes/
      {node-id}.json         # Per-node detail (artifacts, reasoning)
    events.jsonl             # Timestamped event stream for replay
```

**Migration trigger:** When cross-run queries (e.g., "show all failed nodes across all F2 variants") become frequent or slow. At that point, add SQLite tables mirroring the JSON schema. CRUCIBLE's existing SQLite server layer handles this.

### 3.5 Compositionality Test

From SYNTROPY (via Fong & Spivak's category theory): a node B depends only on A's **output**, not on HOW A was produced. This is enforced structurally — DependencyEdges reference ArtifactRefs, not node internals.

---

## 4. Layer 1: Task Readiness & Recursive Decomposition

### 4.1 Dual-Gate Readiness System

Two readiness sub-systems with a tunable balance:

**4.1.1 Global Readiness Gate (fixed rules, always applied)**

Derived from SYNTROPY Principle 8 ("handle ambiguity before decomposing"), the oversight matrix, and the human-oversight research ("pre-flight context sufficiency > runtime ambiguity detection"):

**Gate mode:** Configurable via `gateMode: "hard-block" | "triage"`. Default: `"triage"`. In triage mode, failed checks flag issues for operator review rather than hard-blocking execution. This reflects the finding that LLM-based requirement screening achieves high recall but low precision — the gate catches real problems, but also flags well-specified tasks (Lubos et al. 2024, ISO 29148 evaluation). Triage mode preserves the gate's filtering value without creating a bottleneck.

| Rule | Check | Failure Action | Binding |
|------|-------|----------------|---------|
| `has_acceptance_criteria` | Task defines at least one testable criterion | Queue question: "What does success look like?" | Hard |
| `has_scope_boundary` | Task specifies file paths, module, or section contract | Queue question: "What parts of the codebase does this touch?" | Hard |
| `has_verification_command` | Task includes a test command or check spec | Queue question: "How do we verify this works?" | Hard |
| `dependencies_resolved` | All declared dependencies exist or are completed | Block until dependency completes | Hard |
| `no_ambiguous_terms` | Task description doesn't contain unqualified "fast," "safe," "minimal," etc. | Queue question with options (from human-oversight research clarification templates) | **Advisory** |
| `risk_classified` | Task has explicit or inferred risk level | Infer from THE_FACTORY risk-classifier patterns | Hard |

> **Research note — ambiguity detection reliability.** `no_ambiguous_terms` is advisory, not binding. Zhang et al. (2024) showed LLMs detect natural language ambiguity only slightly above chance. Ensemble approaches with conformal prediction reach ~82.5% accuracy on domain-specific ambiguity, but general-purpose ambiguity detection remains weak. Liu et al. (2023, EMNLP) established that LLMs default to preferred semantic readings rather than identifying ambiguity. Treat this check as one signal among several, with the question queue as the downstream safety net.

**Calibration.** Track historical false-positive rate (tasks flagged by the gate but ultimately well-specified after operator review). Use this to tune `readinessThreshold` and individual check weights over time. A combined workflow where operators review LLM assessments produces stronger agreement than either working alone (Lubos et al. 2024).

**4.1.2 Dynamic Readiness Gate (strategy-dependent)**

Each decomposition strategy can add additional readiness checks. Examples:

- **Domain-scoped strategy:** "All affected section contracts exist and are current"
- **Interface-first strategy:** "Module boundaries and dependency graph are documented"
- **HTN strategy:** "Goal hierarchy can be stated in ≤3 levels"
- **Single-agent strategy:** "Total estimated scope fits in one context window"

**4.1.3 Composite Score**

```
compositeScore = (globalWeight × globalScore) + ((1 - globalWeight) × dynamicScore)
```

Default `globalWeight = 0.7`. Tunable per experiment. Setting `globalWeight = 1.0` disables dynamic checks; setting `globalWeight = 0.0` disables global checks.

A node passes readiness when `compositeScore >= readinessThreshold` (default 0.8).

Nodes that fail readiness generate questions via THE_FACTORY's `questions.jsonl` schema and are marked `blocked`. The pipeline moves to the next ready node.

### 4.2 Recursive Decomposition Engine

The decomposition engine takes a task + a DecompositionStrategy config and produces a DecompositionGraph.

#### 4.2.1 DecompositionStrategy Config

```yaml
# This is a VARIANT PARAMETER, not a fixed architecture.
# Different variants define different strategies.

decomposition_strategy:
  name: "domain-sections"
  method: "section-contract-aware"

  # How to identify cut boundaries
  boundary_detection: "section-contracts"    # or "dependency-analysis", "goal-tree", "htn"

  # Decomposition trigger: when to decompose
  decomposition_trigger: "hybrid"            # "preemptive" | "on-failure" | "hybrid"
  # preemptive: decompose upfront based on complexity estimate
  # on-failure: attempt execution first, decompose only on failure (ADaPT pattern)
  # hybrid: use complexity estimate to choose — simple tasks attempt first, complex decompose upfront

  # SYNTROPY leaf criteria (soft hints for complexity estimator, NOT hard stop conditions)
  # Research: no published evidence validates specific thresholds (ADaPT NAACL 2024, ACONIC 2025).
  # Agentless (FSE 2025) achieves 50.8% on SWE-bench Verified without decomposition at $0.34–$0.70/issue.
  # Devin's recommended sweet spot is tasks "that would take a junior engineer 4–8 hours."
  leaf_criteria:
    max_files_hint: 3                        # Soft hint — exceeding triggers complexity estimate, not hard block
    max_estimated_scope: "moderate"           # "simple" | "moderate" | "complex" (based on file count, coupling density, section crossings)
    three_conditions: true                   # Enforce decomposable, independent, mergeable

  # SYNTROPY compositionality check
  compositionality_check: true               # Nodes depend on outputs, not internals

  # When to escalate instead of decompose further
  escalation_triggers:
    - "task_crosses_section_boundaries_without_contracts"
    - "acceptance_criteria_contain_ambiguous_terms"
    - "no_existing_tests_cover_affected_paths"
    - "cynefin_classification_is_complex_or_chaotic"    # Probe before decomposing

  # Strategy-specific readiness additions
  additional_readiness_checks:
    - "affected_section_contracts_exist"
    - "coupling_map_shows_parallelizability"
```

#### 4.2.2 Decomposition Strategies as Experimental Variables

The following strategies are known from research. Each is expressible as a DecompositionStrategy config:

| Strategy | Cut Axis | When It Excels | When It Fails |
|----------|----------|----------------|---------------|
| **Direct** (D0) | No decomposition | Leaf-scale tasks (<5 files, <30 min) | Anything requiring coordination |
| **Fixed Ladder** (D1) | By phase (plan→build→test) | Predictable, well-understood tasks | Novel or cross-cutting work |
| **Goal Tree** (D2) | By objectives and constraints | Requirements-heavy features | Implementation-heavy refactors |
| **HTN** (D3) | Recursive until solvable | Complex, multi-step features | Over-atomizes simple tasks |
| **Interface-First** (D4) | By module boundaries and coupling | Systems with clear architecture | Greenfield with no existing structure |
| **Adaptive/As-Needed** (D5) | On-failure recursive (ADaPT pattern) | Tasks with uncertain complexity; mixed simple/complex batches | Tasks known to be complex upfront (wastes a failed attempt) |
| **Domain-Scoped** (new) | By SYNTROPY sections | Projects with section contracts | New projects without sections |
| **Temporal/Single-Agent** (new) | By phase with context switching | Medium tasks, tight context | Large tasks exceeding context window |
| **Hybrid** (new) | Domain for implementation, cross-cutting for review | Complex projects with clear sections | Simple tasks (overhead not justified) |

**D5 Adaptive behavior:** Attempt leaf execution first. If the leaf fails, decompose its parent node using the configured fallback strategy (default: D4 interface-first), injecting the failure evidence as additional context. Child nodes are then attempted normally. This naturally calibrates decomposition depth to actual task complexity rather than estimated complexity. ADaPT (NAACL 2024) demonstrated this pattern achieves +28% success in ALFWorld and +33% in TextCraft versus predetermined decomposition.

New strategies can be added by writing a YAML config. The engine doesn't hardcode any strategy — it executes whatever the config declares.

#### 4.2.3 Adaptive Decomposition with SYNTROPY Principles

> **Design rationale.** Fixed decomposition thresholds (e.g., 1 file / <15 LOC / <30 min) are the spec's most questionable original choice. No published research validates specific thresholds. ADaPT (NAACL 2024) showed +28% success in ALFWorld and +33% in TextCraft by decomposing only on failure. ACONIC (2025) improved accuracy 10–40 pp on constraint-heavy tasks by using formal complexity measures. A CMU thesis (2025) found 3 levels of depth sufficient. The engine now uses adaptive granularity — decomposition depth naturally aligns with task complexity.

The engine decomposes adaptively based on `decomposition_trigger`:

**When `decomposition_trigger = "on-failure"` (ADaPT pattern):**
1. Attempt execution of the node as-is
2. On failure, decompose the node using the configured strategy
3. Re-attempt child nodes with failure evidence as additional context
4. Depth naturally calibrates to task complexity

**When `decomposition_trigger = "preemptive"` (traditional):**
Decompose upfront based on complexity estimate before execution.

**When `decomposition_trigger = "hybrid"` (default):**
Run a lightweight complexity estimator first. Simple tasks use on-failure mode; complex tasks decompose preemptively.

In all modes, decomposition stops when ANY of these conditions hold:

1. **Complexity estimate is "simple"** — node scope fits comfortably within executor capability
2. **Three Conditions violated** — the sub-problem cannot be split into independent, mergeable pieces (Cormen et al.)
3. **Decomposition cost exceeds benefit** — generating the decomposition consumes more tokens than executing the node directly would
4. **100% coverage achieved** — every acceptance criterion and file is claimed by exactly one leaf (WBS 100% rule)
5. **Depth limit reached** — configurable per strategy (default: **3 levels**, per CMU 2025 finding). Prevents exponential explosion.
6. **Cynefin classification is Complex/Chaotic** — requires probing, not decomposing (SYNTROPY Principle 8)

When a leaf fails during execution, SYNTROPY Principle 3 applies: **replan from goals with failure evidence, don't retry the same broken plan.** The engine re-decomposes the failed node's parent with the failure as additional context.

#### 4.2.4 Coupling Audit (Hybrid: Static Analysis + LLM Semantics)

> **Research note.** No published research evaluates LLMs on formal coupling-type classification from the classic software engineering taxonomy. This is an open research gap. LoCoBench (2025) confirmed coupling impacts LLM performance but evaluated models *working within* coupled code, not *classifying* coupling types. DepsRAG (2024) showed GPT-4-Turbo handles coarse-grained module-to-module dependency queries. Relying purely on LLM assessment risks hallucinated dependencies that corrupt the task graph.

**Two-phase coupling audit:**

1. **Phase 1 — Mechanical detection (static analysis).** Use AST/import analysis (e.g., TypeScript compiler API) to identify call graphs, shared state, and import dependencies. This produces the edge structure and data/stamp coupling with high reliability. The `couplingSource` is `"static"`.

2. **Phase 2 — Semantic classification (LLM).** The LLM classifies *what kind* of coupling exists and *whether it matters* for the decomposition — especially for control, common, and content coupling that require understanding intent, not just structure. The `couplingSource` is `"llm-inferred"`. Edges with `couplingConfidence < 0.7` are flagged for operator review.

Every DependencyEdge gets a coupling-type classification:

| Type | Risk | Action | Typical Source |
|------|------|--------|----------------|
| Data coupling (simple params) | Low | Proceed | Static |
| Stamp coupling (shared composites) | Medium | Warn: trim to needed fields | Static |
| Control coupling (behavior flags) | High | Restructure before executing | LLM-inferred |
| Common coupling (shared state) | High | Restructure or serialize execution | Hybrid |
| Content coupling (direct internal access) | Critical | Block: violates compositionality | Hybrid |

---

## 5. Layer 2: Pipeline Execution

### 5.1 Pipeline Definition

The Pipeline Definition is the **primary experimental variable**. It is NOT a fixed architecture — it's what varies between CRUCIBLE benchmark runs.

```typescript
interface PipelineDefinition {
  name: string;
  description: string;

  // How the problem space is cut (Layer 1 config)
  decompositionStrategy: DecompositionStrategy;

  // How execution units coordinate
  coordinationProtocol: CoordinationProtocol;

  // When to ask vs. proceed
  autonomyProfile: AutonomyProfile;

  // What each execution unit sees
  contextStrategy: ContextStrategy;

  // What checks run between stages
  verificationGates: VerificationGate[];

  // Budget and safety limits
  budget: BudgetConfig;

  // Metadata for experiment tracking
  metadata: Record<string, unknown>;
}
```

#### 5.1.1 Coordination Protocol

Defines how execution units talk to each other. Maps to CRUCIBLE's T0–T2 but extends beyond:

```typescript
type CoordinationProtocol =
  | { type: "single-agent"; contextSwitching: ContextPhase[] }
  | { type: "pipeline"; stages: string[] }                       // T1
  | { type: "graph"; scheduler: "ready-leaf" | "priority" }      // T2
  | { type: "domain-teams"; units: DomainUnit[]; integrationAgent: boolean }
  | { type: "contract-net"; bidMetric: string }                  // From MAS research
  | { type: "blackboard"; artifactSpace: string };               // Shared artifact store

interface DomainUnit {
  name: string;
  scope: string[];           // Section contracts or path globs
  roles: string[];           // What this unit does (plan, implement, verify)
}

interface ContextPhase {
  name: string;
  contextLoad: string[];     // What to load for this phase
  exitGate: string;          // What must be true to advance
}
```

#### 5.1.2 Autonomy Profile

Controls when the system asks vs. proceeds. Derived from the human-oversight research (L1–L5 scale, breakeven analysis, ≤5 meaningful interruptions/day):

```typescript
interface AutonomyProfile {
  // Confidence threshold below which the system escalates
  // Low-risk: 0.3, Medium-risk: 0.8, High-risk: 0.95
  escalationThreshold: number | { low: number; medium: number; high: number };

  // Max steps between human-visible checkpoints
  maxStepsBetweenCheckpoints: number;      // Research suggests 3–7

  // What happens when threshold is exceeded
  escalationBehavior: "block" | "queue-and-continue";

  // Max questions per batch (≤5 meaningful interrupts/day)
  maxQuestionsPerBatch: number;

  // Pre-flight strictness (how many readiness checks must pass)
  preflightStrictness: "lenient" | "standard" | "strict";
}
```

#### 5.1.3 Context Strategy

What each execution unit sees. This is a high-leverage variable — same agents with different context produce very different results.

```typescript
type ContextStrategy =
  | { type: "full-dump" }                                        // C0: everything
  | { type: "scoped"; scopeRule: "owned-files-only" }           // C1: section-scoped
  | { type: "just-in-time"; retrieval: "on-demand" }            // C2: load as needed
  | { type: "hierarchical"; levels: ContextLevel[] };            // C3: layered

interface ContextLevel {
  name: string;              // e.g., "architecture-overview", "module-interfaces", "implementation"
  content: string[];         // What's included at this level
  loadCondition: string;     // When to load this level
}
```

#### 5.1.4 Verification Gates

What checks run between stages. Maps to CRUCIBLE's V0–V2:

```typescript
interface VerificationGate {
  name: string;
  trigger: "after-each-leaf" | "after-milestone" | "after-integration" | "before-promotion";
  checks: CheckSpec[];                    // Existing CRUCIBLE CheckSpec
  verifierType: "self" | "independent" | "paired-v-model";
  failurePolicy: {
    retryBudget: number;                  // Max retries before escalation
    escalateTo: string;                   // "operator" | "reviewer-agent" | "redecompose"
    replanFromGoals: boolean;             // SYNTROPY Principle 3
  };
}
```

### 5.2 Extended RunEngine

CRUCIBLE's RunEngine currently executes a single agent against a single task. The extension walks a DecompositionGraph.

#### 5.2.1 Graph Execution Loop

> **Fast-path escape.** Agentless (FSE 2025) achieves competitive or superior results at 10× lower cost for simple tasks without any decomposition. Graph walking only pays above a complexity threshold. The execution loop starts with complexity triage to avoid unnecessary decomposition overhead.

```
0. COMPLEXITY TRIAGE: Run lightweight complexity estimator (file count, section crossings, coupling density).
   - If complexityEstimate = "simple" (single-file, single-section, localized change):
     skip to step 4 with the root node as the only leaf (D0 direct execution).
   - If complexityEstimate = "moderate" or "complex": proceed to step 1.
   - The complexity threshold is itself an experimental variable — discovering the optimal
     threshold is one of the most valuable early findings the convergence loop can produce.
1. Layer 1 produces a DecompositionGraph from the task + decomposition strategy
2. Engine identifies ready leaves (all dependencies met, readiness passed)
3. Per coordination protocol:
   - single-agent: execute leaves sequentially with context switching
   - pipeline: pass through planner → executor → verifier stages
   - graph: execute independent leaves in parallel
   - domain-teams: assign leaves to domain-scoped units
4. For each leaf execution:
   a. Load context per context strategy
   b. Execute agent (existing CRUCIBLE agent loop with middleware)
   c. Capture artifacts, reasoning, metrics → write to node
   d. Run verification gate
   e. If passed: mark completed, unlock dependent nodes
   f. If failed: apply failure policy (retry, redecompose, escalate)
5. After all leaves complete (or budget exhausted):
   a. Run integration verification gates
   b. Assemble final result
   c. Write complete graph to storage
```

#### 5.2.2 Kill Switches (inherited from CRUCIBLE Phase 1)

All existing kill switches apply at the graph level AND the node level:

| Kill Switch | Node Level | Graph Level |
|-------------|-----------|-------------|
| Token budget | Per-node budget (fraction of total) | Total budget across all nodes |
| TTL | Per-node timeout | Total wall-time limit |
| Loop detection | Per-node semantic loop check | Cross-node repeated failure pattern |
| Mutation budget | Per-node (THE_FACTORY's 2-cap + 10 compound) | Total mutations across graph |

**New kill switch: Decomposition depth limit.** If recursive decomposition exceeds the configured depth, stop and escalate rather than atomizing further.

### 5.3 Mapping to Existing CRUCIBLE Benchmark Matrix

The existing B0–B6 variants are expressible as PipelineDefinitions:

| Variant | decompositionStrategy | coordinationProtocol | verificationGates | contextStrategy |
|---------|----------------------|---------------------|-------------------|-----------------|
| B0 | D0 (direct) | single-agent | V0 (self-check) | full-dump |
| B1 | D1 (fixed ladder) | pipeline | V1 (independent) | scoped |
| B2 | D2 (goal tree) | pipeline | V1 (independent) | scoped |
| B3 | D3 (HTN) | pipeline | V1 (independent) | scoped |
| B4 | D4 (interface-first) | pipeline | V1 (independent) | scoped |
| B5 | D3 (HTN) | graph | V2 (paired v-model) | hierarchical |
| B6 | D4 (interface-first) | graph | V2 (paired v-model) | hierarchical |

Plus new variants not in the original matrix:

| Variant | Description |
|---------|-------------|
| B7 | Domain-scoped teams with section contracts + independent verification |
| B8 | Single agent with temporal context switching + self-check |
| B9 | HTN decomposition + contract-net task allocation + paired verification |
| B10 | Interface-first + domain teams + hierarchical context |
| B11 | D5 (adaptive/as-needed) + graph coordination + independent verification |

### 5.4 Sandbox Isolation Policy

> **Research context.** E2B's fundamental model is per-session isolated sandboxes (Firecracker microVM, same technology as AWS Lambda). LangChain's authoritative taxonomy (February 2026, with input from E2B, Runloop, and Witan Labs) identifies "Sandbox as Tool" as superior for parallel execution. The security concern with shared sandboxes is explicit: if sandboxes share state, a context-injection attack in one agent's execution can compromise another's. For overnight benchmarking, AI21's architecture for 200K SWE-bench evaluations provides the model: multi-tenant shared repository state with per-run isolated deltas, running ~500 Kubernetes pods.

**Rules:**

1. **Default: per-node isolated sandboxes.** Each leaf node execution gets a fresh E2B sandbox instance. No shared filesystem between concurrent nodes.

2. **Shared state via read-only base images.** Common repository state is provided as a read-only base image. Each node gets a writable overlay for its mutations. This balances resource efficiency with isolation (AI21 pattern).

3. **LLM calls host-side only.** Reinforced from MVP spec TR-2. The sandbox is purely an execution environment. API keys never enter the sandbox.

4. **Cross-node artifact passing via ArtifactRef.** Nodes exchange data through the graph model's `ArtifactRef` system, not shared filesystem. This enforces the compositionality invariant (§3.5) — a node depends on another's output, not its internal state.

5. **Per-node resource limits.** Each sandbox has independent token budget, TTL, and mutation budget (inherited from §5.2.2 kill switches). A runaway node cannot starve siblings.

---

## 6. Layer 3: Comparative Observation

### 6.1 Per-Variant Run Recording

Every run produces:

1. **RunResult** (existing CRUCIBLE output) — exit reason, tokens, wall time, artifacts
2. **DecompositionGraph** (new) — complete graph with per-node artifacts, reasoning, metrics
3. **Decision Log** — every point where the agent chose between options
4. **Escalation Log** — every question queued, every ambiguity detected
5. **Rework Log** — every node that was re-decomposed or re-executed
6. **Event Stream** — timestamped JSONL for replay

The run record schema extends THE_FACTORY's existing `run.schema.json` with:

```json
{
  "graph_ref": "runs/{runId}/graph.json",
  "decomposition_metrics": {
    "total_nodes": 12,
    "leaf_count": 8,
    "max_depth": 3,
    "l1_pass_rate": 0.875,
    "leaf_first_pass_rate": 0.75,
    "replan_count": 1,
    "cross_leaf_collision_rate": 0.0,
    "interface_break_rate": 0.0,
    "avg_dependency_fan_in": 1.2,
    "avg_dependency_fan_out": 0.8
  },
  "readiness_metrics": {
    "questions_generated": 2,
    "global_gate_pass_rate": 0.9,
    "dynamic_gate_pass_rate": 0.8,
    "tasks_blocked_by_readiness": 1
  },
  "autonomy_metrics": {
    "escalations": 1,
    "questions_queued": 2,
    "checkpoints_hit": 3,
    "max_consecutive_autonomous_steps": 5
  }
}
```

### 6.2 Cross-Variant Structural Comparison

When multiple variants run against the same task, the comparator produces:

#### 6.2.1 Structural Diff

How did each variant cut the problem?

- **Node count and depth** — Did variant A produce 4 deep nodes while B produced 12 shallow ones?
- **Boundary alignment** — Did the cut boundaries align with section contracts?
- **Coupling profile** — What coupling types appeared at edges?
- **Parallelizability** — How many nodes could run concurrently?

#### 6.2.2 Execution Diff

How did each variant execute the same (or analogous) work?

- **Token efficiency per node** — Which strategy spent tokens on the right things?
- **Rework rate** — Which strategy had fewer failed-then-redecomposed nodes?
- **Escalation rate** — Which strategy asked fewer questions?
- **Time-to-first-completion** — Which strategy produced working code fastest?

#### 6.2.3 Quality Diff

What was the quality of the output?

- **Visible check pass rate** — Did the output meet stated criteria?
- **Hidden check pass rate** — Did the output avoid unintended regressions?
- **Artifact completeness** — Were all expected artifacts produced?
- **Escaped defect rate** — What did verification miss?

#### 6.2.4 Emergent Pattern Detection

The comparator should flag:

- **Convergent strategies** — Different decomposition approaches that produced structurally similar graphs (suggests the problem has a natural cut)
- **Divergent outcomes from similar structures** — Same-shaped graphs with different pass rates (suggests execution quality matters more than decomposition for this task type)
- **Common failure nodes** — Nodes that failed across ALL variants (suggests the task itself is underspecified, not the strategy)
- **Strategy-task affinity** — Patterns where certain strategies consistently outperform on certain task families

### 6.3 Scoring and Winner Policy

Extends the existing benchmark program's winner policy:

#### Hard Gates (must pass before ranking)

- Hidden acceptance pass rate not worse than incumbent
- Catastrophic failure rate (budget_exceeded + loop_detected) below threshold
- Escaped defects do not increase
- Human touches (questions + escalations) do not materially worsen

#### Ranking Order

1. Hidden acceptance pass rate
2. Leaf first-pass solve rate (decomposition quality signal)
3. Visible acceptance pass rate
4. Escaped defects (lower is better)
5. Human touches total (lower is better — automation effectiveness)
6. Token cost (lower is better)
7. Wall time (lower is better)

Tie-breakers: pairwise judge preference, then lower cost.

### 6.4 Node UI Visualization

#### 6.4.1 Data Model → Visual Mapping

| Graph Element | Visual Representation |
|---------------|----------------------|
| DecompositionNode | Rectangle with status color (green/red/yellow/gray) |
| DependencyEdge | Arrow with coupling-type color coding |
| Artifacts | Expandable panel on node click |
| Reasoning | Tooltip or side panel on node hover |
| Metrics | Badge on node (tokens, time, mutations) |
| Readiness score | Fill bar inside node |

#### 6.4.2 Views

1. **Single Run View** — One graph, full detail. Click nodes to see artifacts, reasoning, execution record.
2. **Side-by-Side Comparison** — Two variants' graphs for the same task. Highlight structural differences.
3. **Overlay View** — Multiple variants' graphs overlaid with transparency. Shows convergent/divergent cuts.
4. **Timeline View** — Graph execution over time. Shows which nodes were active when, parallelism, bottlenecks.

#### 6.4.3 Implementation Path

- **Phase A (read-only):** Render DecompositionGraph JSON as a node layout using a React graph library (e.g., ReactFlow, which supports custom nodes, edges, and interactive panels). CRUCIBLE's existing React + Tailwind + WebSocket stack is the foundation.
- **Phase B (interactive):** Add click-to-inspect (artifacts, reasoning, metrics per node). Add filtering (show only failed nodes, show only cross-section edges).
- **Phase C (editable):** Human can restructure the decomposition — drag nodes, split/merge, adjust boundaries. Pipeline re-executes from the edited point. This is the Max/TouchDesigner-style patching interface.

#### 6.4.4 Pipeline Configuration Visualization

In addition to task decomposition graphs, the node UI should render the PipelineDefinition itself as a visual graph:

- **Stages/phases** as nodes
- **Data flow** as edges
- **Verification gates** as gate symbols on edges
- **Kill switches** as threshold indicators

This gives the operator a visual representation of the pipeline configuration that produced each run — making it possible to visually compare not just results, but the pipeline architectures that generated them.

---

## 7. Task Design: Multi-Scale Benchmarks

### 7.1 Existing Scale (Leaf Tasks)

Current CRUCIBLE tasks (1–5 min, 2–4 files) discriminate between methodology variants. They remain valuable for testing V0/V1/V2 verification formulas and basic pipeline overhead.

Keep: `example-coding.json`, `bugfix-cross-file-diagnosis.json`, `feature-inventory-search.json`, `refactor-extract-validator.json`.

Discrimination target: methodology quality (read-first vs. not, verify vs. not).

### 7.2 Scale 2: Multi-Section Tasks (10–15 min, 5–10 files, 2–3 sections)

These are big enough that decomposition strategy matters. Extract from real project work.

| Task | Family | Sections Crossed | What It Tests |
|------|--------|-----------------|---------------|
| "Add detector type consuming TrackAnalysis, exposed via server" | F2 | analysis → detectors → server | Interface contract awareness, cross-section coordination |
| "Extract shared validation logic from 3 modules into common" | F4 | Multiple → common | Dependency analysis, blast radius management |
| "Add WebSocket event for new bridge state, consumed by UI" | F5 | bridge → server → UI | Full vertical slice, protocol contract |

Discrimination target: decomposition quality (where cuts are placed, interface handling).

### 7.3 Scale 3: Feature Tasks (30–60 min, vertical slice)

These are overnight tasks. Too large for current CRUCIBLE runs but the target for the adaptive pipeline.

| Task | Family | Scope | What It Tests |
|------|--------|-------|---------------|
| "Build waveform rendering for Analysis Viewer" | F6 | Full feature with architecture decisions | Decomposition depth, autonomy management, question quality |
| "Implement live deck monitor with real-time bridge state" | F6 | Feature requiring hardware abstraction | Domain knowledge integration, ambiguity detection |

Discrimination target: end-to-end pipeline effectiveness (decomposition + execution + verification + autonomy).

### 7.4 Discrimination Criteria

A task is useful for benchmarking decomposition strategies when:

1. **Multiple valid decompositions exist** — there's more than one reasonable way to cut it
2. **Decomposition quality affects outcome** — bad cuts lead to integration failures or rework
3. **The task is in the zone of difficulty** — neither so easy that all strategies succeed nor so hard that all fail
4. **Hidden checks test integration** — not just leaf correctness, but whether the pieces fit together

Tasks with discrimination score < 0.3 across 3+ trials should be retired and replaced.

### 7.5 Benchmark Integrity

> **Research context.** SWE-bench is now considered contaminated. OpenAI announced in 2026 it no longer evaluates on SWE-bench Verified due to training data contamination across all frontier models. The "SWE-bench Illusion" paper (arXiv:2506.12286) found models achieve 76% accuracy identifying buggy file paths from issue descriptions alone. SWE-MERA analysis showed ~32% of "successful" patches involve direct solution leakage and ~31% pass due to inadequate test coverage. CRUCIBLE's internal benchmark suite must resist these failure modes.

**Requirements:**

1. **Proprietary tasks.** Benchmark tasks must come from real internal work on private codebases that have never been published. Following SWE-bench Pro's model. Each task payload carries a `benchmarkProvenance: "proprietary" | "public-modified" | "synthetic"` field. Only `"proprietary"` tasks are eligible for convergence-loop promotion decisions.

2. **Test suite quality gate.** Hidden acceptance tests must have measured branch coverage. Tasks where the hidden test suite achieves <80% branch coverage of the changed code are flagged as weak discriminators and excluded from scoring. Over 15% of SWE-bench instances required test augmentation due to incomplete coverage.

3. **Statistical significance.** All comparative metrics must include confidence intervals. Pipeline variants must differ by >2σ to count as meaningfully different. BetterBench (arXiv:2411.12990) found "large quality differences" across 46 benchmarks and recommended statistical significance reporting as a baseline requirement.

4. **Rolling refresh.** Benchmark tasks should be retired and replaced on a rolling basis (following SWE-bench Live's model) to prevent optimization against a static set. Target: replace ≥20% of benchmark tasks per quarter.

5. **MAST failure annotation.** Integrate the MAST taxonomy (Cemri et al., UC Berkeley, NeurIPS 2025) for failure analysis. MAST identifies 14 failure modes across 3 categories — specification/system design issues (41.8%), inter-agent misalignment (36.9%), and task verification/termination failures (21.3%). Track *why* configurations fail, not just whether they pass.

---

## 8. Convergence Protocol: CRUCIBLE → THE_FACTORY

### 8.1 Promotion Criteria

A pipeline configuration discovered by CRUCIBLE is promoted to THE_FACTORY's default when:

0. **It passes the held-out validation set** with no regression vs. incumbent (see §8.4 — this is the highest-priority gate)
1. It passes all hard gates across F1–F6 task families
2. It ranks #1 or #2 on the primary ranking for ≥3 consecutive experiment batches
3. It improves on ≥3 of the 7 ranking metrics without regressing on any hard gate
4. Its `human_touches.total` is lower than the current THE_FACTORY baseline
5. The operator reviews and approves the promotion, including a mandatory review of *how the configuration fails* (MAST-annotated failure modes), not just its aggregate score

### 8.2 What Gets Promoted

- **Decomposition strategy** → becomes THE_FACTORY's default task decomposition approach
- **Verification gates** → becomes THE_FACTORY's default hook/gate configuration
- **Autonomy profile** → becomes THE_FACTORY's oversight matrix settings
- **Context strategy** → becomes THE_FACTORY's skill loading and context management patterns

### 8.3 Feedback Loop

Promoted configurations are tracked. If a promoted config underperforms in real THE_FACTORY usage (measured by run records), it triggers a new CRUCIBLE experiment cycle comparing the current default against challengers.

### 8.4 Convergence Safeguards (Anti-Goodhart Mechanisms)

> **Research context — this is CRUCIBLE's greatest risk.** Skalse et al. (2022) proved that a proxy reward function is "unhackable" if and only if one of the reward functions is constant — meaning any non-trivial benchmark will eventually be gamed given sufficient optimization pressure. OpenAI's empirical measurement showed that optimizing a proxy reward initially improves both proxy and true objectives, then true performance degrades while the proxy continues improving. Denison et al. (2024) showed training on easier gameable environments *amplifies* specification gaming on harder ones. Bondarenko et al. (2025) demonstrated that reasoning models hack benchmarks by default. Princeton researchers found 40% success rate drops when SWE-bench agents were tested on different repository distributions.

CRUCIBLE's convergence loop creates sustained optimization pressure against its benchmark suite, placing it squarely in Goodhart territory. The following safeguards must operate simultaneously:

1. **Held-out validation set.** A set of tasks the convergence loop never sees — used only for human-triggered validation before promotion. Tasks in this set are never used for overnight runs, never included in scoring, and never visible to the optimization process. This is the most critical safeguard. Refresh held-out tasks on a different cadence than the main benchmark set.

2. **Multi-metric promotion.** No single score determines promotion. A configuration must improve on ≥3 of the 7 ranking metrics (§6.3) without regressing on any hard gate. Gaming one metric is easy; simultaneously gaming five orthogonal metrics is much harder.

3. **Canary/sentinel tasks.** Tasks designed to detect gaming behavior — where the "obvious" shortcut produces wrong answers. Example: a task where the acceptance test passes with a naive regex, but the hidden test catches edge cases the regex misses. If a configuration's canary pass rate drops while its main score rises, halt the loop.

4. **Mandatory failure-mode review.** Promotion requires operator review of the winning configuration's failure modes using MAST taxonomy annotation (§7.5). The operator must understand *how it fails*, not just that it succeeds more often.

5. **Distribution diversity.** Benchmark batches must include tasks from ≥3 different task families and ≥2 different codebases. A configuration that wins on one codebase may systematically fail on others due to distributional shift.

6. **Pessimistic early stopping.** Monitor the divergence between benchmark-set improvement and held-out-set improvement. When proxy improvement exceeds held-out improvement by >2× for two consecutive batches, halt the convergence loop and require operator intervention. From the ICLR 2024 Goodhart's Law in RL paper.

---

## 9. Open Questions

These should be resolved through experimentation, not upfront design:

1. **~~Optimal leaf criteria bounds.~~** *(Partially resolved — §4.2.3.)* Research shows fixed thresholds are wrong; adaptive granularity is correct. Remaining question: what complexity estimator features best predict the simple/moderate/complex boundary for this specific codebase? The convergence loop should discover this empirically.

2. **Decomposition agent accuracy.** Can an LLM reliably decompose tasks, or should decomposition be more structured/algorithmic (CodePlan-style dependency graph analysis)? *(Coupling analysis is now hybrid per §4.2.4. Decomposition accuracy remains an open question for the LLM-driven strategies D2/D3.)*

3. **Contract specification cost.** Full typed contracts at every boundary may consume more tokens than they save. What's the minimum viable contract?

4. **Cynefin classification reliability.** Can an agent reliably classify tasks as Clear/Complicated/Complex/Chaotic, or does this require human judgment?

5. **Context strategy interaction effects.** Does hierarchical context + domain-scoped agents outperform full-dump + single agent? Or does the overhead of context management negate the benefits?

6. **Node UI editing semantics.** When a human edits the decomposition graph mid-run, what exactly happens? Re-execute from the edited node? Re-decompose children? Preserve completed siblings?

7. **Scale 3 task duration vs. budget.** A 30–60 minute feature may require 200K+ tokens across all nodes. What's the practical budget ceiling before cost becomes prohibitive for experimentation?

---

## 10. Relationship to Existing Documents

| Document | Relationship |
|----------|-------------|
| `docs/benchmark-program.md` | This spec extends and supersedes the Phase 2–5 roadmap. D/V/T matrix is preserved and expanded. |
| `SYNTROPY.md` | Decomposition principles are imported as Layer 1's ruleset. Section contracts are the primary boundary detection mechanism. |
| `docs/oversight-matrix.md` | THE_FACTORY's 2-tier oversight maps to the AutonomyProfile. Risk classification feeds readiness assessment. |
| `.agent/schemas/run.schema.json` | Run record schema is extended with decomposition and readiness metrics. |
| `src/types/index.ts` | CRUCIBLE's existing types are preserved. New types (DecompositionGraph, PipelineDefinition) are additions, not replacements. |
| Research documents | Findings are encoded as configurable parameters, not hardcoded architecture. The spec is designed so that contradictory research findings can be tested against each other. |
