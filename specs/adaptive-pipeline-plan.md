---
status: DRAFT
created: 2026-03-27
project: CRUCIBLE
companion_to: specs/adaptive-pipeline-spec.md
---

# Phased Implementation Plan: Adaptive Pipeline

## Overview

This plan implements the Adaptive Pipeline Spec in phases ordered by:
1. **Foundation first** — data model and storage before execution or visualization
2. **Value at each phase** — every phase produces a usable, testable increment
3. **Risk-first validation** — the riskiest assumptions are tested earliest
4. **CRUCIBLE ↔ THE_FACTORY convergence** — each phase makes the two systems more integrated

Each phase has: scope, deliverables, definition of done, what it validates, and estimated complexity.

---

## Phase 0: Decomposition Graph Data Model + Storage

**Goal:** Define the shared artifact that all subsequent phases produce and consume. Without a stable data model, everything else is built on sand.

### Scope

- Define TypeScript interfaces for `DecompositionGraph`, `DecompositionNode`, `DependencyEdge`, `ReadinessAssessment`, `ExecutionRecord`, `ReasoningEntry`
- Add these to `src/types/index.ts` alongside existing CRUCIBLE types (additive, not breaking)
- Implement `GraphStore` — read/write DecompositionGraph as JSON files under `runs/{runId}/`
- Implement `GraphBuilder` — programmatic construction of graphs (used by Layer 1 decomposition engines)
- Write graph-level event types that the RunEngine can emit (extending existing event system)
- Schema validation: JSON Schema for `graph.json` (following THE_FACTORY's `.agent/schemas/` pattern)

### Deliverables

1. `src/types/graph.ts` — All graph-related TypeScript interfaces
2. `src/engine/GraphStore.ts` — Read/write/query graphs from `runs/` directory
3. `src/engine/GraphBuilder.ts` — Fluent API for constructing graphs programmatically
4. `.agent/schemas/graph.schema.json` — JSON Schema for validation
5. Unit tests for GraphStore and GraphBuilder
6. One manually-constructed example graph in `tasks/examples/` showing the data model applied to `bugfix-cross-file-diagnosis.json`

### Definition of Done

- A DecompositionGraph can be created, persisted, read back, and validated
- The example graph accurately represents a reasonable decomposition of the bugfix task
- Existing CRUCIBLE types and RunEngine are unchanged (no regressions)
- `npm run typecheck` passes

### What This Validates

- Is the data model expressive enough to represent D0–D4 decomposition strategies?
- Is the storage format (JSON files) sufficient for the read patterns we need?
- Does the graph model compose cleanly with CRUCIBLE's existing RunResult?

### Estimated Complexity

- **Size:** ~500 LOC TypeScript + ~200 LOC tests + schema
- **Risk:** Low. Additive types, no behavioral changes to existing code.
- **Duration:** 1 session

---

## Phase 1: Global Readiness Gate

**Goal:** Implement the "tell when things need better defining" capability. This is the highest-value feature for overnight autonomy — it prevents the pipeline from wasting budget on underspecified tasks.

### Scope

- Implement `ReadinessGate` that evaluates a task (or DecompositionNode) against the global rules:
  - `has_acceptance_criteria` (hard)
  - `has_scope_boundary` (hard)
  - `has_verification_command` (hard)
  - `dependencies_resolved` (hard)
  - `no_ambiguous_terms` (**advisory** — see research note below)
  - `risk_classified` (hard)
- Each check produces a `ReadinessCheck` result (pass/fail + detail string + binding level)
- **Gate mode: `"hard-block" | "triage"` (default: triage).** In triage mode, failed checks flag issues for operator review rather than hard-blocking. Research shows LLMs achieve high recall but low precision on requirement screening (Lubos et al. 2024).
- **Ambiguity detection is advisory only.** Zhang et al. (2024) showed LLMs detect ambiguity only slightly above chance. Treat `no_ambiguous_terms` as one signal among several, not a hard gate.
- Failing checks generate question objects compatible with THE_FACTORY's `questions.jsonl` schema
- Configurable `readinessThreshold` and `globalWeight`
- **Calibration mechanism:** Track historical false-positive rate and use it to tune thresholds
- Gate integrates with the RunEngine: tasks that fail readiness are marked `blocked` with questions, not executed

### Deliverables

1. `src/engine/ReadinessGate.ts` — Global readiness evaluation
2. `src/engine/QuestionGenerator.ts` — Produces structured questions from readiness failures (THE_FACTORY schema)
3. Integration with RunEngine: pre-flight check before agent execution
4. Tests: tasks that should pass readiness, tasks that should fail, question generation
5. Example: run `bugfix-cross-file-diagnosis.json` through the gate (should pass), run a deliberately vague task through the gate (should fail with questions)

### Definition of Done

- A well-specified task passes the readiness gate and executes normally
- A vague task ("make the app faster") fails the gate and produces specific, actionable questions
- The questions match THE_FACTORY's `questions.jsonl` schema
- Readiness threshold and weight are configurable via variant config
- No changes to existing task JSON format (readiness assessment is computed, not declared)

### What This Validates

- Does the triage mode produce actionable flags without creating a bottleneck?
- What is the false-positive rate of the gate, and how quickly can calibration bring it down?
- Is the global rule set sufficient, or do false positives/negatives reveal missing rules?
- Does the question generator produce questions the operator would actually find useful?
- Does downgrading ambiguity detection to advisory reduce false-positive rate without increasing false-negative rate?

### Estimated Complexity

- **Size:** ~400 LOC + ~300 LOC tests
- **Risk:** Medium. The ambiguity detection quality depends on the LLM's ability to assess task specs. May need iteration on prompts/rules.
- **Duration:** 1–2 sessions

### Critical Assumption to Test

The biggest risk in the entire spec is whether LLM-based readiness assessment works reliably. **This phase should be prioritized precisely because it tests this assumption early.** If the readiness gate produces too many false positives (blocking good tasks) or false negatives (passing vague tasks), we learn that before building the rest of the system on top of it.

**Experiment:** Run the readiness gate against all existing CRUCIBLE tasks + 5 deliberately vague tasks. Target: 0 false negatives (no vague task passes), ≤1 false positive (at most 1 good task blocked).

---

## Phase 2: Decomposition Engine (D0 + D4 + D5 Strategies)

**Goal:** Implement adaptive decomposition that produces DecompositionGraphs from tasks. Start with three strategies: D0 (no decomposition), D4 (interface-first), and D5 (adaptive/as-needed), which cover the decomposition spectrum including the research-recommended ADaPT pattern.

### Why D0, D4, and D5 First

- **D0** is trivial to implement and serves as the control baseline
- **D4** (interface-first) is the most architecturally interesting — it requires analyzing module boundaries and cutting along coupling seams, which exercises the full graph model
- **D5** (adaptive/as-needed) implements the ADaPT pattern (NAACL 2024), which consistently outperforms predetermined decomposition in controlled studies (+28% ALFWorld, +33% TextCraft). It also naturally discovers whether decomposition is needed at all.
- Starting at the extremes + adaptive lets us validate the framework before filling in the middle (D1, D2, D3)
- D4 also maps most naturally to SYNTROPY's section-contract model, making the THE_FACTORY convergence concrete early

### Scope

- Implement `DecompositionEngine` with pluggable strategy interface
- Implement `D0Strategy` — wraps the entire task as a single leaf node
- Implement `D4Strategy` — analyzes the task for module boundaries (using section contracts if available, or LLM-based dependency analysis), produces a graph with interface-first cuts
- Implement `D5Strategy` — attempt execution first, decompose parent on failure with failure evidence as context (ADaPT pattern)
- **Adaptive bounds** (replacing fixed SYNTROPY thresholds): `decomposition_trigger` field (`"preemptive" | "on-failure" | "hybrid"`), soft complexity hints instead of hard LOC/file limits, depth cap at **3 levels** (per CMU 2025)
- **Complexity triage** (fast-path escape): lightweight estimator classifies tasks as simple/moderate/complex. Simple tasks skip decomposition entirely (D0 fast path). The threshold is an experimental variable.
- **Hybrid coupling audit**: static analysis (AST/imports) produces edge structure, LLM classifies coupling semantics. Edges with `couplingConfidence < 0.7` flagged for review.
- Strategy config is loaded from variant YAML (extending VariantConfig)

### Deliverables

1. `src/engine/DecompositionEngine.ts` — Core engine with strategy plugin interface
2. `src/engine/strategies/D0Strategy.ts` — Direct (no decomposition)
3. `src/engine/strategies/D4Strategy.ts` — Interface-first decomposition
4. `src/engine/strategies/D5Strategy.ts` — Adaptive/as-needed (ADaPT pattern)
5. `src/engine/strategies/StrategyConfig.ts` — YAML config schema for strategies
6. `src/engine/ComplexityEstimator.ts` — Fast-path triage (simple/moderate/complex classification)
7. `src/engine/CouplingAudit.ts` — Hybrid coupling audit (static analysis + LLM classification)
8. `src/engine/AdaptiveBounds.ts` — Soft complexity hints, depth cap, decomposition trigger logic
9. Tests: D0 produces 1-node graph, D4 produces multi-node graph with correct boundaries, D5 attempts execution before decomposing
10. Scale 2 task: extract one real multi-section task from SCUE (or synthetic equivalent) that requires decomposition

### Definition of Done

- D0 wraps any task as a single leaf and passes it to execution
- D4 produces a multi-node graph for the Scale 2 task with:
  - Correct boundary placement (aligned with section contracts if present)
  - Valid hybrid coupling audit on all edges (static + LLM, with confidence scores)
  - All leaves passing adaptive bounds (complexity estimate, not hard LOC threshold)
  - 100% acceptance criteria coverage
- D5 attempts execution first, decomposes on failure with failure evidence, produces a graph whose depth correlates with actual task complexity
- Complexity triage correctly classifies simple tasks and routes them to D0 fast path
- Strategy is selected via variant YAML config
- Decomposition metrics (node count, depth, L1 pass rate) are computed and stored

### What This Validates

- Can LLM-based decomposition produce graphs that align with human-created section contracts?
- Does the D4 strategy produce leaves that are actually solvable?
- Does D5 (adaptive) outperform D4 (preemptive) on mixed-complexity task batches?
- Does the complexity triage fast-path save tokens on simple tasks without missing necessary decomposition?
- Does the hybrid coupling audit produce fewer hallucinated dependencies than LLM-only?
- What complexity threshold best separates tasks that benefit from decomposition from those that don't?

### Estimated Complexity

- **Size:** ~1200 LOC + ~600 LOC tests (increased from original due to D5, complexity estimator, hybrid coupling)
- **Risk:** High. D4 decomposition quality is a core bet. D5 adds the question of whether the ADaPT pattern transfers to software tasks. Hybrid coupling audit requires TypeScript compiler API integration. If LLMs can't reliably identify module boundaries, the strategy falls back to more structured approaches (CodePlan-style static analysis).
- **Duration:** 3–4 sessions

---

## Phase 3: Graph-Walking RunEngine

**Goal:** Extend CRUCIBLE's RunEngine to walk a DecompositionGraph instead of running a single agent against a flat task.

### Scope

- Extend RunEngine with `executeGraph(graph: DecompositionGraph, pipeline: PipelineDefinition)` method
- Implement ready-leaf scheduling: identify nodes whose dependencies are all met
- **Complexity triage fast-path:** Before decomposition, run complexity estimator. Simple tasks skip to D0 direct execution. This is step 0 of the graph execution loop (spec §5.2.1).
- **Sandbox isolation policy:** Per-node isolated sandboxes by default, shared read-only base images with writable overlays (spec §5.4). No shared filesystem between concurrent nodes.
- Per-node execution: create a scoped sub-run for each leaf node using existing agent/middleware/sandbox infrastructure
- Per-node result capture: write ExecutionRecord, artifacts, reasoning back to the graph
- Verification gate execution after each leaf (V0 self-check initially, V1 as stretch)
- SYNTROPY Principle 3: on leaf failure, mark node failed and emit `redecompose` event (handler can re-decompose parent)
- Graph-level kill switches: total budget, total TTL, total mutations across all nodes
- Event emission: extend existing WebSocket event stream with graph-level events

### Deliverables

1. Extended `RunEngine.ts` with `executeGraph()` method
2. `src/engine/GraphScheduler.ts` — ready-leaf identification and execution ordering
3. `src/engine/NodeExecutor.ts` — scoped sub-run per leaf (sandbox reuse or fresh per node — design decision)
4. Per-node event types in WebSocket stream
5. Integration test: run D0 (single node) through graph engine, verify identical results to current RunEngine
6. Integration test: run D4 graph through engine, verify nodes execute in dependency order
7. Graph-level budget tracking (tokens distributed across nodes)

### Definition of Done

- D0 graph (1 node) produces identical results to current flat RunEngine (backward compatible)
- D4 graph executes nodes in correct dependency order
- Per-node results are written back to graph.json
- Graph-level budget is enforced (run terminates when total budget exhausted)
- WebSocket stream shows per-node events (started, completed, failed)
- Existing CLI and web UI continue to work (they see RunResult; graph detail is additive)

### What This Validates

- Does graph-walking execution produce better results than flat execution for multi-section tasks?
- What's the overhead of graph scheduling vs. simple sequential execution?
- ~~Can sandbox state be shared across nodes (reuse) or must each node start fresh (isolation)?~~ *(Resolved: per-node isolation by default, per spec §5.4. Shared state via read-only base images with writable overlays.)*
- Does the complexity triage fast-path correctly identify tasks that don't need decomposition?
- What's the token savings from fast-pathing simple tasks vs. decomposing everything?

### Estimated Complexity

- **Size:** ~1000 LOC + ~500 LOC tests
- **Risk:** Medium-High. The interaction between graph scheduling, sandbox lifecycle, and budget tracking is complex. Sandbox reuse vs. isolation is a key design decision with performance and correctness trade-offs.
- **Duration:** 2–3 sessions

### Key Design Decision: Sandbox Strategy

| Option | Pros | Cons |
|--------|------|------|
| **Fresh sandbox per node** | Clean isolation, no state leakage | Expensive (E2B creation time), can't share build artifacts |
| **Shared sandbox, scoped execution** | Fast, build artifacts persist | State leakage risk, harder to attribute failures |
| **Shared sandbox with checkpoint/restore** | Balance of isolation and speed | Complex to implement, E2B support TBD |

Recommendation: Start with shared sandbox (fast iteration), add isolation if state leakage causes problems. This mirrors THE_FACTORY's approach (one git repo, scoped changes).

---

## Phase 4: Comparative Runner + Basic Scoring

**Goal:** Run multiple PipelineDefinitions against the same task in parallel and produce a comparison report.

### Scope

- Implement `BatchRunner` — takes a task + list of PipelineDefinitions, runs each, collects results
- Parallel execution via concurrent RunEngine instances (one per variant)
- Extend `compare-variants.py` (or TypeScript equivalent) with graph-aware comparison:
  - Structural diff (node count, depth, boundary alignment)
  - Execution diff (per-node tokens, rework rate, escalation rate)
  - Quality diff (check pass rates, artifact completeness)
  - **MAST failure annotation** — categorize failures into specification/system design (41.8%), inter-agent misalignment (36.9%), and verification/termination (21.3%) per NeurIPS 2025 taxonomy
- **Statistical significance.** All comparative metrics include confidence intervals. Variants must differ by >2σ to count as meaningfully different (BetterBench, arXiv:2411.12990).
- **Benchmark provenance tracking.** Each task carries `benchmarkProvenance: "proprietary" | "public-modified" | "synthetic"`. Only proprietary tasks are eligible for convergence-loop promotion decisions.
- CLI command: `crucible compare --task <task> --variants <v1.yaml> <v2.yaml> ...`
- JSON comparison report output

### Deliverables

1. `src/engine/BatchRunner.ts` — parallel variant execution
2. `src/engine/GraphComparator.ts` — structural, execution, and quality diff
3. Extended CLI `compare` command
4. Comparison report JSON schema
5. Test: run B0 vs. B4 (from Phase 2) against the Scale 2 task, verify comparison report is produced with meaningful discrimination

### Definition of Done

- Multiple variants can run against the same task concurrently
- Comparison report contains structural, execution, and quality metrics
- Discrimination score is computed per task per variant-pair
- Results are stored for trend analysis across experiment batches

### What This Validates

- Does the system produce actionable comparative insights?
- Is parallel execution stable (no cross-variant interference)?
- Do different decomposition strategies actually produce measurably different results on Scale 2 tasks?

### Estimated Complexity

- **Size:** ~600 LOC + ~300 LOC tests
- **Risk:** Medium. Parallel execution adds concurrency concerns. Comparison metrics need calibration.
- **Duration:** 1–2 sessions

---

## Phase 5: Node UI (Read-Only)

**Goal:** Visual representation of DecompositionGraphs that makes overnight run results human-readable.

### Scope

- React component using a graph visualization library (ReactFlow recommended — supports custom nodes, edges, interactive panels, already React-based)
- Render `graph.json` as a node layout with:
  - Status-colored nodes (green/red/yellow/gray)
  - Coupling-typed edges (color-coded)
  - Click-to-inspect: artifacts, reasoning, metrics per node
  - Readiness score indicator per node
- Side-by-side view: two variants' graphs for the same task
- Integration with existing CRUCIBLE web UI (new page/route)
- WebSocket integration for live updates during execution

### Deliverables

1. `ui/src/pages/GraphView.tsx` — Single run graph visualization
2. `ui/src/pages/CompareView.tsx` — Side-by-side variant comparison
3. `ui/src/components/GraphNode.tsx` — Custom node component with status, metrics, click-to-expand
4. `ui/src/components/GraphEdge.tsx` — Custom edge with coupling-type styling
5. `ui/src/components/NodeDetail.tsx` — Artifact/reasoning/metrics panel
6. Route integration in existing app structure
7. WebSocket handler for live graph updates

### Definition of Done

- An overnight run's DecompositionGraph renders as a readable node layout
- Clicking a node shows its artifacts, reasoning, execution record, and metrics
- Two variants' graphs can be viewed side-by-side for the same task
- Live runs show graph construction in real-time via WebSocket
- The operator can understand HOW a variant worked, not just WHETHER it worked

### What This Validates

- Is node visualization sufficient for understanding pipeline behavior?
- Does side-by-side comparison reveal actionable differences between strategies?
- Is the data model (from Phase 0) sufficient for the visualization needs, or are there missing fields?

### Estimated Complexity

- **Size:** ~1200 LOC React + ~200 LOC server routes
- **Risk:** Medium. ReactFlow integration is well-documented. The main risk is layout quality — auto-layout of arbitrary DAGs may not be pretty without manual tuning.
- **Duration:** 2–3 sessions

---

## Phase 6: Dynamic Readiness Gate + Additional Strategies

**Goal:** Complete the readiness system and fill in the decomposition strategy spectrum.

### Scope

- Implement dynamic readiness gate (strategy-specific checks layered on top of global)
- Implement remaining decomposition strategies:
  - D1 (Fixed Ladder) — phase-based decomposition
  - D2 (Goal Tree) — objective/constraint hierarchy
  - D3 (HTN) — recursive decomposition until solvable
  - Domain-Scoped — section-contract-aware decomposition
  - Temporal/Single-Agent — context-switching phases
- Implement additional coordination protocols:
  - Domain-teams (assign leaves to section-scoped units)
  - Contract-net (auction-based task allocation)
- Implement V1 (Independent Verifier) and V2 (Paired V-Model) verification
- Full PipelineDefinition YAML config with all fields

### Deliverables

1. `src/engine/DynamicReadinessGate.ts` — strategy-aware readiness checks
2. `src/engine/strategies/D1Strategy.ts` through `D3Strategy.ts`
3. `src/engine/strategies/DomainScopedStrategy.ts`
4. `src/engine/strategies/TemporalStrategy.ts`
5. `src/engine/coordination/DomainTeams.ts`
6. `src/engine/coordination/ContractNet.ts`
7. `src/engine/verification/IndependentVerifier.ts` (V1)
8. `src/engine/verification/PairedVModel.ts` (V2)
9. Full variant YAML configs for B0–B10
10. Scale 2 benchmark suite: 3+ multi-section tasks with discrimination validation

### Definition of Done

- All strategies from the benchmark matrix (B0–B10) can be expressed and executed
- Dynamic readiness gate produces different checks per strategy
- Readiness weight ratio (global vs. dynamic) is configurable and measurable
- Each new strategy passes integration tests on at least 2 task families

### What This Validates

- Does the strategy spectrum produce meaningful variation in outcomes?
- Is the dynamic readiness gate adding value over global-only?
- Which strategies are promising for deeper investment (Phase 7+)?

### Estimated Complexity

- **Size:** ~2000 LOC + ~800 LOC tests
- **Risk:** High. This is the largest phase and has the most unknowns. Each strategy's decomposition quality is an empirical question. Recommendation: implement and benchmark strategies incrementally (one at a time), not all at once.
- **Duration:** 4–6 sessions (can be parallelized — each strategy is independent)

---

## Phase 7: Autonomy Profiles + Question Queue Integration

**Goal:** Make the system truly overnight-capable by implementing configurable autonomy and question batching.

### Scope

- Implement `AutonomyProfile` as a runtime config affecting execution behavior
- Implement question batching: when a node escalates, the question is queued and the engine moves to the next ready node
- Implement checkpoint budgets: force artifact persistence every N steps
- Integrate with THE_FACTORY's `questions.jsonl` for cross-system question flow
- Implement the "morning report": summary of what happened, what questions need answers, what's ready for the next batch

### Deliverables

1. `src/engine/AutonomyManager.ts` — runtime autonomy enforcement
2. `src/engine/QuestionQueue.ts` — batch question accumulation + morning report
3. Autonomy profile YAML config section in PipelineDefinition
4. Morning report generator (JSON + human-readable summary)
5. Integration: CRUCIBLE questions flow into THE_FACTORY's `.agent/questions.jsonl`
6. Test: run a task batch with deliberate ambiguities, verify questions are queued and execution continues on non-blocked nodes

### Definition of Done

- A batch of 3 tasks (1 well-specified, 1 vague, 1 partially specified) runs overnight:
  - Well-specified task completes autonomously
  - Vague task generates questions and is blocked
  - Partially specified task completes what it can, questions the rest
- Morning report accurately summarizes state
- Questions are formatted for easy operator response
- Different autonomy profiles produce measurably different question rates

### What This Validates

- Can the system productively work through a batch without human intervention?
- Is the question quality high enough that operator responses unblock tasks efficiently?
- Does the `queue-and-continue` escalation behavior produce better overnight throughput than `block`?

### Estimated Complexity

- **Size:** ~600 LOC + ~300 LOC tests
- **Risk:** Medium. Question quality depends on LLM capability. The morning report UX will need iteration.
- **Duration:** 1–2 sessions

---

## Phase 8: Node UI (Editable) + Pipeline Configuration Visualization

**Goal:** The Max/TouchDesigner-style interface where the operator can visually modify decomposition and pipeline configuration.

### Scope

- Make the graph visualization editable:
  - Drag to restructure decomposition (move nodes, change parent-child relationships)
  - Split/merge nodes
  - Edit node properties (acceptance criteria, owned paths, verification commands)
  - Re-execute from an edited node (downstream nodes are reset)
- Pipeline configuration visualization:
  - Render PipelineDefinition as a visual graph (stages, gates, kill switches)
  - Edit pipeline configuration visually
  - Save edited configuration as a new variant YAML
- Bi-directional sync: graph edits → JSON → re-execution; pipeline edits → YAML → new variant

### Deliverables

1. Editable graph components (drag-and-drop, split, merge)
2. Re-execution trigger from edited node
3. Pipeline definition visualization
4. Pipeline definition editor
5. YAML export from visual editor

### Definition of Done

- Operator can visually restructure a decomposition and re-run from the edit point
- Operator can visually modify a pipeline configuration and save it as a variant
- Round-trip: YAML → visual → edit → YAML produces valid configs

### What This Validates

- Does visual editing improve the operator's ability to steer pipeline behavior?
- Is the data model robust enough for arbitrary edits?

### Estimated Complexity

- **Size:** ~2000 LOC React
- **Risk:** High. Editable graph UIs are complex. The re-execution semantics (what happens to completed siblings when a parent is re-decomposed?) need careful design.
- **Duration:** 3–5 sessions

---

## Phase 9: Scale 3 Tasks + Convergence Protocol

**Goal:** Full overnight batch runs on feature-level tasks with findings flowing back to THE_FACTORY.

### Scope

- Design and build 2–3 Scale 3 (feature-level) benchmark tasks — **proprietary only** (from real internal work, never published)
- Implement promotion criteria: automated check of whether a variant meets promotion thresholds, **including held-out validation set** (spec §8.4)
- **Anti-Goodhart safeguards** (spec §8.4):
  - Held-out validation set that the convergence loop never sees
  - Multi-metric promotion (improve ≥3 of 7 metrics, no regression on hard gates)
  - Canary/sentinel tasks designed to detect gaming behavior
  - Mandatory MAST-annotated failure-mode review before promotion
  - Distribution diversity (tasks from ≥3 families, ≥2 codebases)
  - Pessimistic early stopping when proxy improvement diverges from held-out improvement by >2×
- Implement convergence protocol: promoted pipeline configs are applied to THE_FACTORY's default settings
- **Rolling benchmark refresh:** target ≥20% task replacement per quarter
- Feedback loop: track promoted configs' performance in real THE_FACTORY usage via run records
- Regression detection: alert if promoted config underperforms

### Deliverables

1. Scale 3 benchmark tasks with seed repos, acceptance criteria, hidden checks (**proprietary provenance only**)
2. Held-out validation set (separate from benchmark set, never used in overnight runs)
3. Canary/sentinel task set (tasks where obvious shortcuts produce wrong answers)
4. `src/engine/PromotionEvaluator.ts` — checks variant against promotion criteria including held-out validation
5. `src/engine/GoodhartMonitor.ts` — tracks proxy vs. held-out divergence, implements pessimistic early stopping
6. Convergence tooling: export winning variant as THE_FACTORY skill/hook/config updates
7. Documentation: operator guide for the overnight workflow including failure-mode review checklist

### Definition of Done

- An overnight batch of Scale 3 tasks runs to completion (or questions)
- The comparison report identifies a winning strategy with supporting evidence **and MAST-annotated failure analysis**
- The winning strategy passes held-out validation with no regression vs. incumbent
- The winning strategy can be promoted to THE_FACTORY with a documented procedure
- Canary tasks detect at least one synthetic gaming attempt in testing
- Pessimistic early stopping triggers correctly when proxy/held-out metrics diverge
- Regression detection works across the next 3+ real THE_FACTORY sessions

### What This Validates

- Does the full system work end-to-end at feature scale?
- Do CRUCIBLE findings actually improve THE_FACTORY performance?
- Is the convergence loop sustainable (not just a one-shot improvement)?
- Do the anti-Goodhart safeguards catch gaming/overfitting before promotion?
- Does distribution diversity prevent codebase-specific overfitting?

### Estimated Complexity

- **Size:** ~1000 LOC + significant design work for Scale 3 tasks and safeguards
- **Risk:** High. The Goodhart's law risk is mathematically inevitable given sustained optimization pressure (Skalse et al. 2022). The safeguards reduce but don't eliminate this risk. Task design at feature scale is challenging — they must be realistic enough to produce valid signals but contained enough to complete within budget.
- **Duration:** 3–4 sessions

---

## Phase Dependencies

```
Phase 0 (Data Model)
    ↓
Phase 1 (Global Readiness Gate) ─── can run in parallel with ──→ Phase 2 (D0 + D4 + D5 Strategies)
    ↓                                                              ↓
    └──────────────────────────── both feed into ────────────────→ Phase 3 (Graph-Walking RunEngine)
                                                                   ↓
                                                        Phase 4 (Comparative Runner)
                                                           ↓              ↓
                                                  Phase 5 (Node UI)    Phase 6 (More Strategies)
                                                           ↓              ↓
                                                           └──────┬───────┘
                                                                  ↓
                                                        Phase 7 (Autonomy + Questions)
                                                                  ↓
                                                        Phase 8 (Editable Node UI)
                                                                  ↓
                                                        Phase 9 (Scale 3 + Convergence)
```

**Phases 1 and 2 are parallelizable** — readiness gate and decomposition strategies are independent. This is the main acceleration opportunity.

**Phase 5 can start as soon as Phase 3 produces graph.json files** — it doesn't need the comparator.

**Phase 6 can proceed incrementally** — each strategy is independent. The most promising strategies (based on Phase 4 results) should be implemented first.

---

## Risk Registry

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| LLM decomposition quality is unreliable | High — undermines the entire system | Medium | Test early (Phase 2). Fall back to structured/algorithmic decomposition if LLM fails. Hybrid coupling audit (static + LLM) reduces hallucination risk. |
| Readiness gate produces too many false positives | Medium — blocks legitimate tasks | Medium | Triage mode (default) + calibration mechanism. Ambiguity detection is advisory only. Tune thresholds empirically (Phase 1). |
| Graph execution overhead negates decomposition benefits | Medium — system is slower than flat execution | Low | Complexity triage fast-path skips decomposition for simple tasks. Measure overhead in Phase 3. |
| **Goodhart's law / benchmark gaming** | **Critical — convergence loop optimizes proxy, not true quality** | **High** | **Held-out validation, multi-metric promotion, canary tasks, pessimistic early stopping, rolling benchmark refresh (Phase 9). Mathematically inevitable — safeguards reduce, not eliminate.** |
| **Benchmark contamination** | **High — models may have seen task solutions in training** | **Medium** | **Proprietary tasks only for promotion decisions. Rolling refresh. Provenance tracking (Phase 4).** |
| **Distributional shift** | **High — 40% success rate drops on different repo distributions** | **Medium** | **Distribution diversity requirement (≥3 families, ≥2 codebases). Held-out set from different distribution than benchmark set.** |
| Scale 3 tasks exceed practical budget ceiling | High — can't validate feature-level scenarios | Medium | Start with Scale 2 validation. Only attempt Scale 3 when budget management is proven. |
| E2B sandbox costs at scale | Medium — parallel variant runs multiply sandbox costs | Medium | Sandbox reuse strategy (Phase 3 design decision). Budget ceiling per experiment batch. |
| Node UI complexity exceeds available React patterns | Low — ReactFlow handles most cases | Low | Phase 5 is read-only first, reducing risk. Editable (Phase 8) deferred until data model is proven. |
| Convergence loop doesn't close | High — CRUCIBLE findings don't improve THE_FACTORY | Low | Small-scale validation in Phase 9 before full automation. Manual promotion with operator review. |

---

## Milestone Summary

| Milestone | Phases | What the Operator Can Do |
|-----------|--------|-------------------------|
| **M1: Foundation** | 0 + 1 | Run tasks through readiness gate. See which tasks are well-defined vs. vague. |
| **M2: Decomposition** | 2 + 3 | Run a task through D0 and D4 strategies. See the decomposition graph. |
| **M3: Comparison** | 4 | Run multiple strategies against the same task. See ranked comparison. |
| **M4: Visualization** | 5 | See graphs visually. Compare variants side-by-side in the browser. |
| **M5: Full Spectrum** | 6 + 7 | Run all B0–B10 variants overnight. Get morning report with questions. |
| **M6: Interactive** | 8 | Visually edit decompositions and pipeline configs. |
| **M7: Convergence** | 9 | Promote winning configs to THE_FACTORY. Close the improvement loop. |

**Target: M1–M3 are the minimum viable system.** If only these three milestones ship, the operator can run comparative decomposition experiments with readiness gating. Everything after M3 is improvement — valuable but not blocking the core use case.
