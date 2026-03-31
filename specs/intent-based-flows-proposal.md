# Intent-Based Flow Templates — Proposal
**Task:** task-026
**Status:** PROPOSAL — Awaiting operator review
**Date:** 2026-03-31
**Dependencies:** task-027 (ambiguity resolution — which questions are load-bearing per flow)

---

## Problem

CRUCIBLE has three flow templates (debug, feature, refactor) implemented in `src/session/flow-templates.ts` and three corresponding skills in `THE_FACTORY/.claude/skills/`. These cover common work types but leave two important intents unsupported:

- **Exploration** ("Is X possible?") — no flow, no entry questions, no defined output
- **Assessment** ("How is this section working?") — no flow, no metrics framework, no baseline model

Beyond the missing flows, the existing flows have a structural gap: **ReadinessGate checks are flow-agnostic**. All 6 checks run regardless of intent. This means a bugfix task is asked for "acceptance criteria" (irrelevant — a failing test is the criterion) and an exploration task is penalized for lacking a "verification command" (not applicable — the output is a findings document, not a test suite).

---

## Current State

### Existing Flows

| Flow | Trigger signals | Phases | Key upfront resolution |
|------|----------------|--------|----------------------|
| **debug** | fix, broken, failing, error, regression | Reproduce → Isolate → Diagnose → Fix → Verify | Reproduction test exists? Scope? Risk level? |
| **feature** | implement, add, create, new, build, feature | Intent → Spec → Plan → Implement → Test → Verify | Acceptance criteria? Stakeholder? Scope? Constraints? Non-goals? |
| **refactor** | refactor, extract, consolidate, simplify | Scope → Snapshot → Transform → Verify | Behavior preservation criteria? Baseline tests? Structural goals? |

### What's Missing

1. **`exploration` flow** — "Is X possible?" — no phases, no entry questions, no output definition
2. **`assessment` flow** — "How is this section working?" — no phases, no metrics model, no baseline framework
3. **`brainstorm` flow** — referenced in CLAUDE.md trigger table but file doesn't exist
4. **Flow-aware ReadinessGate** — checks don't know which flow is active; apply generically
5. **LaunchForm intent → flow mapping** — `taskIntent` dropdown has "Implementation" and "Diagnostic" but no flow type selector

### FlowType Definition (Current)

```typescript
// src/session/types.ts
export type FlowType = 'debug' | 'feature' | 'refactor';
```

---

## Proposed Design

### Extend FlowType

```typescript
export type FlowType = 'debug' | 'feature' | 'refactor' | 'exploration' | 'assessment';
```

### New Flow: Exploration

**Intent:** "Is X possible?" — investigate feasibility, compare approaches, or answer a technical question.

**Key distinction from feature/debug:** Success is *answering the question*, not shipping code. There may be no code changes. The output is a findings document, not a test result.

**Entry Questions (must be answered before execution):**

| Question | Binding | Why it's load-bearing |
|---------|---------|----------------------|
| What is the exploration question, phrased precisely? | REQUIRED | Vague questions produce vague answers. Precision makes the output evaluable. |
| What evidence would constitute a "yes" answer? A "no" answer? | REQUIRED | Defines when the exploration is done. Without this, agents explore indefinitely. |
| What is the token/time budget for this exploration? | WAIVABLE | Prevents runaway exploration. Default: medium (2-4hr equivalent). |
| What assumptions or prior work are we starting from? | ADVISORY | Prevents re-exploring known ground. |
| Are there approaches that are out of scope? | ADVISORY | Avoids known dead ends. |

**Phases:**

1. **Frame** — Confirm the question is answerable. Narrow scope. Identify evidence sources.
2. **Research** — Read code, docs, prior runs. Collect evidence.
3. **Hypothesize** — Form initial answer with confidence level.
4. **Validate** — Test hypothesis. Run experiments or trace code paths.
5. **Document** — Write findings: answer + evidence + confidence + follow-on implications.

**Output artifact:** A structured findings document with:
- Answer (yes/no/conditional)
- Evidence collected
- Confidence level (high/medium/low + reasoning)
- Follow-on implications (e.g., "If yes → create task-X to implement")
- Approaches that were ruled out

**ReadinessGate mapping:**
- `has_scope_boundary` ✓ (REQUIRED — what are we exploring?)
- `has_acceptance_criteria` — **SKIP** (not applicable; replace with `exploration_question_clear`)
- `has_verification_command` — **SKIP** (not applicable; exploration output is a document)
- `risk_classified` — **SKIP** (exploration is always low-risk by definition)
- `no_ambiguous_terms` ✓ (ADVISORY — still useful)
- **NEW:** `exploration_question_clear` (REQUIRED) — question is specific and answerable

