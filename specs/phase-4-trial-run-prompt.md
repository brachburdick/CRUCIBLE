# CRUCIBLE Phase 4: First Trial Run

## Objective
Validate CRUCIBLE's end-to-end pipeline (Phases 0–3) by running it against real tasks.
This is a shakedown session — the goal is to find integration bugs, missing wiring,
and gaps between the spec and reality. Not to ship features.

## Prerequisites
Before starting, verify the pipeline is functional:

```bash
cd /Users/brach/Documents/THE_FACTORY/projects/CRUCIBLE

# 1. Build passes
npm run build

# 2. Existing tests pass
npm test

# 3. Dry run succeeds on built-in task
npx crucible run \
  --task tasks/bugfix-cross-file-diagnosis.json \
  --dry-run
```

If any of these fail, fix them before proceeding. This is NOT a Phase 3 debugging session —
if the RunEngine has fundamental issues, stop and document what's broken.

## Trial Sequence

Run these in order. Each trial tests a different capability layer.
After each trial, write observations to a trial log (format below).

### Trial 1: Built-in Benchmark (Baseline)

**Purpose:** Verify the pipeline works end-to-end on a known-good task with expected behavior.

```bash
npx crucible run \
  --task tasks/bugfix-cross-file-diagnosis.json \
  --budget 50000 \
  --ttl 300
```

**What to check:**
- [ ] Readiness gate passes (task has acceptance criteria, checks, scope)
- [ ] Decomposition produces a graph (even if D0 single-node)
- [ ] Coupling audit runs (even if trivial for D0)
- [ ] Graph walker claims node, executes agent, runs verification
- [ ] Separate-context verifier fires (different context than implementer)
- [ ] Run record written to .agent/runs.jsonl
- [ ] State snapshot written to .agent/state-snapshot.json
- [ ] Exit code reflects actual outcome (0=success, non-zero=failure)
- [ ] All checks in the task pass

**Expected outcome:** Success. This is a 3-file Python bugfix — root cause in pricing.py,
symptom in orders.py. Should complete in <10k tokens with D0.

If this fails, diagnose and fix before moving to Trial 2.

### Trial 2: Multi-Node Graph (Decomposition Stress)

**Purpose:** Test that decomposition + graph walking actually works with multiple nodes.

```bash
npx crucible run \
  --task tasks/bugfix-cross-file-diagnosis.json \
  --variant d4 \
  --budget 100000 \
  --ttl 600
```

Use the D4 (interface-first) strategy to force decomposition into multiple nodes.

**What to check:**
- [ ] Decomposition produces 2+ nodes with dependency edges
- [ ] Coupling audit identifies cross-node boundaries
- [ ] Graph walker resolves dependencies correctly (parallel nodes run, blocked nodes wait)
- [ ] Blast radius enforced per-node (mutations confined to owned_paths)
- [ ] Each node gets its own run record
- [ ] Graph-level rollup record written
- [ ] If a node fails, 2-attempt cap respected before escalation

**Expected outcome:** Success, but slower and more tokens than Trial 1 (decomposition overhead).
The interesting data is whether the graph structure helps or hurts for this task size.

### Trial 3: Flow Discipline (Feature Flow)

**Purpose:** Test that flow templates actually constrain agent behavior.

Create a minimal feature task:

```json
{
  "description": "Add a greet() function to utils.py",
  "instructions": "Add a function greet(name: str) -> str that returns 'Hello, {name}!' to utils.py. Write a test.",
  "files": {
    "utils.py": "# Utility functions\n\ndef add(a: int, b: int) -> int:\n    return a + b\n",
    "test_utils.py": "from utils import add\n\ndef test_add():\n    assert add(1, 2) == 3\n"
  },
  "checks": [
    {"name": "visible: greet function exists", "type": "exec", "command": "python -c \"from utils import greet; assert greet('World') == 'Hello, World!'\""},
    {"name": "visible: tests pass", "type": "exec", "command": "python -m pytest test_utils.py -v"},
    {"name": "hidden: test covers greet", "type": "exec", "command": "grep -q 'test_greet\\|def test.*greet' test_utils.py"}
  ],
  "riskLevel": "low",
  "acceptanceCriteria": [
    "greet(name) returns 'Hello, {name}!'",
    "Unit test for greet exists and passes",
    "Existing tests still pass"
  ]
}
```

Save as `tasks/trial-add-greet.json`, then:

```bash
npx crucible run \
  --task tasks/trial-add-greet.json \
  --budget 30000 \
  --ttl 180
```

**What to check:**
- [ ] Readiness gate passes (has acceptance criteria, checks, risk level)
- [ ] Feature flow template injected into agent system prompt
- [ ] Agent follows feature flow phases (Intent → Spec → Plan → Implement → Test → Verify)
- [ ] Mutation tracker counts edits (should be well under budget for this)
- [ ] Separate-context verifier confirms acceptance criteria met
- [ ] Run record captures flow type as "feature"

**Expected outcome:** Easy success. The real test is whether the flow template is visible
in the agent's behavior (does it show phase transitions, or just blast through?).

### Trial 4: Mutation Budget (Kill Switch)

**Purpose:** Verify the mutation tracker actually blocks runaway agents.

Create a deliberately tricky task with a low budget:

