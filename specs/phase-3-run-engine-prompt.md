# CRUCIBLE Phase 3: Graph-Walking RunEngine

## Context
CRUCIBLE is an adaptive agent pipeline at /Users/brach/Documents/THE_FACTORY/projects/CRUCIBLE.
It has:
- Phase 0: Readiness gate (assesses task completeness)
- Phase 1: Decomposition (breaks tasks into dependency graphs via D0/D4/D5 strategies)
- Phase 2: Coupling audit (validates decomposition quality)
- Phase 2.5: Session model (state snapshots, task ownership, question queue, run records,
  flow templates, mutation tracker) — in src/session/

Read ALL existing CRUCIBLE code before writing anything. Understand the decomposition graph
format, the session model interfaces, and the existing architecture patterns.

Also read THE_FACTORY's flow skills at:
- /Users/brach/Documents/THE_FACTORY/.claude/skills/debug-flow/SKILL.md
- /Users/brach/Documents/THE_FACTORY/.claude/skills/feature-flow/SKILL.md
- /Users/brach/Documents/THE_FACTORY/.claude/skills/refactor-flow/SKILL.md

These define the discipline model that the RunEngine must enforce per-node.

## What to build

### 1. Graph Walker (orchestration core)
- Input: decomposition graph from Phase 1 (nodes with dependencies, owned_paths, acceptance criteria)
- Topological traversal: resolve dependencies, identify parallelizable nodes (no shared deps)
- Node states: pending → ready → in_progress → verifying → complete | failed | escalated
- Respect blocked_by edges — a node becomes ready only when all upstream nodes are complete
- On node failure: check 2-attempt cap. If exhausted, mark escalated, write question to queue,
  continue to next independent branch of the graph

### 2. Node Executor (per-node agent lifecycle)
- For each ready node:
  1. Claim it (set in_progress via task manager)
  2. Determine flow type from node metadata (debug/feature/refactor)
  3. Build agent system prompt by injecting the appropriate flow template from session model
  4. Include: node's owned_paths (blast radius), acceptance criteria, upstream outputs
  5. Execute agent in sandbox (use existing E2B integration if present, or local subprocess)
  6. Track mutations via mutation tracker — enforce 2-cap, compound budget, circuit breakers
  7. Phase gate enforcement: agent must signal phase transitions; RunEngine validates sequence
  8. On completion: run separate-context verification (different agent context checks acceptance criteria)
  9. Write run record for node

### 3. Separate-Context Verification
- After implementation node completes, spawn a DIFFERENT agent context as verifier
- Verifier receives: acceptance criteria, owned_paths, but NOT the implementer's reasoning
- Verifier runs tests, checks criteria, returns pass/fail with evidence
- If fail: return to implementer for attempt 2 (respecting 2-attempt cap)
- This prevents self-verification bias (critical THE_FACTORY pattern)

### 4. Blast Radius Enforcement
- Each node has owned_paths from decomposition
- Before any file mutation, check path against node's owned_paths
- Block mutations outside scope — log violation, don't silently allow
- Cross-node file access (reads) allowed; cross-node mutations blocked

### 5. State Integration
- Use SessionModel from Phase 2.5 throughout:
  - State snapshot after each node completion (not just session end)
  - Task manager for node claiming and status transitions
  - Question queue when nodes hit ambiguity
  - Run records per-node AND per-graph (rollup)
  - Mutation tracker per-node with per-graph compound budget

### 6. Graph-Level Outcomes
- After all nodes complete (or max escalated):
  - Aggregate run records into graph-level summary
  - result: "success" (all nodes complete) | "partial" (some escalated) | "failed" (critical path blocked)
  - Write graph-level run record with: nodes_total, nodes_complete, nodes_failed,
    nodes_escalated, total_mutations, total_test_runs, human_touches rollup
  - Persist final state snapshot

### 7. CLI Integration
- Add `crucible run <task-file>` command that:
  1. Loads task, runs readiness gate (Phase 0)
  2. Decomposes (Phase 1)
  3. Audits coupling (Phase 2)
  4. Walks graph (Phase 3) — this is the new part
  5. Reports outcome
- Support `--dry-run` that does 1-3 only and prints the execution plan
- Support `--node <id>` to execute a single node (for debugging)

## Constraints
- TypeScript ESM, consistent with existing CRUCIBLE code
- Import SessionModel from src/session/ — do not duplicate session logic
- Write integration tests: graph with 3 nodes (2 parallel + 1 dependent),
  test that dependency resolution works, test 2-attempt escalation,
  test blast radius blocking, test separate-context verification
- The RunEngine should be testable without actual E2B sandboxes —
  use dependency injection for the executor so tests can mock it
- Follow existing CRUCIBLE patterns for CLI commands, config, error handling

## Deliverables
- src/engine/ directory with: graph-walker.ts, node-executor.ts, verifier.ts,
  blast-radius.ts, run-engine.ts (facade)
- Integration with existing CLI (add `run` command)
- tests/ for unit + integration tests
- Update CRUCIBLE's README or spec docs to reflect the new pipeline stage
