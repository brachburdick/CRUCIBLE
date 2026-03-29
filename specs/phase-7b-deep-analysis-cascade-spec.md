---
status: REVISED
created: 2026-03-28
revised: 2026-03-28
project: CRUCIBLE
phase: 7B
title: Deep Analysis & Strategy Suggestion
depends_on: phase-7-readiness-gate-ux-spec.md
---

# Phase 7B: Deep Analysis & Strategy Suggestion

## 1. Problem Statement

Phase 7A gives the operator feedback on task well-formedness (acceptance criteria, scope, verification).
It does not answer: **what does this task look like in terms of scope, and which strategy should I try?**

Empirical evidence (METR R²=0.83 on duration vs. success; SWE-bench file-count gap; Hassan's change
entropy) provides measurable task characteristics that inform strategy selection. But CRUCIBLE lacks
its own calibration data — thresholds borrowed from benchmarks are directional, not authoritative.

This spec adds:
1. **4 LLM-powered heuristic checks** that characterize a task (not gate it)
2. A **strategy suggestion** — a gray badge pre-filling the strategy dropdown, always overridable
3. An **opt-in trigger** — operator clicks "Run deep analysis" when they want it
4. Integration into 7A's extension slot in `ReadinessGatePanel`

The deep analysis tier is **purely informational**. It never blocks launch. It helps the operator
make an informed strategy choice.

---

## 2. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Deep analysis posture | Informational — shows task characteristics, never blocks | Borrowed heuristics aren't CRUCIBLE-calibrated. Show data, let operator decide. |
| Number of checks | 4 (duration, file count, change entropy, architectural scope) | Highest evidence quality. Lines-changed redundant with file count. Fix-on-fix needs VCS plumbing. Test-suite overlaps with fast checks. |
| Trigger | Opt-in "Run deep analysis" button, available after fast checks pass | Respects operator time. They may already know which strategy to use. |
| Strategy output | Gray suggestion badge pre-filling the strategy dropdown from 7A | Suggestion, not recommendation. Operator always explicitly selects. If ignored, we learn that too. |
| Cascade logic | Kept as pure function producing a suggestion, not a gate or auto-selector | Costs nothing to compute. Provides a starting point. Trivially overridable. |
| Task intent | Explicit dropdown in LaunchForm (established in 7A) | Most important cascade branch. Don't hide in keyword inference. |
| Results on edit | Clear results entirely, show "Run analysis" button again | Clean state > stale state. No ambiguity. |
| Endpoint | Extends `POST /api/readiness` with `deep: true` flag (from 7A) | Single endpoint. No overlapping schemas. No dependency confusion. |

---

## 3. Deep Analysis Checks (Tier 2)

All 4 checks are evaluated in a **single batched LLM call**. The prompt asks the model to return
a structured JSON object with all estimates at once.

### 3.1 Estimated human-equivalent duration

**Signal:** LLM estimates how long an experienced engineer familiar with the codebase would take.
**Levels:**
- <30 min → green, "single-agent viable"
- 30 min – 4 hr → amber, "consider decomposition"
- >4 hr → red, "strong candidate for decomposition + human review"
**Evidence:** METR R²=0.83; 50% success at ~1 hour for frontier models.
**Note:** Threshold will shift as models improve. METR's doubling rate (~7 months) means these
levels should be reviewed periodically or parameterized per model.

### 3.2 Estimated file count

**Signal:** LLM lists files the task would likely require modifying.
**Levels:**
- ≤3 files → green
- 4–10 files → amber
- >10 files → red
**Evidence:** SWE-bench single-file 90% vs. multi-file 54%; Amazon Q hard limit at 5.
**Display:** Level badge + file list in expandable detail.

### 3.3 Change entropy

**Signal:** Whether changes span multiple modules, packages, or architectural layers.
**Levels:**
- Single module → green, "low entropy"
- 2 modules → amber
- >2 modules → red, "cross-cutting"
**Evidence:** Hassan ICSE 2009; Kamei et al. confirmed diffusion metrics consistently important.

### 3.4 Architectural scope (binary flag)

**Signal:** Whether the task can be solved with local context or requires understanding system-wide
patterns, data flow, or invariants.
**Classification:** "Localized" vs. "Architectural"
**Evidence:** SWE-bench Hard correlates with architectural scope; Devin warns against architecture decisions.
**Display:** Single badge — either absent (localized, no flag needed) or shown as amber "Architectural — consider D4 with planning-first subtask."

---

## 4. Strategy Suggestion

### 4.1 Cascade logic (`StrategySelector.ts`)

A pure function that consumes the 4 deep check results + task intent and returns a suggestion.