```json
{
  "description": "Fix the infinite recursion in fib()",
  "instructions": "Fix the fibonacci function so it returns correct values. Do NOT use memoization — simple recursion is fine.",
  "files": {
    "fib.py": "def fib(n):\n    if n <= 0:\n        return fib(n - 1) + fib(n - 2)\n    return n\n"
  },
  "checks": [
    {"name": "visible: fib(10) correct", "type": "exec", "command": "python -c \"from fib import fib; assert fib(10) == 55\""},
    {"name": "hidden: no memoization", "type": "exec", "command": "! grep -q 'cache\\|memo\\|dict\\|lru_cache' fib.py"}
  ],
  "riskLevel": "low",
  "acceptanceCriteria": ["fib(10) == 55", "Simple recursion only"]
}
```

Save as `tasks/trial-fib-budget.json`, then run with a TIGHT compound budget:

```bash
npx crucible run \
  --task tasks/trial-fib-budget.json \
  --budget 10000 \
  --ttl 60
```

**What to check:**
- [ ] If agent solves it in 1–2 mutations: great, budget works as expected
- [ ] If agent spirals (unlikely for this task, but test the mechanism):
  - 2-cap fires after 2 edits without test
  - Compound budget fires if total mutations exceed limit
  - Circuit breaker fires if edit-test cycle count exceeded
- [ ] Exit code reflects budget/TTL exhaustion if triggered
- [ ] Run record shows `result: "failed"` or `"escalated"` with reason

**Expected outcome:** Success (task is easy). But if the agent somehow spirals,
the kill switches should fire cleanly.

### Trial 5: Real Project Task (The Real Test)

**Purpose:** Run CRUCIBLE against an actual pending task from your project backlog.

Pick ONE of these based on what you want to test:

**Option A — Tinyshop Phase 1 (scaffold + types + SQLite):**
Small, well-scoped, no external dependencies. Good for validating the feature flow
on real project work. You'll need to create a task payload from the existing task
description in THE_FACTORY's tasks.jsonl (id: `tinyshop-phase1`).

**Option B — A small SCUE task:**
If there's a small, self-contained SCUE task (not M7, too big), create a task
payload for it. Ideal: something with clear acceptance criteria and a test command.

To create the task payload:
1. Read the task from `.agent/tasks.jsonl`
2. Read the project's CLAUDE.md for stack/build/test context
3. Create a `tasks/trial-real-{project}.json` with:
   - description + instructions from the task
   - files: {} (empty — the agent works in the project's actual codebase)
   - seedDir: path to the project root (if CRUCIBLE supports this)
   - checks: derive from acceptance criteria
   - acceptanceCriteria: from the task
   - riskLevel: from the task
   - ownedPaths: from section contract if applicable

```bash
npx crucible run \
  --task tasks/trial-real-{project}.json \
  --budget 200000 \
  --ttl 900
```

**What to check:**
- [ ] Readiness gate catches any missing criteria
- [ ] Decomposition produces reasonable structure for the task
- [ ] Agent actually produces working code (not just planning)
- [ ] Blast radius confines changes to expected paths
- [ ] Separate-context verifier catches real issues (not rubber-stamp)
- [ ] Total token usage is reasonable vs. what a bare THE_FACTORY session would use
- [ ] Run record is complete and accurate

## Trial Log Format

After each trial, append to `trials/phase-4-trial-log.jsonl`:

```json
{
  "trial": 1,
  "task": "bugfix-cross-file-diagnosis",
  "date": "2026-03-28T...",
  "variant": "d0",
  "result": "success|partial|failed",
  "exit_code": 0,
  "tokens_used": 8500,
  "wall_time_seconds": 45,
  "nodes_total": 1,
  "nodes_complete": 1,
  "nodes_failed": 0,
  "observations": [
    "Readiness gate passed all 6 checks",
    "D0 wrapped as single node — expected",
    "Verifier confirmed fix in separate context",
    "Run record written correctly"
  ],
  "bugs_found": [
    "State snapshot missing session_knowledge field — schema mismatch"
  ],
  "flow_discipline_visible": true,
  "separate_verification_fired": true,
  "mutation_budget_respected": true
}
```

## Success Criteria for Phase 4

Phase 4 is complete when:
1. **Trials 1–4 all pass** — pipeline handles benchmark tasks end-to-end
2. **Trial 5 produces usable output** — real project work, even if partial
3. **No silent failures** — every error surfaces via exit code, run record, or event stream
4. **Kill switches fire correctly** — at least one trial triggers a budget/cap limit
5. **Separate-context verification is real** — verifier catches at least one issue the implementer missed (across all trials)
6. **Trial log is complete** — all 5 entries with observations and bugs

## What to do with bugs found

- **Pipeline bugs** (CRUCIBLE code): fix inline if small (<10 LOC), otherwise create a task
  in `.agent/tasks.jsonl` with id `crucible-fix-{description}`
- **Spec gaps** (something the spec didn't account for): write to `.agent/questions.jsonl`
  for operator review
- **Flow discipline failures** (agent ignores phase gates): note in trial log —
  this informs whether flow templates need stronger enforcement (hooks vs. prompts)

## Constraints
- Do NOT modify THE_FACTORY pipeline code — this is a CRUCIBLE-only session
- Do NOT modify project source code outside of sandbox execution
- Write all trial artifacts inside the CRUCIBLE project directory
- If Trial 1 fails fundamentally (e.g., RunEngine crashes), STOP and document —
  don't proceed to Trial 2 with a broken foundation
