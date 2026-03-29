---
status: REVISED
created: 2026-03-28
revised: 2026-03-28
project: CRUCIBLE
phase: 7A
title: Readiness Gate UX — Pre-Flight Feedback with Inline Q&A
---

# Phase 7A: Readiness Gate UX

## 1. Problem Statement

CRUCIBLE's `ReadinessGate` runs 6 checks and produces rich per-check results (rule name, binding
tier, pass/fail, detail string). None of this is surfaced in the UI. The current launch flow goes
directly from "fill form" to "run" with no feedback on task quality.

Additionally, `LaunchForm` exposes all configuration fields at the same visual weight — there is no
distinction between the 3 decisions that matter every run (description, agent, strategy) and the 2
operational knobs that rarely change (budget, TTL).

This spec covers:
1. A `POST /api/readiness` endpoint exposing the gate as a stateless API
2. A `waivable` binding tier on `ReadinessCheck`
3. An inline `ReadinessGatePanel` component with an extension slot for Phase 7B
4. A progressive-disclosure refactor of `LaunchForm` including a strategy dropdown
5. An enrichment model: operator answers augment the task payload
6. A "Launch anyway" bypass for experimentation workflows

---

## 2. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Gate posture | Informative, not blocking. "Launch anyway" always available. | CRUCIBLE is an experimentation tool. The gate should surface task quality issues, not prevent experimentation. |
| Trigger model | 1.5s idle (no keystrokes for 1.5s triggers evaluation) | Stable results. Operator finishes a thought, checks update once. No flickering mid-typing. |
| Answer behavior | Re-evaluate for most checks; waive-with-justification for `dependencies_resolved` | Re-evaluation confirms the answer resolves the check AND enriches the task payload the agent receives. |
| Answer storage | Separate `enrichments` map — never mutates the instructions textarea | Keeps user intent and clarifications visually distinct. Merged at run submission. |
| Enrichment labels | Human-readable ("Acceptance Criteria", not "has_acceptance_criteria") | Internal rule names never appear in the UI. |
| Strategy field | Explicit dropdown in LaunchForm (D0/D4/D5), default D0 | 7B will pre-fill this with a suggestion; 7A establishes the field and passes it through to RunEngine. |
| Waivers storage | Run metadata JSON blob, not a dedicated DB column | No query use case yet. Avoids premature schema changes. |

---

## 3. Binding Tiers

The current `ReadinessCheck.binding` type (`'hard' | 'advisory'`) is extended to three tiers:

| Tier | Behaviour | UI |
|------|-----------|-----|
| `REQUIRED` | Blocks primary launch button; "Launch anyway" always available | Red badge; inline answer input on failure |
| `WAIVABLE` | Blocks primary launch; operator can waive with justification; "Launch anyway" always available | Amber badge; justification input + Waive button |
| `ADVISORY` | Never blocks anything | Blue badge; "Acknowledge" button on failure |

### Check tier assignments

| Check rule | Display label | Tier | Rationale |
|------------|--------------|------|-----------|
| `has_acceptance_criteria` | Acceptance Criteria | REQUIRED | Cannot verify completion without criteria |
| `has_scope_boundary` | Scope Boundary | REQUIRED | Risk of unbounded agent execution |
| `has_verification_command` | Verification Command | REQUIRED | No post-execution verification path. CRUCIBLE measures agent performance — without a check, the run produces no measurable outcome. |
| `risk_classified` | Risk Classification | WAIVABLE | Inferred from keywords; low penalty for wrong classification |
| `dependencies_resolved` | Dependencies | WAIVABLE | Important but sometimes runtime-discoverable; operator declares it |
| `no_ambiguous_terms` | Ambiguous Terms | ADVISORY | Agents can infer; human reviews output |

---

## 4. Interaction Model

### 4.1 Trigger

The gate panel appears as soon as `description` is non-empty. Evaluation fires after **1.5 seconds
of idle** (no keystrokes in description or instructions for 1.5s). This produces stable, non-
flickering results.

When an operator submits an answer to a failed check, re-evaluation is immediate.

### 4.2 Enrichment flow

