# CRUCIBLE UX Pipeline Design — Architectural Brainstorm

**Status:** DRAFT — Design exploration, not implementation spec
**Date:** 2026-03-28
**Context:** CRUCIBLE executes well (3 agent backends, graph executor, kill switches, 198 tests). The bottleneck is now UX — specifically, how work gets into the system, how the user configures orchestration strategy, and how results feed back into the next iteration.

---

## Problem Statement

CRUCIBLE's execution pipeline is bottlenecked by the quality and consistency of its task queue. Tasks are currently hand-authored JSON files. There is no mechanism for:
- Transforming vague human intent into well-formed tasks
- Configuring orchestration strategy per-run (decomposition, agent, middleware, flow)
- Negotiating readiness before execution (questions exist but aren't wired into UI)
- Feeding execution results back into the next iteration

The system is also **meta**: CRUCIBLE is a tool for testing orchestration strategies, but CRUCIBLE itself is a project that should be manageable through those same strategies. The UX must serve both levels.

---

## Core Values

1. **Pipeline architecture is configurable, not prescribed.** Decomposition strategies, flow templates, agent backends, middleware stacks, and readiness thresholds are all swappable.
2. **Experimentation is first-class.** Users should be able to A/B test different pipeline configurations on the same task and compare results.
3. **Human stays in the loop via questions, not micromanagement.** The system identifies when information is too sparse and asks targeted questions, like standups with humans.
4. **Discovery over prescription.** The system doesn't need to know everything on day one — it needs to be instrumented to learn what matters over time.

---

## Five UX Gaps

| Gap | Current State | Target State |
|-----|--------------|--------------|
| **1. Work Intake** | Hand-authored JSON files in `tasks/` | User describes intent; system refines into well-formed task(s) |
| **2. Flow Selection** | Keyword-matching auto-detection | Explicit flow selection + custom flow composition |
| **3. Readiness Negotiation** | ReadinessGate + QuestionGenerator exist but aren't wired into UI launch | Pre-flight readiness check with inline question resolution |
| **4. Run Configuration** | LaunchForm has budget/TTL only | Full orchestration config: decomposition strategy, agent, middleware, flow, gate strictness |
| **5. Result Feedback Loop** | Run completes, user sees event log | Accept / reject / iterate with changes. Results inform next run configuration |

---

## UX Concepts Explored

### Concept A: Intake Wizard (Linear)
Stepped flow: Intent → Scope → Readiness Check → Orchestration Config → Review & Launch.
- **Strength:** Ensures readiness before execution. Maps directly to existing infrastructure.
- **Weakness:** Linear. Feels heavy for simple tasks.

### Concept B: Workbench (Spatial)
All configuration visible at once in reactive cards. Change intent → readiness auto-updates.
- **Strength:** Non-linear. Shows full picture. Supports quick launches and deep configuration.
- **Weakness:** More complex to build. Information density may overwhelm.

### Concept C: Pipeline Canvas (Graph-First) — RECOMMENDED DIRECTION
The meta-flow *is* a configurable graph:

```
[Intake] → [Readiness Gate] → [Execution] → [Review]
    ^                                           |
    └──────── [Iterate with feedback] ──────────┘
```

Each meta-node expands into a sub-graph. Sub-graphs are **derived from configuration**, not manually authored (Slot-level configurability, not Canvas-level).

- **Strength:** Maximum configurability. CRUCIBLE eating its own dog food. Naturally supports saving/comparing pipeline configs.
- **Weakness:** Highest implementation cost. Requires visual graph renderer.

### Recommended Approach
**Start with Concept A (wizard) but design the data model for Concept C.** Define a `PipelineConfig` type that captures the full intake-to-review flow as a serializable object. The wizard is v1 UI; the graph canvas is v2 rendering the same data model. Pipeline configs become the unit of experimentation.

---

## Intake Node Deep Dive

The Intake node is the hardest node in the meta-flow. It's where unbounded human intent meets structured pipeline requirements — a lossy compression problem.

### Internal Flow

```
[Raw Intent] → [Context Probe] → [Clarification Loop] → [Structured Brief] → [Task Shaping]
```

**1. Raw Intent:** User types free text + optionally selects work type. The system captures the text and nothing else.

**2. Context Probe:** Before asking the user anything, the system scans for ambient context:
- Existing projects related to the intent
- Prior runs in similar domains
- Tech stack inference from keywords

**3. Clarification Loop:** ReadinessGate runs against raw intent. Failed checks trigger questions. Two intake modes:
- **Structured interview** (rule-based question tree) — better for work on existing projects where the question space is constrained
- **Agent-driven elicitation** (lightweight LLM conversation) — better for open-ended/greenfield intents where the question space is unbounded
- Pipeline config slot: `intake_mode: 'structured' | 'conversational'`

**4. Structured Brief:** Human-readable, editable intermediate document. Contains: type, goal, context, tech stack, scope, success criteria, first milestone. User reviews and corrects before proceeding.

**5. Task Shaping:** Brief → TaskPayload(s). For large work, produces a proto-graph (rough sketch) that the Decomposition stage refines. For small work, produces a single TaskPayload.

### Intake Node Outputs
1. **Structured brief** (human-readable, editable)
2. **Proto-task(s)** shaped to TaskPayload schema
3. **Suggested flow type** (feature/debug/refactor/custom)
4. **Readiness status** (which checks pass after clarification)

---

## Execution Node Sub-Graph (Slot-Level Configurability)

Each meta-node expands into a sub-graph that is **derived from configuration choices**, not manually drawn. The user configures slots; the system projects the sub-graph.

### Example: Execution node with D4 strategy
```
Execution Stage (expanded)
├── [Decompose Task]          ← D4Strategy produces the DAG
├── [Node Scheduler]          ← topological sort, ready-node selection
├── [For each leaf node:]
│   ├── [Readiness Gate]      ← per-node preflight
│   ├── [Sandbox Create]      ← E2B / Docker / host
│   ├── [Middleware Stack]    ← token budget → loop detector → tracer
│   ├── [Agent Run]           ← LLM execution loop
│   ├── [Acceptance Checks]   ← run checks[] in sandbox
│   └── [Teardown]            ← flush artifacts, destroy sandbox
├── [Resolve Parent Nodes]    ← propagate status up DAG
└── [Emit Result]
```

### Example: Execution node with D0 strategy (collapses)
```
Execution Stage (D0)
├── [Sandbox Create]
├── [Middleware Stack]
├── [Agent Run]
├── [Acceptance Checks]
└── [Teardown]
```

### Configurability Levels

| Level | User controls | Sub-graph is... | When to use |
|-------|--------------|-----------------|-------------|
| **Template** | Pick a named pipeline template | Fully derived, read-only preview | Quick launches, known patterns |
| **Slot** | Swap components within a stage | Derived with override points | Default. Best balance of power and simplicity |
| **Canvas** | Draw the sub-graph manually | Fully authored | Future. Only if experimentation demands it |

**Slot level is the sweet spot.** Template is too rigid for experimentation. Canvas is overkill — the combinatorial space is constrained enough that slots cover it.

---

## Question Pipeline Integration

### Current Infrastructure
- `ReadinessGate` (src/engine/ReadinessGate.ts) — 6 global checks, configurable gate mode + threshold
- `QuestionGenerator` (src/engine/QuestionGenerator.ts) — maps failed checks to templated questions
- `QuestionQueue` (src/session/question-queue.ts) — async decision queue with answer persistence
- Session API routes for question CRUD

### Where Questions Surface in the Pipeline

1. **Intake node (Clarification Loop):** ReadinessGate runs against raw intent. Failed checks → QuestionGenerator → inline questions in the UI. User answers before proceeding.
2. **Readiness Gate meta-node:** Second pass after task shaping. Validates that shaped tasks meet the threshold. May generate new questions the Intake didn't cover.
3. **Mid-execution (emergent):** Agent encounters a decision point and asks a question the Intake didn't anticipate. This is a **discovered question** — it should be logged and mined for patterns.
4. **Review meta-node:** After execution, questions about whether results are acceptable, whether to iterate, what to change.

### Configurability
- `gateMode`: 'hard-block' | 'triage' (already exists)
- `readinessThreshold`: 0.0-1.0 (already exists)
- `intake_mode`: 'structured' | 'conversational' (new)
- Per-domain readiness profiles (learned over time, see below)

---

## The Granularity Problem

### Core Challenge
"Generally, what level of granularity of problem is acceptable for a given problem space, and what context is needed to inform it?"

Taking decomposition too far causes combinatorial explosion. Not far enough and agents flounder. The right level varies by domain, agent capability, and problem type.

### Second-Degree Ignorance
You can't configure what you can't enumerate, and you can't enumerate what you haven't encountered yet. The readiness gate catches structural deficiencies (no tests, no scope) but not domain-specific gaps (DSP tasks need latency budget, web apps need auth strategy).

### Resolution Strategy: Instrument Discovery, Don't Prescribe

The Intake node doesn't need to be smart on day one. It needs to be **instrumented** on day one so it can become smart.

1. **Start minimal:** Free text + work type + 6 generic readiness checks
2. **Log discovered questions:** Every mid-execution question an agent asks is a signal that the Intake should have asked it
3. **Log failure causes:** Every run failure + what information would have prevented it
4. **Mine patterns:** After 20-30 runs, cluster discovered questions by domain
5. **Build domain readiness profiles:** Per-domain extensions to the generic ReadinessGate (e.g., "DSP tasks also require: target latency, sample rate, channel count")
6. **Profiles tell you what to make configurable**

Feedback loop:
```
Intake → Execution → Agent asks question → Human answers → Run outcome
   ^                                                            |
   └──── Mine patterns → Domain readiness profiles ─────────────┘
```

---

## Questions That Must Be Answered to Inform Intake Design

### Category 1: Problem Space Classification
- Does work type (bug/feature/refactor/greenfield/exploration) change which questions are load-bearing?
- Is there a finite set of work types or a spectrum?
- **Testable:** Build 3-4 question templates (per flow type), measure downstream run success when matching template used vs. generic

### Category 2: Granularity Threshold
- Is there a token budget proxy for granularity? ("If agent solves it under 50k tokens, decomposition was sufficient")
- Is there a file count proxy? ("Tasks touching >5 files need further decomposition")
- Is the right granularity problem-dependent or agent-dependent? (Opus handles coarser tasks than Haiku)
- **Testable:** Run same vague task through D0 and D4, compare success rates. The delta = how much decomposition matters for that problem type

### Category 3: Information Sufficiency
- What information is actually needed for a given task type?
- Which readiness checks are load-bearing vs. nice-to-have per domain?
- When is "good enough" actually good enough?
- **Testable:** Compare runs where agent asked mid-execution questions vs. runs where same questions were answered upfront. If upfront answering improves success rate, those questions belong in Intake

### Category 4: Question Economics
- Every question has a cost (user attention) and value (reduced ambiguity). Where's the optimal tradeoff?
- Which decisions are safe to delegate to the agent vs. must be answered by the human?
- Rule of thumb candidate: "WHAT to build = human. HOW to build = agent." But boundary is fuzzy
- **Testable:** Vary intake question count (2 vs. 5 vs. 8) for same task, measure success. Find the knee in the curve

### Category 5: Emergence and Feedback
- When an agent hits a wall and asks an unanticipated question, that's a discovered question. How to capture and promote these?
- Do discovered questions stabilize after N runs in a domain? If yes, domain profiles are learnable
- **Testable:** After 20-30 runs per domain, check if discovered question set converges. Convergence = learnable. Divergence = domain too broad, needs sub-classification

---

## Open Design Decisions

1. **Should the structured brief be the versioned unit (so you can re-run same intent through different pipelines) or should TaskPayloads be versioned?** Recommendation: version the brief. It's the human-legible artifact and the natural unit for A/B comparison.

2. **Should the Intake node use an agent for elicitation, or should it be purely rule-based?** Recommendation: slot-configurable. `intake_mode: 'structured' | 'conversational'`. Start with structured, add conversational as an experiment.

3. **How does the PipelineConfig type relate to the existing VariantConfig?** A PipelineConfig is a superset — it includes everything in VariantConfig plus intake mode, gate config, decomposition strategy, and review policy.

4. **Where do domain readiness profiles live?** Probably as JSON files alongside task files, or in a `profiles/` directory. They're learned artifacts, not source code.

---

## Next Steps

1. Define `PipelineConfig` and `StructuredBrief` types
2. Wire ReadinessGate + QuestionGenerator into the launch flow (pre-run, not post-failure)
3. Build minimal Intake wizard (Concept A) with instrumentation hooks
4. Add mid-execution question logging to RunEngine
5. After 20-30 runs: mine discovered questions, assess whether domain profiles emerge