```
Task enters cascade
  │
  ▼
taskIntent == 'diagnostic'?           ──yes──▶  D0
  │ no                                         "Diagnostic tasks need freedom to
  ▼                                             follow leads."

Duration <30 min AND ≤3 files?        ──yes──▶  D0
  │ no                                         "Within single-agent capability."
  ▼

Duration >4 hours?                    ──yes──▶  D4, flag: humanReviewRecommended
  │ no                                         "Exceeds 4-hour threshold."
  ▼

File count >10 OR entropy >2 modules? ──yes──▶  D4
  │ no                                         "Scale or spread exceeds
  ▼                                             single-agent window."

Architectural scope?                  ──yes──▶  D4, flag: planningFirstSubtask
  │ no                                         "Architectural tasks benefit from
  ▼                                             approach documentation first."

Default                               ────────▶  D0
                                               "No decomposition signals."
```

### 4.2 Output

```typescript
interface CascadeResult {
  suggested: 'D0' | 'D4';     // D5 is a runtime escalation, never pre-suggested
  reason: string;              // human-readable, shown in tooltip
  flags: {
    humanReviewRecommended: boolean;  // >4hr tasks
    planningFirstSubtask: boolean;    // architectural tasks
  };
}
```

### 4.3 How it surfaces in the UI

The strategy dropdown (from 7A) is pre-filled with the suggestion. A gray badge appears next
to the dropdown:

```
Strategy  [D4 ▾]    suggested: D4 — "Cross-cutting changes across 3 modules"
```

If the operator changes the dropdown, the badge updates to:

```
Strategy  [D0 ▾]    suggested: D4 (overridden)
```

The suggestion is **never highlighted in orange or red**. Gray text only. It's context, not a warning.

When `humanReviewRecommended` is true, a small note appears below: "Consider reviewing the
decomposition plan before execution."

---

## 5. Opt-In Trigger & UI Integration

### 5.1 Where it lives

Deep analysis mounts in the `ReadinessGatePanel`'s extension slot (`children` prop from 7A).

### 5.2 States

**Before fast checks pass:**
Deep analysis section is not visible.

**After fast checks pass, before running analysis:**
```
─── Deep Analysis ──────────────── [Run Deep Analysis ▶]
    Estimate task scope and suggest a strategy.
```

**While running:**
```
─── Deep Analysis ──────────────── ⏳ Analyzing...
    Estimating scope, complexity, and optimal strategy...
```

**After results:**
```
─── Deep Analysis ──────────────────────────────────────
    ℹ Duration: ~2 hr           (amber)
    ℹ Files: ~8                 (amber)
    ℹ Entropy: 3 modules        (red — cross-cutting)
    ℹ Scope: Architectural      (amber flag)
```

Compact display — small level-colored dots, not full rows. All 4 checks on 2-3 lines.

**After operator edits description/instructions:**
Deep analysis results clear. "Run Deep Analysis" button reappears.

### 5.3 Strategy dropdown interaction

When deep analysis completes, the strategy dropdown is pre-filled with the suggestion **only if
the operator hasn't already manually selected a strategy**. If they've touched the dropdown, the
suggestion appears as a badge but doesn't override their selection.

---

## 6. Backend Changes

### 6.1 Extend `POST /api/readiness`

**File:** `src/server/routes/readiness.ts` (extends 7A)

When `deep: true` is set in the request body, after running fast checks:
1. Build a batched LLM prompt with the task description, instructions, and enrichments
2. Parse the structured JSON response into `DeepCheck[]`
3. Run `selectStrategy()` on the deep check results + task intent
4. Return `deepChecks` and `strategy` alongside the fast check `assessment`

### 6.2 LLM prompt for batched estimation

A single structured prompt evaluates all 4 heuristics at once. The prompt includes:
- Task description and instructions (with enrichments merged)
- seedDir contents summary (if available — file listing, not full content)
- Request for JSON output matching `DeepCheck[]` schema

**Estimated token cost per call:** ~500 input + ~200 output = ~700 tokens total.
At Sonnet pricing this is <$0.01 per evaluation — negligible.

**Timeout:** 15 seconds max. If the LLM doesn't respond, return fast check results without
deep analysis. Show "Analysis timed out" in the UI.

### 6.3 `StrategySelector.ts` (new file)

**File:** `src/engine/StrategySelector.ts`

```typescript
interface CascadeInput {
  checks: DeepCheck[];
  taskIntent: 'implementation' | 'diagnostic';
}

interface CascadeResult {
  suggested: 'D0' | 'D4';
  reason: string;
  flags: {
    humanReviewRecommended: boolean;
    planningFirstSubtask: boolean;
  };
}

function selectStrategy(input: CascadeInput): CascadeResult
```