```
operator types description + instructions
        │
        ▼ (1.5s idle)
POST /api/readiness
  body: { description, instructions, enrichments }
        │
        ▼
ReadinessGate.assess() on merged payload
        │
        ▼
6 check results rendered inline
        │
operator answers a failed check
        │
        ▼
enrichments[rule] = answer text
        │
        ▼ (immediate)
POST /api/readiness (with updated enrichments)
        │
        ▼
check re-evaluates — passes or remains failed
        │
        ▼
operator clicks Launch (or Launch Anyway)
        │
        ▼
POST /api/runs
  body: { ..., instructions: original + enrichment block, strategy, gateBypass?, gateSummary }
```

### 4.3 Enrichment formatting

The agent receives the original instructions plus a clearly-delimited block of operator
clarifications. Enrichments are formatted with human-readable headings:

```
---
Operator clarifications (provided during pre-flight readiness check):

[Acceptance Criteria]
The run passes if all 6 readiness checks return true and the gate score exceeds 0.95.

[Verification Command]
Run: npm test -- --testPathPattern=ReadinessGate
```

`buildEnrichedInstructions()` is a pure function that produces this block.

### 4.4 "Launch anyway" bypass

A secondary button is always visible: "Launch anyway". Clicking it:
1. Submits the run with current description/instructions (plus any enrichments already provided)
2. Logs the bypass to run metadata: `{ gateBypass: true, gateSummary: { passed: [...], failed: [...], waived: [...] } }`
3. No justification required — this is an experimentation tool, not an approval workflow

The primary "Launch" button is disabled until REQUIRED checks pass and WAIVABLE checks are
resolved. The secondary "Launch anyway" button is always enabled (when description is non-empty).

### 4.5 Waiver flow (WAIVABLE checks)

When a WAIVABLE check fails, the operator sees a text field with a placeholder like
"Why is this acceptable?" Submitting logs the justification to run metadata and marks the check
as waived. This enables the primary launch button for that check.

### 4.6 Advisory flow

ADVISORY checks show an "Acknowledge" button on failure. Clicking dismisses the warning.
No text input, no justification, no re-evaluation. The acknowledgment is logged but never blocks.

---

## 5. Backend Changes

### 5.1 Type change — `ReadinessCheck.binding`

**File:** `src/types/graph.ts`

```typescript
// Before
binding: 'hard' | 'advisory';

// After
binding: 'required' | 'waivable' | 'advisory';
```

Update `emptyReadiness()` and all check assignments in `ReadinessGate.ts`.

Migration: `'hard'` → `'required'`. `'advisory'` unchanged.

### 5.2 New endpoint — `POST /api/readiness`

**File:** `src/server/routes/readiness.ts` (new)

**Request body:**
```typescript
interface ReadinessRequest {
  description: string;
  instructions?: string;
  seedDir?: string;
  checks?: Array<{ name: string; type: 'exec'; command: string }>;
  enrichments?: Record<string, string>; // rule → operator answer
  deep?: boolean; // Phase 7B: when true, also run LLM-powered heuristic checks
}
```

**Response:**
```typescript
interface ReadinessResponse {
  assessment: ReadinessAssessment;
  passable: boolean; // all REQUIRED pass + WAIVABLE resolved
  deepChecks?: DeepCheck[]; // Phase 7B: present when deep=true
  strategy?: CascadeResult; // Phase 7B: present when deep=true
}
```

The `deep` flag and associated response fields are defined now so 7B doesn't require a new endpoint.
In 7A, `deep` is ignored and `deepChecks`/`strategy` are omitted from the response.

**Behaviour:**
1. Merge enrichments into the task payload before calling `assess()`.
2. Call `ReadinessGate.assess()` on the merged payload.
3. Return assessment + `passable` flag.

**Route registration:** Add to `src/server/index.ts`.

### 5.3 Run metadata — waivers and gate summary

**No new DB columns.** Waivers and gate bypass status are stored in the run metadata JSON blob
(the existing `task_json` TEXT column or a new `metadata` field on the run creation payload).

Schema stored in metadata:
```typescript
interface GateMetadata {
  gateBypass: boolean;
  gateSummary: {
    passed: string[];   // rule names
    failed: string[];
    waived: string[];
  };
  waivers: Array<{ rule: string; justification: string; timestamp: string }>;
  enrichments: Record<string, string>;
}
```