**Decomposition strategy:** Always D0 (freedom to follow leads). Same reasoning as diagnostic tasks. D4 only if multiple independent sub-questions need parallel research.

---

### New Flow: Assessment

**Intent:** "How is this section working?" — measure quality, identify gaps, compare against baseline.

**Key distinction from debug:** No known bug. The question is "are there bugs / risks / debt we don't know about?" Output is a scorecard + recommendations, not a fix.

**Entry Questions (must be answered before execution):**

| Question | Binding | Why it's load-bearing |
|---------|---------|----------------------|
| What section or component are we assessing? | REQUIRED | Unbounded assessment produces unfocused findings. |
| What dimensions matter for this assessment? | REQUIRED | Options: correctness, performance, maintainability, security, coverage, API surface stability. Must pick at least one. |
| What is the success baseline? | WAIVABLE | Prior assessment, SLA, industry standard, or "no known regressions." Without baseline, assessment is relative to nothing. |
| What will we measure (tools, commands, metrics)? | WAIVABLE | Operationalizes the dimensions. If absent, agent must infer. |
| What is the decision threshold? | ADVISORY | "Pass" vs. "needs remediation." Helps the agent produce an actionable verdict. |

**Phases:**

1. **Inventory** — Map the section: entry points, dependencies, owned paths, test coverage.
2. **Measure** — Run diagnostics: test suite, linters, type checker, coverage tool, profiler (as appropriate to chosen dimensions).
3. **Analyze** — Interpret results against baseline. Flag gaps. Identify risk hotspots.
4. **Report** — Write assessment: section summary, dimension scores, findings, recommendations.

**Output artifact:** Assessment report with:
- Section overview (what it does, key paths)
- Dimension scores (per chosen dimension: green/amber/red + evidence)
- Findings list (specific issues with severity)
- Recommendations (what to fix, prioritized)
- Suggested follow-on tasks

**ReadinessGate mapping:**
- `has_scope_boundary` ✓ (REQUIRED — what section?)
- `has_acceptance_criteria` — **SKIP** (assessment is not criteria-driven)
- `has_verification_command` — **SKIP** (assessment runs its own tools; no external test suite required)
- `risk_classified` — **SKIP** (assessment is zero-risk — no code changes)
- `no_ambiguous_terms` ✓ (ADVISORY)
- **NEW:** `assessment_scope_defined` (REQUIRED) — section + dimensions are both specified

**Decomposition strategy:** D0 for single-section assessments. D4 if assessing cross-section interactions (multiple sections assessed in parallel, combined into a synthesis).

---

### Flow-Aware ReadinessGate

The gate needs to know which flow is active so it can skip inapplicable checks and add flow-specific ones.

**Proposed mechanism:** Pass `flowType` to `ReadinessGate.assess()`:

```typescript
async assess(
  task: TaskPayload,
  config: ReadinessGateConfig,
  flowType?: FlowType
): Promise<ReadinessAssessment>
```

**Check applicability matrix:**

| Check | debug | feature | refactor | exploration | assessment |
|-------|-------|---------|----------|-------------|-----------|
| `has_acceptance_criteria` | skip | REQUIRED | skip | skip | skip |
| `has_scope_boundary` | REQUIRED | REQUIRED | REQUIRED | REQUIRED | REQUIRED |
| `has_verification_command` | REQUIRED | REQUIRED | REQUIRED | skip | skip |
| `dependencies_resolved` | WAIVABLE | WAIVABLE | WAIVABLE | skip | skip |
| `risk_classified` | WAIVABLE | WAIVABLE | WAIVABLE | skip (always low) | skip (always zero) |
| `no_ambiguous_terms` | ADVISORY | ADVISORY | ADVISORY | ADVISORY | ADVISORY |
| `exploration_question_clear` | — | — | — | REQUIRED | — |
| `assessment_scope_defined` | — | — | — | — | REQUIRED |

**Implementation:** The gate reads the applicability matrix, skips checks marked "skip" for the active flow, adds flow-specific checks. Score is computed only over applicable checks.

---

### LaunchForm: Intent → Flow Selection

Currently `taskIntent` has two options: "Implementation" and "Diagnostic". This maps to StrategySelector but not to FlowType.

**Proposed UI:**

Replace the current `taskIntent` dropdown with two controls:

1. **Work intent** (drives flow selection):
   - Bug fix
   - New feature
   - Refactor
   - Exploration (Is X possible?)
   - Assessment (How is this working?)

2. **Execution strategy** (drives decomposition, currently strategy dropdown):
   - Auto-select (recommended — driven by deep analysis)
   - Single-agent (D0)
   - Decomposed (D4)

