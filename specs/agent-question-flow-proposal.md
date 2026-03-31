# Agent Question Flow — Proposal
**Task:** task-025
**Status:** PROPOSAL — Awaiting operator review
**Date:** 2026-03-31
**Dependencies:** task-027 (ambiguity resolution strategy), task-028 (meta-project orchestration)

---

## Problem

CRUCIBLE has a complete question infrastructure — `QuestionQueue`, `QuestionGenerator`, `ReadinessGate`, `QuestionForm` UI, session API routes — but none of it is wired together into an end-to-end flow. Specifically:

- **Inline questions during task creation** exist (LaunchForm readiness enrichment) but are incomplete UX.
- **Async questions during execution** are fully designed in types (`exitReason: { type: 'escalated' }`, `HumanTouches.questions`) but have zero runtime implementation.
- **Questions raised mid-execution** have no path from agent → QuestionQueue → operator notification → agent resume.

The result: agents that encounter genuine ambiguity mid-task have no sanctioned mechanism to surface it. They either guess (wrong work) or fail (wasted run).

---

## Current State

### What Exists

| Component | Location | Status |
|-----------|---------|--------|
| QuestionQueue (ask/answer/persist) | `src/session/question-queue.ts` | Complete |
| QuestionGenerator (readiness → questions) | `src/engine/QuestionGenerator.ts` | Complete |
| ReadinessGate (6 checks + deep analysis) | `src/engine/ReadinessGate.ts` | Complete |
| QuestionForm UI | `ui/src/components/QuestionForm.tsx` | Complete |
| Session API (GET questions, POST answer) | `src/server/routes/session.ts` | Complete |
| Projects API (aggregate questions) | `src/server/routes/projects.ts` | Complete |
| Session page Questions tab | `ui/src/pages/Session.tsx` | Complete |
| LaunchForm enrichment (inline pre-flight Q&A) | `ui/src/components/LaunchForm.tsx` | Partial |
| `exitReason: { type: 'escalated' }` type | `src/types/graph.ts` | Defined, unused |
| `RunResult: 'escalated'` type | `src/session/types.ts` | Defined, unused |
| `HumanTouches.questions` tracking | `src/session/types.ts` | Defined, unused |

### What's Missing