### 5.4 Strategy field on runs

`POST /api/runs` accepts a `strategy` field (`'D0' | 'D4' | 'D5'`, default `'D0'`).
This is passed through to `RunEngine` when starting the run. In 7A, the operator selects this
manually via the launch form dropdown. In 7B, deep analysis pre-fills the dropdown with a suggestion.

---

## 6. Frontend Changes

### 6.1 ReadinessGatePanel (new component)

**File:** `ui/src/components/ReadinessGatePanel.tsx`

Appears below the description/instructions fields, above the Advanced section.
Visible as soon as `description` is non-empty.

**Layout:**

```
Readiness  [4 / 6 passed]                          [checking...]
─────────────────────────────────────────────────────────────────
✅ REQUIRED  Acceptance Criteria
             3 acceptance check(s) defined

❌ REQUIRED  Verification Command
             No verification command or checks found
             ┌─────────────────────────────────────────────────┐
             │ What command verifies this task completed?      │
             │ e.g. npm test, pytest tests/                    │
             └─────────────────────────────────────────────────┘
             [Submit Answer]

⚠  WAIVABLE  Risk Classification
             Unable to infer risk classification from description
             [Waive: ___________________ ]

✅ REQUIRED  Scope Boundary
             seedDir: /Users/brach/...

⚠  WAIVABLE  Dependencies
             No declared dependencies (standalone task)        ✅ auto-passed

ℹ  ADVISORY  Ambiguous Terms
             Unqualified ambiguous terms: fast, clean
             [Acknowledge]
─────────────────────────────────────────────────────────────────
{extensionSlot — empty in 7A, 7B mounts deep analysis here}
```

**Extension slot:** The component accepts a `children` prop rendered below the fast checks section.
This is where Phase 7B's deep analysis section and strategy badge will mount. In 7A, nothing
renders in this slot.

**State managed in parent (LaunchForm):**

```typescript
interface GateState {
  assessment: ReadinessAssessment | null;
  enrichments: Record<string, string>;   // rule → answer
  waivers: Record<string, string>;       // rule → justification
  acknowledged: Set<string>;             // advisory rules operator dismissed
  loading: boolean;
}
```

**Props:**
```typescript
interface ReadinessGatePanelProps {
  assessment: ReadinessAssessment | null;
  enrichments: Record<string, string>;
  waivers: Record<string, string>;
  acknowledged: Set<string>;
  loading: boolean;
  onAnswer: (rule: string, answer: string) => void;
  onWaive: (rule: string, justification: string) => void;
  onAcknowledge: (rule: string) => void;
  children?: React.ReactNode; // extension slot for 7B
}
```

**Check row rendering rules:**
- REQUIRED + passed → green checkmark, label, detail text
- REQUIRED + failed → red X, label, detail text, text input + Submit button
- WAIVABLE + passed → amber badge, label, "auto-passed"
- WAIVABLE + failed → amber badge, label, detail, justification input + Waive button
- ADVISORY + passed → blue info, label, detail
- ADVISORY + failed → blue info, label, detail, Acknowledge button

**Counter:** `{passed + waived + acknowledged} / 6` in header.

**Loading state:** Spinner replaces counter during API call. Checks show their last state (no
flicker/collapse).

### 6.2 LaunchForm refactor

**File:** `ui/src/components/LaunchForm.tsx`

**Progressive disclosure layout:**

```
[Project context banner — if project launch]

─── Essential ────────────────────────────────────────────────
Description        [input]
Instructions       [textarea]
Agent              [dropdown: coder | claude-cli | docker-cli]
Strategy           [dropdown: D0 | D4 | D5, default D0]
Task Intent        [dropdown: Implementation | Diagnostic, default Implementation]

─── Readiness ────────────────────────────────────────────────
[ReadinessGatePanel — visible when description non-empty]
  {extension slot for 7B deep analysis}

─── Advanced ▶ ───────────────────────────────────────────────  (collapsed by default)
Token Budget       [100,000]   "Computed from task complexity"
TTL                [300s]
Variant Label      [input]
─────────────────────────────────────────────────────────────

[Launch]                                    [Launch anyway ▸]
```

