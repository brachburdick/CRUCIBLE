# Task Taxonomy & UI Layers — Proposal
**Task:** task-024
**Status:** PROPOSAL — Awaiting operator review
**Date:** 2026-03-31
**Dependencies:** task-025 (question flow), task-028 (meta-project orchestration)

---

## Problem

CRUCIBLE's UI conflates three fundamentally different types of work in a single task list:

- **Pipeline-level work** — Building and configuring the harness itself (type definitions, middleware, CLI entrypoint). Done rarely, affects the whole system.
- **Meta-project work** — Planning: decomposing intent into tasks, resolving ambiguity, deciding strategy. Done before execution.
- **Project-level work** — Executing tasks against a project's codebase. The current "main loop."

These layers have different workflows, different actors, different UI affordances. A bugfix task and a "design the intake wizard" task should not look identical in the task list. Currently they do.

---

## Current State

**Pages:** Dashboard (runs), Projects (tasks + questions), Session (metrics), Graphs, RunDetail.

**Task types in tasks.jsonl:** `feature`, `investigation`, `refactor`, `documentation`. These are intent types, not layer types — a "feature" task can appear at any layer.

**Layer indicators today:** None. The Projects page "All Tasks" tab shows a flat list filtered by status only. No field distinguishes pipeline vs. meta-project vs. project-level work.

**What the `flowPhase` field tracks:** Progress *within* a single task (spec → plan → implement → test → verify), not which layer the task belongs to.

**The Projects page already has structure:** Three tabs (Overview, All Tasks, Pending Questions) and a hierarchical project tree. This is the natural home for layer differentiation.

---

## Proposed Design

### Three-Layer Model

| Layer | Definition | Who creates tasks | Who executes | Examples from tasks.jsonl |
|-------|-----------|------------------|--------------|--------------------------|
| **Pipeline** | Harness infrastructure: types, middleware, CLI, CI, packaging | Maintainer | Claude or maintainer | task-001–015 (completed infrastructure) |
| **Meta-project** | Planning work: design, investigation, decomposition, ambiguity resolution | Operator | Claude (planning agents) | task-024–028 (this batch), task-022 (section contracts) |
| **Project** | Execution: implementing features, fixing bugs, refactoring within a project | Operator (via intake) | Claude (execution agents) | task-016–021 (phase 7A/7B features) |

### Layer Field

Add a `layer` field to tasks.jsonl entries:

```jsonc
{
  "id": "task-024",
  "layer": "meta-project",   // "pipeline" | "meta-project" | "project"
  "taskType": "investigation",
  "status": "in_progress",
  ...
}
```

**Inference rule for existing tasks (no migration needed immediately):**
- `taskType: "documentation"` or tasks in CRUCIBLE's own `.agent/tasks.jsonl` that predate projects → `pipeline`
- `taskType: "investigation"` → `meta-project`
- Tasks in a project's own `.agent/tasks.jsonl` → `project`
- Everything else → infer from description keywords or default to `project`

### UI Architecture: Filtered Views with Layer Sidebar

**Recommendation: Option C (filtered views) with a layer filter control.**

Keep the Projects page structure. Add a **layer filter** — three toggle buttons above the All Tasks tab:

```
[ Pipeline ]  [ Meta-Project ✓ ]  [ Project ✓ ]
```

Default: Meta-Project + Project visible. Pipeline hidden (it's infrastructure noise for most operators).

**Why not separate pages?** The layers are not independent workflows — a meta-project task often directly precedes a project task, and operators need to see the relationship.

**Why not tabs?** The current three-tab structure (Overview / All Tasks / Pending Questions) is already useful. Adding "Pipeline", "Meta-Project", "Project" as tabs would create too many tabs.

**Why not the full Option D (sidebar + tabs)?** Adds layout complexity without proportional clarity gain. The filter toggle is lighter and reversible.

### Visual Differentiation

Layer badges on task rows in the All Tasks tab:

```
[ Pipeline ]  Gray badge
[ Meta ]      Blue badge
[ Project ]   Green badge
```

Combined with existing `taskType` badges (feature, investigation, refactor) this gives full context at a glance.

### Dashboard: Keep Lean

Dashboard stays focused on runs. No layer filter needed there — all runs are project-level execution artifacts.

**One addition:** A "Planning in progress" widget on the Dashboard showing count of in-progress meta-project tasks. Links to the Projects page meta-project filter.

### Questions Split

The current "Pending Questions" tab mixes planning questions (raised during task creation, must be answered before execution) and execution questions (raised by a running agent, currently hypothetical). Split into:

- **Planning Questions** — pre-execution, synchronous
- **Execution Questions** — mid-run, async (see task-025)

This split is deferred until task-025 designs the execution question flow.

---

## Open Questions

1. **Should pipeline-layer tasks be visible to all operators, or only to CRUCIBLE maintainers?**
   If CRUCIBLE is used by non-maintainers, pipeline tasks are irrelevant noise. A "Show pipeline tasks" checkbox (hidden by default) may be sufficient rather than a full layer filter button.

2. **Should `layer` be explicit (written to tasks.jsonl) or inferred at read time?**
   Explicit is more robust; inferred avoids migration. Recommendation: infer at read time using the rule above until a task creation flow exists that sets it explicitly (task-028).

3. **Should the Projects page "Overview" tab show layer-aware counts?**
   Example: "CRUCIBLE: 3 meta-project, 12 project tasks pending." This is useful context but adds complexity to the overview cards.

4. **How does task provenance work?**
   When a meta-project planning agent decomposes a task into 3 sub-tasks, those sub-tasks are project-level. They should be linked to the parent meta-project task. The data model has `blockedBy` but no parent/child relationship. Does this need to be added?

5. **What happens to the "Pending Questions" tab during the split?**
   Should it become two tabs (Planning / Execution) or one tab with a filter? Deferred to task-025.

6. **Should "taskType" be renamed or replaced by "intent" now that `layer` exists?**
   `taskType` (feature/investigation/refactor/documentation) describes *what kind of work*, while `layer` describes *at which level*. Both are needed. The naming is slightly awkward — "taskType" is overloaded. Consider renaming to `workType` or `intent` in a future cleanup.

7. **Does the Dashboard need a "Meta-project" section?**
   If operators frequently switch between planning and execution, having a "planning in progress" summary on the Dashboard reduces navigation overhead. But it may add clutter. Defer until usage patterns are clearer.

---

## Dependencies on Other Proposals

- **task-025 (Agent Question Flow):** Required before implementing the question tab split.
- **task-028 (Meta-Project Orchestration):** The meta-project layer needs a task-creation flow before the `layer` field is set automatically. Until then, layer is inferred.
- **task-027 (Ambiguity Resolution):** Informs whether meta-project tasks need a distinct "awaiting clarification" status distinct from "pending."

---

## Implementation Sketch (Low Risk, Incremental)

1. Add `layer` field to tasks.jsonl entries for tasks 024–028 and future tasks. Infer for existing tasks.
2. Extend `GET /api/projects/tasks` to return `layer` field (read from JSON or inferred).
3. Add layer filter toggle to All Tasks tab in Projects.tsx.
4. Add layer badges to task row rendering.
5. (Later) Split Pending Questions tab when task-025 is resolved.
6. (Later) Add Dashboard planning widget when usage patterns emerge.
