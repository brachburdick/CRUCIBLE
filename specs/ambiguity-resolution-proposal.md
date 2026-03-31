# Ambiguity Resolution Strategy — Proposal
**Task:** task-027
**Status:** PROPOSAL — Awaiting operator review
**Date:** 2026-03-31
**Dependencies:** task-025 (execution escalation mechanism), task-026 (flow-specific pre-flight questions)

---

## Problem

Agents encounter ambiguity at two distinct moments:

1. **Before execution** — Task definition is incomplete or vague. ReadinessGate catches structural gaps (missing acceptance criteria, scope, verification command). But not all ambiguity is structural.

2. **During execution** — Agent discovers a decision fork. Multiple valid implementations exist. Scope turns out to be different than declared. A dependency assumption was wrong.

The question is: which moment should bear the resolution burden?

**The stakes:** Resolving too much upfront creates operator friction and is impossible for exploratory tasks. Resolving too little upfront means agents either guess wrong (wasted work) or stall.

---

## Current State

### What Resolves Ambiguity Today

**Pre-flight:**
- ReadinessGate 6 checks: `has_acceptance_criteria`, `has_scope_boundary`, `has_verification_command`, `dependencies_resolved`, `risk_classified`, `no_ambiguous_terms`
- QuestionGenerator: maps failed checks to structured operator questions
- LaunchForm enrichment: operator answers flow into task instructions
- Deep analysis (Phase 7B): estimates task complexity, suggests strategy

**At runtime:**
- `exitReason: { type: 'escalated'; question: string }` — defined in types, never triggered
- `RunResult: 'escalated'` — defined, never used
- D5Strategy — tries D0, re-decomposes with failure evidence on failure (this is a *recovery* mechanism, not an ambiguity resolution mechanism)
- Flow template rules: "after 2 failed attempts, escalate" — documented in system prompt, not enforced

**Nothing actively handles runtime-discovered ambiguity.** Agents either guess or their runs fail.

---

## Ambiguity Taxonomy

Understanding *what kind* of ambiguity is at play matters — different types need different resolution strategies:

| Type | Definition | Example | When discovered |
|------|-----------|---------|----------------|
| **Structural** | Required information is simply absent | No acceptance criteria; no scope boundary | Pre-flight (ReadinessGate catches) |
| **Decision** | Multiple valid implementations with different trade-offs | Redis vs. in-memory cache | Mid-execution |
| **Scope** | Agent doesn't know what's in/out | "Refactor the parser" — does that include the test files? | Pre-flight OR mid-execution |
| **Technical** | Correct approach is unclear given codebase constraints | The "obvious" approach conflicts with an existing pattern | Mid-execution |
| **Terminological** | Vague terms without measurable context | "Make it faster" | Pre-flight (advisory check) |
| **Emergent** | Ambiguity that only becomes visible after exploring the code | "The bug is in the pricing module" but pricing has 3 modules | Mid-execution |

**Key insight:** Structural and terminological ambiguity are consistently catchable pre-flight. Decision, technical, and emergent ambiguity are *inherently runtime discoveries* — no amount of pre-flight questioning can prevent them, because the information needed to ask the question only exists after the agent has looked at the code.

---

## Three Options

### Option A: All Upfront — Fix Task Creation

Invest heavily in pre-flight resolution so tasks are unambiguous before any agent runs.

**What this looks like:**
- More pre-flight questions (beyond the current 6 checks)
- Flow-specific question batteries (debug gets different questions than feature)
- Proactive scope discovery (static analysis before agent launch)
- Feedback loop: failed runs generate new pre-flight questions

**Evidence supporting A:**
- ReadinessGate + Phase 7A/7B already do this for structural ambiguity
- It works well — tasks with enriched instructions have higher success rates
- Pre-flight cost is paid once; execution cost is avoided entirely

**Evidence against A:**
- Impossible for exploration/assessment tasks (ambiguity is the *point*)
- Bootstrapping problem: first run on an unfamiliar codebase can't answer questions it hasn't asked yet
- Over-questioning causes operator abandonment
- Decision and technical ambiguity genuinely can't be answered before looking at the code

**Verdict:** A covers 70-80% of ambiguity cases well. It breaks down for the 20-30% that are runtime discoveries.

---

### Option B: All Runtime — Build Robust Handling

