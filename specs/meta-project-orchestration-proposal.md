# Meta-Project Orchestration — Proposal
**Task:** task-028
**Status:** PROPOSAL — Awaiting operator review
**Date:** 2026-03-31
**Dependencies:** task-024 (task taxonomy), task-025 (question flow), task-026 (flow templates), task-027 (ambiguity resolution)

---

## Problem

Currently, getting work into CRUCIBLE requires the operator to:
1. Manually write a JSON task payload (or a tasks.jsonl entry).
2. Hand-craft the `instructions` field with sufficient context.
3. Manually assess readiness (partially automated in Phase 7A/7B, but only at launch time).
4. Manually pick a strategy and agent backend.

There is no layer that takes a human idea — "fix this bug", "add dark mode", "can we add WebSockets?" — and produces execution-ready tasks. The operator does this entirely by hand.

This is CRUCIBLE's biggest bottleneck at scale. The execution pipeline is capable and well-instrumented. The intake pipeline doesn't exist.

---

## Current State

### What Exists

**Task infrastructure:**
- `tasks.jsonl` — planning-layer queue (metadata, status, phase gates, blockers)
- `TaskPayload` — execution-layer payload (description, instructions, seedDir, checks, files)
- `POST /api/runs` — launches a run from a TaskPayload

**Readiness infrastructure:**
- `ReadinessGate` — 6 checks + deep analysis
- `QuestionGenerator` — maps failed checks to structured questions
- `LaunchForm` — pre-flight enrichment UI (Phase 7A/7B complete)

**Decomposition infrastructure:**
- D0Strategy — no decomposition (single agent)
- D4Strategy — LLM-driven module decomposition (produces graph)
- D5Strategy — adaptive (D0 first, D4 on failure)
- `StrategySelector` — cascade logic (heuristics → strategy suggestion)

**Gap between planning and execution:**
- No API to create tasks in `tasks.jsonl` from the UI
- No link between a `tasks.jsonl` entry and the run(s) that executed it
- No mechanism to decompose a high-level intent into multiple task queue entries
- No "planning agent" that helps the operator structure work

### The Intent-to-Task Gap

What a human says:
> "Fix the pricing bug — 20% discount codes return wrong totals."

What a TaskPayload needs:
- `description` — ✓ derivable
- `instructions` — the detailed how-to; needs: root cause hypothesis, scope boundary, reproduction steps, affected files, verification command
- `checks` — at least one executable acceptance check
- `seedDir` — which project directory to use

The gap: `instructions`, `checks`, and `seedDir` require either operator effort or a planning agent to fill in.

---

## Proposed Design

### The Meta-Project Layer: Three-Step Pattern

```
[Operator Intent]
        ↓
  1. INTAKE — Capture + structure the intent
        ↓
  2. ENRICH — Resolve ambiguity via readiness gates + questions
        ↓
  3. SHAPE — Produce execution-ready task(s)
        ↓
  [Task Queue — ready to execute]
```

Each step can be partially automated. The operator's role shrinks as the system learns domain patterns.

---

### Step 1: Intake

**What happens:** Operator expresses intent. System captures it and adds ambient context.

**Inputs:**
- Free text description (required)
- Work intent selection: Bug fix / Feature / Exploration / Assessment / Refactor (required)
- Project selection (optional — if absent, system uses active project)

**Ambient context (automated):**
- Look up existing tasks.jsonl entries related to this intent (keyword match on description)
- Check for prior runs in the same project domain
- Infer likely `seedDir` from project selection

**UI location:** A new "Plan work" entry point. Options for where:
- Button on the Projects page ("+ New task" per project)
- A dedicated `/plan` route with an intake form
- LaunchForm in "planning mode" vs. current "execution mode"

**Recommendation:** Extend LaunchForm with a "Planning mode" toggle. Planning mode shows the intake step flow; execution mode is the current direct-launch flow. This avoids adding a new page while keeping the UX paths distinct.

**Output of Step 1:**
- Structured intent record: `{ description, workIntent, projectName, seedDir, relatedTasks, timestamp }`
- This feeds directly into Step 2.

---

### Step 2: Enrich

**What happens:** ReadinessGate runs against the raw intent. Gaps surface as targeted questions. Operator answers. Questions and answers together build the `instructions` field.

This is Phase 7A/7B — already built. What's needed for the meta-project layer:

1. **Flow-specific questions** (from task-026) are added based on the selected work intent.
2. **A structured brief** is assembled from the answers — a human-readable intermediate artifact the operator can read and correct before proceeding.
3. **Optional planning agent** — for complex intents, an LLM agent can run a lightweight "scoping" pass before full execution. It reads the codebase, proposes a structured brief, and asks targeted questions. The operator reviews the brief, corrects it, and confirms.

