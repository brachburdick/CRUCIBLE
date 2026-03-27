# CRUCIBLE Phase 2.5: Session Model Replication

## Context
CRUCIBLE is an adaptive agent pipeline at /Users/brach/Documents/THE_FACTORY/projects/CRUCIBLE.
It currently has Phase 0 (readiness gate), Phase 1 (decomposition), and Phase 2 (coupling audit).
It needs a session model that replicates THE_FACTORY's session lifecycle before the
RunEngine (Phase 3) can execute graphs with real discipline.

Read THE_FACTORY's session protocol in /Users/brach/Documents/THE_FACTORY/CLAUDE.md and
the flow skills at /Users/brach/Documents/THE_FACTORY/.claude/skills/{debug,feature,refactor}-flow/SKILL.md
to understand what you're replicating. Read CRUCIBLE's existing code to understand the
current architecture before writing anything.

## What to build

### 1. State Snapshot (session continuity across runs)
- Schema: session_id, timestamp, branch, last_commit, active_tasks, modified_files,
  session_knowledge (decisions, key_locations, dead_ends, open_questions), session_friction
  (mutations_since_test, total_mutations, test_cycles, unique_files_modified)
- Write on: explicit save call + periodic (every N node completions)
- Load on: pipeline start — prior decisions skip re-exploration
- Location: .agent/state-snapshot.json within the CRUCIBLE project

### 2. Task Ownership
- Tasks in .agent/tasks.jsonl get claimed by setting status: "in_progress" before work starts
- Implement a ready() function that resolves blocked_by dependencies and returns next claimable task
  sorted by priority (critical > high > medium > low)
- Task completion: set status: "complete", require run record before marking done

### 3. Async Question Queue
- When a node encounters ambiguity, write to .agent/questions.jsonl instead of blocking
- Schema: {id, task, question, options, default, impact, status, asked, answered, answer}
- Pipeline continues to next ready node/task; answers picked up on next run
- Integrate with readiness gate — check for answered questions at session start

### 4. Run Records
- Schema: run_id, date, project_id, task_id, task_type, result (success|partial|failed|escalated),
  summary, files_touched, human_touches {questions, corrections, escalations, approvals, total}
- Written to .agent/runs.jsonl
- Enforced: warn if session ends without run record for completed work

### 5. Flow Skill Templates (for injection into node agents)
- Create TypeScript representations of the three flow phases:
  - Debug: Reproduce → Isolate → Diagnose → Fix → Verify
  - Feature: Intent → Spec → Plan → Implement → Test → Verify
  - Refactor: Scope → Snapshot → Transform → Verify
- Each flow template includes: phase gates, context gate (turn > 40 = partial),
  2-attempt cap, spec-before-code / reproduce-before-fix rules
- These get injected into agent system prompts by the RunEngine (Phase 3)
- Store as structured objects, not just strings — the RunEngine needs to
  check phase transitions programmatically

### 6. Mutation Budget Tracker
- Per-node: 2 consecutive source mutations without test run = blocked
- Per-graph: 10 total mutations compound budget, resets on budget-reset
- Circuit breakers: 4 edit-test cycles on same node = halt, 10 unique files across graph = halt
- Expose as a stateful class that the RunEngine will call pre/post each tool use

## Constraints
- TypeScript ESM, consistent with existing CRUCIBLE code
- All schemas should have TypeScript interfaces AND JSON Schema files in .agent/schemas/
- Write unit tests for ready() dependency resolution, mutation budget state transitions,
  and flow phase validation
- Do NOT modify existing Phase 0/1/2 code — this is additive
- Read existing CRUCIBLE patterns (how specs, schemas, types are organized) and follow them

## Deliverables
- src/session/ directory with: state-snapshot.ts, task-manager.ts, question-queue.ts,
  run-record.ts, mutation-tracker.ts, flow-templates.ts
- schemas/ for JSON schemas
- tests/ for unit tests
- Export a SessionModel class or facade that the RunEngine will consume