Accept that ambiguity is inevitable at runtime. Give agents mechanisms to pause, ask, and resume.

**What this looks like:**
- Agent-facing `escalate()` API
- GraphExecutor catches escalation, saves state, suspends node
- Operator answers asynchronously; node resumes with answer
- Attempt tracking and auto-escalation on repeated failure

**Evidence supporting B:**
- Types are already designed for this (`exitReason: 'escalated'`, `HumanTouches.questions`)
- QuestionQueue supports async ask/answer
- THE_FACTORY's own session protocol does this (write question, move to next task, next session picks up answer)
- Necessary for exploration/assessment flows where ambiguity is structural

**Evidence against B:**
- Over-escalation risk: agents without pre-flight context escalate on every minor uncertainty
- Every escalation adds latency (pause → operator response → resume)
- Resume complexity: sandbox state, partial mutations, context window shift
- Overnight autonomy requires operator to be available (or escalation quota exceeded → failure)

**Verdict:** B is necessary for the 20-30% runtime cases but insufficient as the *only* mechanism — pre-flight filtering is still worth doing.

---

### Option C: Hybrid — Upfront Foundation + Lightweight Escape Hatch

Pre-flight resolves the 70-80% that can be caught structurally. Runtime escalation handles the 20-30% that genuinely requires code exploration first.

**What this looks like:**
- ReadinessGate + Phase 7A/7B as the primary ambiguity resolution layer (already built)
- Flow-specific pre-flight questions reduce type-specific ambiguity (task-026)
- Runtime `escalate()` API as a *rare, intentional* escape hatch
- Escalation quota (3 per task default) prevents over-escalation
- Feedback loop: frequently-escalated questions become pre-flight checks

---

## Recommendation: Option C

**Option C is the right choice.** Here's why:

1. **The infrastructure exists for both halves.** ReadinessGate covers the upfront layer. The type system and QuestionQueue already model the runtime layer. Neither half requires rethinking — just completing.

2. **The failure modes are complementary.** A-alone fails for runtime discoveries. B-alone creates operator overhead and blocks overnight runs. C gets the benefits of both and constrains the failure modes.

3. **THE_FACTORY already uses this pattern.** CLAUDE.md documents it: "If blocked by uncertainty: write a question to `.agent/questions.jsonl`, move to the next ready task." That is exactly Option C — pre-flight as the default, async escalation as the escape hatch.

4. **The cost structure is right.** Pre-flight cost is borne once, upfront, by the operator (who is present). Runtime escalation cost is minimized by the pre-flight layer — only genuine surprises escalate.

---

## Concrete Pattern

### Pre-flight (Primary Resolution)

```
Operator enters intent
        ↓
ReadinessGate assess() with flowType
        ↓
Flow-specific checks run (task-026 defines these)
        ↓
Failed checks → QuestionGenerator produces structured questions
        ↓
Operator answers inline (LaunchForm enrichment)
        ↓
Answers merged into task instructions
        ↓
Task is "execution-ready" — structural ambiguity resolved
```

**Gate posture:** `triage` mode with `readinessThreshold: 0.8`. Operators can bypass with "Launch anyway" for low-priority tasks where the cost of getting it wrong is low.

### Runtime Escalation (Escape Hatch)

```
Agent runs, encounters decision fork
        ↓
Agent calls: toolContext.escalate(question, options, impact, context)
        ↓
EscalationSignal thrown → GraphExecutor catches
        ↓
Question written to QuestionQueue (with source: 'execution', runId, context)
        ↓
Node status → 'blocked'; execution state saved
        ↓
UI notification sent; run marked 'paused'
        ↓
Operator answers (sync or async)
        ↓
Node status → 'ready'; node re-runs with answer in prompt context
```

**Escalation constraints:**
- Maximum 3 escalations per task (configurable). On quota exceeded: `exitReason: 'escalation_quota_exceeded'`.
- Agent must provide `context` field — no context = escalation rejected.
- Escalation counts against the 2-attempt cap in debug/feature flows — 2 escalations + 1 attempt left.

### Feedback Loop (Learning)

```
Execution escalation answered + node completes successfully
        ↓
Answer stored in run record (metadata.questionAnswers)
        ↓
After N runs: mining script clusters execution escalations by task type
        ↓
Recurring escalations for task type X become pre-flight checks for flow X
        ↓
Pre-flight check surfaced to operator next time → escalation eliminated
```