- GraphExecutor does not check `newlyAnswered()` — answers never flow back into running agents.
- No agent-facing `escalate()` API — agents can't signal "I need operator input."
- No notification path — when a question arrives during an active run, the operator sees nothing.
- `context` field in question schema is never populated (operators can't tell *why* the agent is asking).

---

## Proposed Design

### Two Question Contexts

Questions arise in exactly two contexts with different UX requirements:

**Context A: Pre-flight (synchronous, blocking)**
Agent is not yet running. Operator must answer before execution can proceed.
→ *Already implemented in LaunchForm. Needs UX polish.*

**Context B: Mid-execution (asynchronous, non-blocking)**
Agent is running. Agent discovers ambiguity, signals it, pauses cleanly.
Operator answers when available. Next session resumes with the answer.
→ *Fully designed in types. Runtime path is missing.*

---

### Context A: Pre-flight Question Flow (Polish Pass)

**Current flow** (LaunchForm):
1. User types description + instructions.
2. 1.5s idle timer triggers readiness evaluation.
3. Failed checks surface inline with text-input enrichment forms.
4. Each answer re-evaluates readiness.
5. On launch: answers are merged into instructions as `[Label]\n{answer}` blocks.

**UX improvements needed:**

1. **Color-code binding tiers.** Required = red border. Waivable = yellow. Advisory = gray. Currently all checks look identical.

2. **Show enrichment preview.** Before launching, show a collapsible "Instructions preview" that reveals the merged instructions + enrichments. Operators should see exactly what the agent will receive.

3. **Clear individual enrichments.** The current form has no "reset this answer" control. Operator should be able to clear a specific enrichment and re-answer.

4. **Better button labels.** "Resolve X check(s)" is unclear. Use "Required — must answer before launching" and "Answer to continue."

These are low-risk UX changes to existing components. No backend changes needed.

---

### Context B: Mid-Execution Escalation (New)

#### Agent-Side: `escalate()` API

Add an `escalate` method to `ToolContext` (the context object passed to agent runtimes):

```typescript
interface ToolContext {
  // ... existing fields ...
  escalate(
    question: string,
    options: string[],
    impact: string,
    context?: string
  ): Promise<never>;  // always throws EscalationSignal
}
```

When an agent calls `escalate()`:
1. A structured question is written to `QuestionQueue`.
2. An `EscalationSignal` is thrown (causes clean agent shutdown).
3. Agent state is saved.

**The `context` field is mandatory at escalation time** — it captures what the agent was doing when it hit the fork. Example:
```
context: "Implementing cache layer for query engine. Found two valid approaches: (A) in-process LRU, (B) Redis. Choice affects persistence guarantees and deployment complexity."
```

This is the field `QuestionForm` should render — operators need this to answer meaningfully.

#### GraphExecutor-Side: Catch Escalation

In `GraphExecutor.executeNode()`, catch `EscalationSignal`:

```typescript
try {
  const result = await this.runNode(node, agentFn);
  // ... handle success
} catch (err) {
  if (err instanceof EscalationSignal) {
    await this.handleEscalation(node, err.question);
    return;
  }
  throw err;
}

async handleEscalation(node, question) {
  // 1. Persist question to QuestionQueue
  await this.session.questions.ask(question);

  // 2. Set node status to 'blocked'
  await this.setNodeStatus(node.id, 'blocked');

  // 3. Emit WebSocket event for UI notification
  this.emitEvent('node_escalated', { nodeId: node.id, question });

  // 4. Save execution state snapshot
  await this.saveEscalationSnapshot(node.id);

  // 5. Continue scheduling other ready nodes (non-blocking for the graph)
}
```

#### Resume Path

When an operator answers a question, the question moves to `status: 'answered'` in `questions.jsonl`.

On the next `GraphExecutor` scheduling loop, check `session.questions.newlyAnswered(knownAnsweredIds)`. For each new answer targeting a blocked node:
1. Load the escalation snapshot.
2. Inject the answer into the node's prompt context as a `[Operator answer: ...]` block.
3. Reset node status to `ready`.
4. The node re-runs with the enriched context.

**Open question on resume semantics:** Should the node restart from scratch (safe, stateless) or continue from a partial execution checkpoint (efficient, complex)? Recommendation: **restart from scratch** with enriched context. Checkpointing is out of scope until Phase 8.

---

### Notification Surface

Operators need to know when a question is waiting during an active run.

**Minimal viable notification (Phase 1):**
- WebSocket event `node_escalated` triggers a toast notification in the UI: "Agent has a question — [question text truncated]. View in Session."
- `RunDetail` page shows a banner: "This run is paused — question awaiting your answer."
- Session page Questions tab auto-refreshes (polling every 5s) when a run is active.

**Future (Phase 2):**
- In-run modal with "Answer & Resume" — operator answers without leaving RunDetail.
- Question badge on the NavBar (count of pending questions).

---

### Question Data Shape

The question written to `questions.jsonl` at escalation time must be richer than readiness questions:

```json
{
  "id": "q-exec-node-007-1711900000",
  "task": "node-007",
  "runId": "run-abc123",
  "source": "execution",
  "question": "Should the cache layer use in-process LRU or Redis?",
  "context": "Implementing cache layer for query engine. Found two valid approaches: (A) in-process LRU, no infra cost but no persistence; (B) Redis, requires deployment dependency.",
  "options": ["In-process LRU", "Redis", "Let agent decide based on existing infra"],
  "default": "In-process LRU",
  "impact": "Affects persistence guarantees and deployment complexity.",
  "status": "pending",
  "asked": "2026-03-31T10:00:00Z",
  "answered": null,
  "answer": null
}
```

New fields vs. current schema:
- `runId` — links question to the run that raised it
- `source: "execution" | "preflight"` — distinguishes mid-run from pre-flight questions
- `context` — mandatory for execution questions, optional for preflight

---

### Answer Feedback to Task Definition

When an execution question is answered and the node completes successfully, the answer should inform future task creation. Concretely:

1. The answer is stored in the run record (`metadata.questionAnswers`).
2. After the run, the operator can optionally "promote" an execution answer to a pre-flight enrichment on the task definition. UI: "Save this answer for future runs of this task."
3. Over time, frequently-promoted answers become default enrichments in the task template.

This is the feedback loop described in `ux-pipeline-design.md` — discovered questions that stabilize become part of the intake flow.

---

## Open Questions

1. **Unified or split question queue?**
   Pre-flight questions (from QuestionGenerator) and execution questions (from agent escalation) currently share the same `questions.jsonl`. Is that the right design, or should they be separate files? Unified is simpler and provides a complete audit trail. Recommend: keep unified, use `source` field to distinguish.

2. **What is the operator response SLA?**
   If an operator is offline, a blocked node sits indefinitely. Is this acceptable? Options: (a) no timeout (current), (b) configurable timeout with auto-resolve-to-default, (c) timeout triggers run failure. Recommend: (b) — default answer is always specified, so auto-resolve is safe after a configurable period.

3. **Should agents be able to ask follow-up questions?**
   Current schema supports only one question per escalation. What if the operator's answer raises a new question? Recommend: don't build for this in Phase 1. Force agents to ask a single, complete question per escalation.

4. **What prevents agents from escalating on every decision?**
   Without guardrails, agents might over-escalate. Recommend: add a per-run escalation quota (default: 3 escalations per task). If quota is exceeded, the run fails with `exitReason: { type: 'escalation_quota_exceeded' }`.

5. **Should execution questions appear in the "Pending Questions" tab on the Projects page?**
   Currently that tab aggregates questions across all projects from pre-flight. Execution questions during active runs would be mixed in. Recommend: yes, but with visual distinction using the `source` field.

6. **How does answer injection interact with the `--no-input` Claude CLI flag?**
   If the CLI agent backend is used, the answer must be injected into the next invocation's system prompt, not via stdin mid-run. This is straightforward for the restart-from-scratch resume model.

7. **Should pre-flight enrichments be reusable across runs?**
   If the same task is run multiple times (e.g., comparing D0 vs. D4), the operator should not have to re-answer the same questions. Recommend: store enrichments in the task definition in tasks.jsonl as a `defaultEnrichments` field.

---

## Dependencies on Other Proposals

- **task-027 (Ambiguity Resolution):** Determines whether execution escalation is an escape hatch (Option C) or the primary mechanism (Option B). This proposal assumes Option C — escalation is rare and pre-flight handles 80% of ambiguity.
- **task-024 (Task Taxonomy):** The question tab split (planning vs. execution questions) depends on the layer filter design.
- **task-028 (Meta-Project Orchestration):** Pre-flight question answers should feed back into task definitions created by the meta-project layer.

---

## Phased Implementation

| Phase | Scope | Effort |
|-------|-------|--------|
| **1A** (UX polish) | Color-code binding tiers, add enrichment preview, fix button labels | ~1 day |
| **1B** (Escalation types) | Add `escalate()` to ToolContext, `EscalationSignal`, GraphExecutor catch | ~2 days |
| **2** (Resume) | `newlyAnswered()` check in scheduling loop, answer injection, node retry | ~3 days |
| **3** (Notification) | WebSocket `node_escalated` event, toast, RunDetail banner, Session polling | ~2 days |
| **4** (Answer feedback) | Store answers in run record, promote-to-template UI | ~2 days |
