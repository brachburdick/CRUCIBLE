# Section: orchestration

## Purpose

Pure task analysis, decomposition, and graph construction logic. Evaluates whether a task is ready for execution (ReadinessGate), decides how to break it down (DecompositionEngine, StrategySelector), and builds/walks the execution graph (GraphBuilder, GraphExecutor, NodeScheduler). This is the intelligence layer — it reasons about tasks but never executes agents or manages containers.

## Owned Paths

```
src/engine/ReadinessGate.ts
src/engine/StrategySelector.ts        # Phase 7B — new
src/engine/DecompositionEngine.ts
src/engine/strategies/D0Strategy.ts
src/engine/strategies/D4Strategy.ts
src/engine/strategies/D5Strategy.ts
src/engine/GraphBuilder.ts
src/engine/GraphExecutor.ts
src/engine/GraphStore.ts
src/engine/NodeScheduler.ts
src/engine/PromptBuilder.ts
src/engine/QuestionGenerator.ts
src/engine/ComplexityEstimator.ts
src/engine/CouplingAudit.ts
src/engine/AdaptiveBounds.ts
src/engine/scorer.ts
src/engine/llm.ts
src/engine/validation.ts
src/engine/variants.ts
src/engine/index.ts
src/types/index.ts
src/types/graph.ts
```

**Excluded from this section** (co-owned by server):
- `src/engine/RunEngine.ts` — integration point, imports from all sections
- `src/engine/agents.ts` — agent registry, bridges orchestration and execution

## Incoming Inputs

- **From operator (via server):** `TaskPayload` — description, instructions, files, checks, seedDir
- **From operator (via server):** `ReadinessGateConfig` — gate mode, readiness threshold, global weight
- **From operator (via server):** Enrichments map and deep analysis request (Phase 7A/7B)
- **From LLM provider:** LLM responses for D4/D5 decomposition, deep analysis heuristics

## Outgoing Outputs

- **Types (consumed by all sections):** `TaskPayload`, `RunConfig`, `DecompositionGraph`, `DecompositionNode`, `ReadinessAssessment`, `ReadinessCheck`, `DependencyEdge`, `GraphEvent`, `ExecutionRecord`, `NodeMetrics`, `GraphMetrics`, all types in `src/types/`
- **Data:** `ReadinessAssessment` (gate results), `DecompositionGraph` (task breakdown), `CascadeResult` (strategy recommendation), `ScoreResult` (post-execution scoring)
- **Side effects:** Graph JSON files written to `runs/` directory via `GraphStore`

## Invariants

- **No agent execution.** This section never spawns processes, creates containers, or calls agent functions. It reasons about tasks; execution happens elsewhere.
- **No imports from agents/, sandbox/, middleware/, server/, session/, telemetry/.** Only imports from `src/types/` (which it owns) and external libraries.
- **Exception:** `src/engine/llm.ts` calls the Anthropic API for decomposition and deep analysis. This is the only network call permitted in this section, and it is for reasoning (LLM inference), not agent execution.
- **Pure function preference.** ReadinessGate.assess(), StrategySelector.selectStrategy(), estimateComplexity(), generateQuestions() are all pure or near-pure. Side-effect-free logic is testable without mocks.
- **Types are source of truth.** `src/types/` is owned by this section. Type changes originate here; other sections consume but don't modify.

## Allowed Dependencies

**May import:**
- `src/types/` (own files)
- `src/engine/` (own files)
- External: `openai` (embeddings for loop detection in CouplingAudit), Anthropic SDK (via llm.ts)

**Must NOT import:**
- `src/agents/*`
- `src/sandbox/*`
- `src/middleware/*`
- `src/server/*`
- `src/session/*`
- `src/telemetry/*`
- `src/cli/*`

## How to Verify

```bash
npx vitest run src/test/phase0.test.ts src/test/phase1.test.ts src/test/phase2.test.ts src/test/phase3.test.ts
```

These tests cover: ReadinessGate (6 checks, binding tiers, score computation), DecompositionEngine (D0/D4/D5 strategies), GraphBuilder (node/edge construction, validation), GraphExecutor (DAG walking, scheduling, per-node execution), NodeScheduler (ready node selection, dependency resolution), PromptBuilder, ComplexityEstimator, CouplingAudit, AdaptiveBounds, QuestionGenerator, scorer, validation.

Passing means: all orchestration logic works correctly in isolation, without needing running agents, containers, or server infrastructure.