**This is the key long-term value of the hybrid pattern.** The system is instrumented to learn — execution escalations that stabilize across runs become pre-flight requirements. The proportion of runtime escalations should *decrease* over time as domain knowledge is codified into flow-specific checks.

---

## Ambiguity Type → Resolution Layer Mapping

| Ambiguity type | Primary layer | Escape hatch | Teachable? |
|---------------|--------------|--------------|------------|
| Structural (missing info) | Pre-flight (required check) | No | Already taught |
| Terminological (vague terms) | Pre-flight (advisory check) | No | Already taught |
| Decision (valid trade-offs) | Pre-flight (flow questions, if anticipatable) | Escalation | Yes — recur → pre-flight check |
| Scope (in/out unclear) | Pre-flight (`has_scope_boundary`) | Escalation (new scope discovered) | Yes |
| Technical (codebase constraints) | Not catchable pre-flight | Escalation | Yes — recur → domain check |
| Emergent (revealed by exploration) | Not catchable pre-flight | Escalation | Partially (depends on specificity) |

---

## Open Questions

1. **What triggers the mining step?**
   The feedback loop requires periodically reviewing execution escalations and deciding which to promote to pre-flight checks. When does this happen? Options: (a) manual review by operator, (b) automated script after N runs, (c) prompted by assess.py trend analysis. Recommend: (c) — `assess.py` already looks at run outcomes; add "most common escalation questions" to its output.

2. **What happens when an operator never answers an escalation question?**
   The node stays blocked. The run stays "paused." Recommendation: configurable timeout (default: 24 hours). On timeout, auto-resolve to the `default` option in the question schema. This makes pre-populated defaults load-bearing — they need to be genuinely good defaults.

3. **Should escalation from exploration/assessment flows be treated differently?**
   For exploration, escalation is *expected* (the agent is by definition in uncertain territory). Recommendation: higher default quota (5 vs. 3) for exploration/assessment flows. Don't count escalations against the 2-attempt cap for these flows.

4. **Can an agent escalate with "I need the operator to make a judgment call" rather than a specific question?**
   Open-ended escalations are harder to answer (no `options` list). Recommend requiring `options` — forced choices reduce operator cognitive load and produce more consistent answers. Agent must propose at least 2 options, including a "let agent decide" option.

5. **How does ambiguity resolution interact with D5 (adaptive escalation)?**
   D5 re-decomposes after failure, injecting failure evidence into the next attempt's instructions. This is a *technical* response to failure, not an ambiguity resolution mechanism. D5 should continue to exist as a separate pathway — D5 handles execution failures; `escalate()` handles decision ambiguity. They're complementary.

6. **Should there be a "flag and continue with assumption" mode?**
   The task description mentions this as option C's alternative sub-path. Agent flags ambiguity but makes an assumption and continues. Risk: wrong work. Benefit: doesn't interrupt the operator. Recommendation: **do not implement this mode initially**. The escalation mechanism is cheap enough that interrupting the operator is justified. "Flag and continue" creates work that has to be undone if the assumption was wrong.

---

## Dependencies on Other Proposals

- **task-025 (Agent Question Flow):** This proposal defines *when* to escalate and the constraints on it. Task-025 designs the execution mechanism (the `escalate()` API, GraphExecutor handling, notification surface).
- **task-026 (Intent-Based Flow Templates):** Flow-specific pre-flight questions are the primary ambiguity resolution layer. The fewer questions pre-flight misses, the fewer runtime escalations occur.
- **task-028 (Meta-Project Orchestration):** The meta-project intake process is also a pre-flight ambiguity resolution layer — before the task even reaches the queue, the planning agent helps structure it.

---

## Implementation Priority

The feedback loop is the long-term value; the escalation mechanism is the prerequisite.

| Phase | What | Enables |
|-------|-----|---------|
| **1** | Flow-specific pre-flight questions (task-026) | Catches more ambiguity before execution |
| **2** | Runtime `escalate()` + GraphExecutor handling (task-025) | Safe escape hatch for runtime discoveries |
| **3** | Escalation quota + `context` requirement | Prevents over-escalation |
| **4** | Answer storage in run record | Makes escalation auditable |
| **5** | Mining + promotion flow | Converts runtime discoveries into pre-flight checks |