Pure function. No LLM calls, no side effects. Implements the decision tree from §4.1.

### 6.4 Deep check data model

```typescript
interface DeepCheck {
  heuristic: 'estimated_duration' | 'file_count' | 'change_entropy' | 'architectural_scope';
  value: string | number;     // '~2 hr' | 8 | 'high' | 'architectural'
  level: 'green' | 'amber' | 'red';
  detail: string;             // human-readable explanation
  evidence?: string;          // supporting data (e.g., file list)
}
```

### 6.5 Run metadata extension

`POST /api/runs` already accepts gate metadata from 7A. Extend to also store:
```typescript
{
  deepAnalysis?: DeepCheck[];       // snapshot for future comparison
  strategySuggested?: string;       // what cascade recommended
  strategySelected: string;         // what operator chose
}
```

This enables Phase 8's feedback loop: comparing pre-flight estimates to actual outcomes.

---

## 7. Files to Create

| File | Purpose |
|------|---------|
| `src/engine/StrategySelector.ts` | Pure function: cascade decision tree → strategy suggestion |

## Files to Modify

| File | Change |
|------|--------|
| `src/server/routes/readiness.ts` | Handle `deep: true` — LLM heuristics + strategy suggestion |
| `src/engine/ReadinessGate.ts` | Add `assessDeep()` method for LLM-powered heuristics |
| `ui/src/components/ReadinessGatePanel.tsx` | Mount deep analysis in extension slot (as a child component or inline) |
| `ui/src/components/LaunchForm.tsx` | Wire deep analysis trigger; connect suggestion to strategy dropdown |
| `src/server/routes/runs.ts` | Accept `deepAnalysis`, `strategySuggested` in run metadata |

---

## 8. Implementation Order

```
Step 1 — Strategy selector (pure logic, fully testable)
  a. StrategySelector.ts with cascade decision tree
  b. Unit tests: all paths, all threshold boundaries

Step 2 — LLM-powered deep checks
  c. ReadinessGate.assessDeep() — batched LLM prompt, returns DeepCheck[]
  d. Extend POST /api/readiness to handle deep=true
  e. Integration test: endpoint returns valid DeepCheck[] + strategy

Step 3 — Frontend deep analysis
  f. Deep analysis component mounted in ReadinessGatePanel extension slot
  g. "Run Deep Analysis" button, spinner, compact results display
  h. Wire strategy suggestion → dropdown pre-fill (respecting manual override)
  i. Clear-on-edit behavior

Step 4 — Run metadata
  j. Store deepAnalysis + strategySuggested + strategySelected in run metadata
```

---

## 9. Non-Goals (Phase 7B)

- Runtime auto-escalation (D0→D4 on failure) — deferred (see phase-7-deferred-items.md)
- Historical accuracy tracking per task profile — needs 50+ runs
- Task-type template library and template matching — Phase 8
- Data-driven strategy selection (logistic regression replacing rule-based cascade) — needs 50+ tasks
- Domain readiness profiles — Phase 8
- Missing-context vs. difficulty failure classifier — open research problem
- Lines-changed, fix-on-fix, test-suite-presence checks — cut (see phase-7-deferred-items.md)
- Anti-heuristic validation at execution time (DAG width check) — requires D4 execution

---

## 10. Test Coverage

**StrategySelector (unit):**
- D0 for diagnostic tasks regardless of other signals
- D0 for short/small tasks (duration <30min, ≤3 files)
- D4 for >4hr tasks with humanReviewRecommended flag
- D4 for >10 files or >2 modules
- D4 with planningFirstSubtask for architectural scope
- Default D0 when no signals
- Each threshold boundary (green/amber/red)

**POST /api/readiness with deep=true (integration):**
- Returns valid DeepCheck[] with all 4 heuristics
- Returns strategy suggestion
- Handles LLM timeout gracefully (returns fast checks only)
- Handles malformed LLM output gracefully

**ReadinessGate.assessDeep() (unit/integration):**
- LLM prompt produces parseable JSON
- Fallback on malformed output

---

## 11. Evidence Basis

| Heuristic | Source | Strength | CRUCIBLE-calibrated? |
|-----------|--------|----------|---------------------|
| Duration estimation | METR R²=0.83, 228 tasks | Strong | No — threshold is directional |
| File count | SWE-bench Verified + Pro, Amazon Q | Strong | No — threshold is directional |
| Change entropy | Hassan ICSE 2009, Kamei et al. | Strong | No — threshold is directional |
| Architectural scope | SWE-bench Hard, Devin docs | Moderate | No — binary classification |

All thresholds are configurable parameters. After 30+ CRUCIBLE runs with outcome data,
thresholds should be recalibrated against observed correlations rather than benchmark data.