**Launch button states:**
- `description` empty: both buttons disabled
- gate loading: primary disabled ("Checking..."), "Launch anyway" enabled
- gate not passable: primary disabled ("Resolve N check(s)"), "Launch anyway" enabled
- gate passable: primary enabled ("Launch"), "Launch anyway" hidden (primary covers it)

**"Launch anyway" visibility:** Shown only when the primary button is disabled. When the gate passes,
only the primary button is visible — no clutter.

**Advanced section collapsed summary:**
`Budget: 100K · TTL: 300s · Variant: default` visible even when collapsed.

### 6.3 LaunchForm data flow

```typescript
const handleSubmit = async (bypass: boolean = false) => {
  const enrichedInstructions = buildEnrichedInstructions(instructions, enrichments);
  await postRun({
    ...basePayload,
    instructions: enrichedInstructions,
    strategy,               // D0 | D4 | D5
    gateBypass: bypass,
    gateSummary: buildGateSummary(assessment, waivers, acknowledged),
    waivers: Object.entries(waiverState).map(([rule, justification]) => ({
      rule, justification, timestamp: new Date().toISOString()
    })),
  });
};
```

---

## 7. Files to Create

| File | Purpose |
|------|---------|
| `src/server/routes/readiness.ts` | `POST /api/readiness` endpoint (with `deep` flag reserved for 7B) |
| `ui/src/components/ReadinessGatePanel.tsx` | Inline check display + answer inputs + extension slot |

## Files to Modify

| File | Change |
|------|--------|
| `src/types/graph.ts` | Add `'waivable'` to `binding` union; rename `'hard'` → `'required'` |
| `src/engine/ReadinessGate.ts` | Update check binding assignments per tier table in §3 |
| `src/server/index.ts` | Register readiness route |
| `src/server/routes/runs.ts` | Accept `strategy`, `gateBypass`, `gateSummary`, `waivers` in run metadata |
| `ui/src/components/LaunchForm.tsx` | Progressive disclosure; strategy + taskIntent dropdowns; gate panel wiring; dual launch buttons |

---

## 8. Implementation Order

```
Step 1 — Type + backend (no UI changes yet)
  a. Extend ReadinessCheck.binding type ('required' | 'waivable' | 'advisory')
  b. Update ReadinessGate.ts check assignments per §3 tier table
  c. Implement POST /api/readiness route (with deep flag stub)
  d. Extend POST /api/runs to accept strategy + gate metadata
  e. npm test — all existing tests still pass (binding rename)

Step 2 — Gate panel component
  f. ReadinessGatePanel.tsx — check rows, tier badges, answer inputs,
     counter, extension slot (children prop)

Step 3 — LaunchForm refactor
  g. Progressive disclosure layout (essential / readiness / advanced)
  h. Add strategy dropdown (D0/D4/D5) and taskIntent dropdown
  i. Wire ReadinessGatePanel with 1.5s idle trigger
  j. Thread enrichments + gate metadata into postRun call
  k. Dual launch buttons (primary gated + "Launch anyway" bypass)
```

---

## 9. Non-Goals (Phase 7A)

- LLM-powered readiness checks — Phase 7B
- Deep analysis / heuristic checks — Phase 7B
- Strategy recommendation / pre-fill — Phase 7B
- PipelineStrip visual — deferred (see phase-7-deferred-items.md)
- Waivers DB column — deferred
- Saving/loading enrichments as templates — Phase 8
- Run comparison / scorecard — Phase 8
- Configuration version control — Phase 8
- Backend gate configuration via API — can remain in config

---

## 10. Test Coverage

Existing `ReadinessGate` tests in `src/test/phase1.test.ts` cover the 6 checks.
The binding rename from `'hard'` to `'required'` will require updating test assertions.

New tests needed:
- `POST /api/readiness` — valid request, empty description (400), enrichment merging
- `buildEnrichedInstructions()` — pure function, unit testable
- Re-evaluating with an enrichment that resolves a failing check returns `passed: true`
- Gate metadata correctly stored on run creation (bypass flag, summary, waivers)