**The Structured Brief:**
A human-readable document produced at the end of Step 2. Contains:
- Work intent + flow type
- Goal statement (operator's words, operator-confirmed)
- Scope: files/modules expected to change
- Acceptance criteria (or exploration question, or assessment dimensions)
- First milestone
- Known risks or unknowns

The brief is the artifact the operator edits and confirms. Once confirmed, Step 3 runs automatically.

**Structured brief storage:** In the task queue entry (a new `brief` field on tasks.jsonl). This makes the brief queryable and version-trackable.

---

### Step 3: Shape

**What happens:** The confirmed brief → execution-ready `TaskPayload`(s). This step is mostly automated.

**Simple case (D0-suitable tasks):** Brief → single TaskPayload. System fills:
- `description` from goal statement
- `instructions` from brief + enrichments + flow template rules
- `checks` proposed based on flow type (e.g., bugfix → reproduction test command)
- `seedDir` from project selection

Operator reviews the TaskPayload preview (not the raw JSON — a readable card) and confirms or edits.

**Complex case (D4-suitable tasks):** Brief → decomposition. System runs D4Strategy on the brief to propose a task graph. Each node in the graph becomes a separate tasks.jsonl entry with its own brief, scope, and checks.

Operator sees the proposed task graph, can merge/split/reorder nodes, then confirms. The confirmed tasks land in the queue.

**Output of Step 3:**
- One or more `tasks.jsonl` entries (status: `pending`, `flowPhase: 'spec'`)
- Each entry has a `brief` field and enough context to generate a TaskPayload at execution time
- Each entry is linked to the parent brief via a `briefId` field

---

### Operator Role vs. Automated

| Step | Decision | Automated | Operator-guided | Fully manual |
|------|---------|-----------|----------------|--------------|
| Intake | Enter description | Ambient context lookup | Work intent selection | Initial text |
| Enrich | Fill gaps | Readiness check, question generation | Answer questions, review brief | Edit brief free-form |
| Shape (D0) | Produce TaskPayload | Fill instructions, propose checks | Review + confirm | Edit checks manually |
| Shape (D4) | Decompose into sub-tasks | Run D4Strategy, produce graph | Review graph, merge/split | Author sub-tasks manually |
| Queue | Add to task queue | — | Confirm queue entry | — |
| Execute | Run the task | Full execution | Strategy override, "launch anyway" | — |
| Review | Assess results | — | Accept/reject/iterate | Write follow-up tasks |

**The operator's core job is:** (a) expressing intent, (b) answering targeted questions, (c) reviewing and confirming the shaped output. Everything else is automated.

---

### Task Queue Connection

**Problem today:** `tasks.jsonl` entries and `POST /api/runs` are disconnected. A run doesn't know which task created it. A task doesn't know which runs executed it.

**Proposed linkage:**

1. `tasks.jsonl` entry gains a `runIds: string[]` field — list of runs that executed this task.
2. `POST /api/runs` accepts an optional `taskId` parameter. When provided, the run is linked to the task.
3. When a run completes, `PATCH /api/session/tasks/:id` is called to:
   - Add the runId to `runIds`
   - Update `status` to `in_progress` (first run) or stay `in_progress` (retry)
   - (Operator then manually marks `complete` via the task status UI from existing memory)

**New endpoints needed:**

```
POST   /api/session/tasks           — create task in queue
PATCH  /api/session/tasks/:id       — update task (status, phase gates, brief)
GET    /api/session/tasks/:id       — get single task details + linked runs
```

The existing `GET /api/projects` already aggregates tasks.jsonl. The write endpoints are missing.

---

### Planning Agent (Optional, Later Phase)

For complex intents, the "planning mode" can invoke a lightweight LLM agent before the operator answers questions. The planning agent:
- Reads the project codebase (seedDir)
- Proposes a structured brief (fills in scope, suggests checks, identifies related code)
- Returns a pre-filled intake form

The operator sees the proposed brief, makes corrections, and confirms. The agent reduces the operator's cold-start burden for unfamiliar codebases.

This is an `exploration` flow agent run under the hood — a diagnostic pass that produces a brief rather than code changes. It uses the existing agent infrastructure (claude-cli backend, D0 strategy).

**When to invoke:** Opt-in button "Help me scope this" in the intake form. Not automatic — the planning agent costs tokens and time.

---

## UI Sketch

**Current LaunchForm (Execution Mode):**
Description → Instructions → ReadinessGate → Strategy → Launch

**Proposed LaunchForm (Planning Mode):**
```
[ Plan ]  [ Execute ]   ← toggle at top

Planning Mode:
  1. Intent
     - Description (free text)
     - Work intent: [ Bug fix ▼ ]
     - Project: [ CRUCIBLE ▼ ]

  2. Enrich (ReadinessGate, flow-specific)
     - Required checks surface as questions
     - Operator answers
     - "Help me scope this" button (optional planning agent)
     - Brief preview (collapsible)

  3. Shape
     - "Suggested approach: D0 — single task"
     - Preview card: description, scope, checks
     - [ Edit ] [ Add to Queue ] buttons
     - OR: "Suggested approach: D4 — 3 sub-tasks"
     - Graph preview
     - [ Edit graph ] [ Add all to Queue ]
```

**Projects page:**
- Each project shows a "+ Plan work" button that opens LaunchForm in planning mode, pre-filled with that project.
- Task rows gain a "Run →" button that opens LaunchForm in execution mode, pre-filled from the task.

---

## Open Questions

1. **Should planning mode produce tasks.jsonl entries or TaskPayloads directly?**
   Tasks.jsonl entries enable operator review and phase-gate tracking. TaskPayloads are simpler but bypass the queue. Recommendation: tasks.jsonl entries. The queue is the source of truth.

2. **How does the planning agent interact with the execution agent?**
   Both use the same agent infrastructure. The planning agent runs a lightweight scoping pass (D0, low token budget, read-only). It should not make code changes. How is "read-only" enforced? Options: (a) prompt instructions only, (b) sandbox without write permissions, (c) standard sandbox + checks that reject non-empty diffs. Recommendation: (c) — add an acceptance check that verifies no files were modified.

3. **How does decomposition at planning time relate to decomposition at execution time?**
   D4Strategy at execution time decomposes *for the purpose of parallel execution* — it creates graph nodes that run concurrently. D4 at planning time creates *separate queue entries* that the operator manages independently. Are these the same operation or different? Recommendation: same underlying D4Strategy, different output format. Planning D4 produces tasks.jsonl entries. Execution D4 produces graph nodes.

4. **Who owns the structured brief once it's written?**
   The brief is in tasks.jsonl. When the task is executed, the brief becomes part of the run's instructions. If the run produces new information (e.g., scope was wrong), should the brief be updated? Recommendation: the run record stores the *executed brief* (snapshot at launch time). The original brief in tasks.jsonl can be edited for re-runs, but the snapshot is preserved for audit.

5. **Should the meta-project layer support multi-project tasks?**
   Some tasks span multiple projects (e.g., "update the API contract and update the client that consumes it"). Tasks.jsonl is per-project. How does the meta-project layer handle cross-project work? Recommendation: out of scope for this proposal. Model it as two linked tasks in two projects, with one in `blockedBy` the other.

6. **When should the planning agent be invoked automatically vs. opt-in?**
   Automatic invocation risks unexpected token usage and latency. Opt-in requires operator initiative. Recommendation: show "Help me scope this" prominently but keep it opt-in. After 10-15 uses, evaluate whether automatic invocation would have helped.

7. **How does this connect to the Concept C graph-first design in ux-pipeline-design.md?**
   `ux-pipeline-design.md` envisions the meta-flow as a configurable graph (Intake → Readiness Gate → Execution → Review). This proposal is building the Intake node and the connections to the existing Readiness Gate and Execution nodes. The graph canvas (Concept C) is a future rendering of this same data model. The data model designed here should be serializable into a `PipelineConfig` type that the graph canvas can eventually render.

---

## Dependencies on Other Proposals

- **task-024 (Task Taxonomy):** The meta-project layer creates meta-project-layer tasks. The `layer: 'meta-project'` field (from task-024) distinguishes planning tasks from execution tasks in the queue.
- **task-025 (Agent Question Flow):** The enrichment step generates questions. The question flow design from task-025 defines how those questions are answered, persisted, and fed back.
- **task-026 (Intent-Based Flow Templates):** Work intent selection drives flow-specific enrichment questions in Step 2. This proposal assumes task-026 defines those questions.
- **task-027 (Ambiguity Resolution):** Option C hybrid adopted — pre-flight is the primary resolution layer (this proposal), with escalation as escape hatch.

---

## Implementation Priority

| Phase | Scope | Effort |
|-------|-------|--------|
| **1** | Write endpoints (`POST /api/session/tasks`, `PATCH /api/session/tasks/:id`) | ~1 day |
| **2** | Run↔task linkage (`taskId` on runs, `runIds` on tasks.jsonl) | ~1 day |
| **3** | LaunchForm planning mode toggle (intake + enrich steps only) | ~2 days |
| **4** | Structured brief assembly + preview | ~2 days |
| **5** | Shape step: D0 TaskPayload preview + "Add to Queue" | ~2 days |
| **6** | Shape step: D4 task graph preview + multi-task creation | ~3 days |
| **7** | Optional planning agent ("Help me scope this") | ~3 days |