When the operator selects a work intent:
- The correct flow template is loaded.
- The ReadinessGate recalculates with flow-specific checks.
- Entry questions for that flow appear inline (pre-flight enrichment).
- The StrategySelector default is updated (exploration → D0, assessment → D0, etc.).

**Backward compatibility:** "Implementation" maps to "feature", "Diagnostic" maps to "debug". Existing runs are unaffected.

---

### Brainstorm Flow (Deferred)

The brainstorm skill is referenced in CLAUDE.md but the file doesn't exist. Brainstorm is a meta-level activity (generating ideas, not executing them) that doesn't map cleanly to the task execution model. It's better treated as a meta-project activity in task-028's orchestration layer. Defer brainstorm flow definition to task-028.

---

## Entry Ambiguity Matrix

Summary of what each flow must resolve before execution can start:

| Intent | Load-bearing questions | What agent can't infer |
|--------|----------------------|----------------------|
| **Bug fix** | Reproduction test exists? Which files? Risk level? | Whether the bug is real and reproducible |
| **Feature** | Acceptance criteria? Stakeholder? Scope? Non-goals? | What "done" looks like; what NOT to build |
| **Refactor** | Behavior preservation criteria? Baseline tests pass? Structural goals? | What counts as behavior change |
| **Exploration** | Precise question? Evidence definition? Budget? | When to stop; what counts as an answer |
| **Assessment** | Section? Dimensions? Baseline? Measurement tools? | What good looks like; what to measure |

---

## Open Questions

1. **How many entry questions is too many?**
   The UX research in `ux-pipeline-design.md` poses this directly: "Vary intake question count (2 vs. 5 vs. 8) for same task, measure success. Find the knee in the curve." The question lists above have 4–5 items per flow. Is that the right ceiling? Recommendation: start with 3 required + 2 advisory, add more only when run failures point to specific missing context.

2. **Should flow selection be operator-chosen or auto-detected?**
   Current system has keyword-based flow routing (CLAUDE.md trigger table). Should CRUCIBLE auto-select the flow based on task description keywords, with operator confirmation? Recommendation: auto-detect and show as a pre-filled dropdown. Operator confirms or overrides. Never silently assign.

3. **What is the output format for exploration findings?**
   Should the agent produce structured JSON (machine-readable, can feed into subsequent tasks) or prose markdown (human-readable)? Recommendation: prose markdown with a structured header block (answer, confidence, follow-ons) so it's both readable and parseable.

4. **Should assessment outputs create follow-on tasks automatically?**
   If an assessment finds a security vulnerability, should it immediately create a bugfix task? Recommendation: assessment should *propose* follow-on tasks in its report, but the operator confirms before they're added to the queue. Auto-creation is too aggressive.

5. **How does the flow type interact with D5 (adaptive escalation)?**
   D5 strategy (try D0, escalate to D4 on failure) currently triggers unconditionally. For exploration and assessment, D5 escalation would be unusual — these are inherently D0. Should D5 be suppressed for these flows?

6. **Is brainstorm a flow or a meta-project activity?**
   Brainstorm doesn't produce a task result — it produces task *candidates*. That's a meta-project concern (task-028), not an execution flow. Confirm this classification before defining a brainstorm flow.

---

## Dependencies on Other Proposals

- **task-027 (Ambiguity Resolution):** The "which questions are load-bearing per flow" analysis is informed by whether ambiguity can be deferred to runtime (Option B/C) or must be resolved upfront (Option A). If Option C hybrid is adopted, fewer upfront questions are needed.
- **task-028 (Meta-Project Orchestration):** The intake wizard in task-028 will present flow selection as part of the task creation UX. This proposal defines what the flow selection populates.
- **task-025 (Agent Question Flow):** Exploration and assessment flows may produce execution-time escalations more frequently than feature/bugfix (the question space is harder to pre-enumerate). The escalation mechanism from task-025 is the escape hatch.

---

## Implementation Sketch

1. Add `exploration` and `assessment` to `FlowType` enum in `src/session/types.ts`.
2. Add flow templates for exploration and assessment to `src/session/flow-templates.ts`.
3. Extend `ReadinessGate.assess()` to accept optional `flowType` parameter. Build applicability matrix.
4. Add `exploration_question_clear` and `assessment_scope_defined` checks to ReadinessGate.
5. Update StrategySelector to handle `exploration` and `assessment` task intents (both → D0).
6. Update LaunchForm `taskIntent` dropdown: expand to 5 options, map to flow type.
7. Update phase-7A enrichment logic to load flow-specific entry questions.
