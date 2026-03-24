---
status: DRAFT
project_root: /Users/brach/Documents/THE_FACTORY/projects/CRUCIBLE
revision_of: none
supersedes: none
superseded_by: none
---

# Benchmark Program: Decomposition Formula Evaluation

## Purpose

CRUCIBLE already proves the Phase 1 capability: run one agent safely inside an
isolated sandbox, enforce kill switches, and emit structured results.

This document defines the next layer:

**Compare decomposition, verification, and orchestration formulas to discover
which ones produce the highest rate of independently verifiable,
low-coupling, first-pass-solvable leaves under realistic budgets.**

The benchmark target is not just "which model is best?" or "which prompt is
best?" The target is:

`decomposition formula x verification formula x coordination topology`

## Core Hypothesis

Recent multi-agent research suggests that reliability failures cluster around:

- poor specification or goal framing
- bad task cuts and interface boundaries
- inter-agent misalignment
- weak or missing verification

The benchmark program therefore focuses on the structure of work decomposition
and the quality of verification, not just on model choice.

## Experimental Unit

A single benchmark run is:

`BenchmarkCase x VariantSpec x Trial`

Where:

- `BenchmarkCase` defines the starting repo, brief, visible criteria, hidden
  checks, budget, and tool policy.
- `VariantSpec` defines the decomposition strategy, coordination topology,
  verifier policy, model policy, and prompt/policy versions.
- `Trial` repeats the same case/variant pairing to measure variance and reduce
  one-off stochastic wins.

## Experimental Axes

### 1. Decomposition Formula

| ID | Name | Description |
|---|---|---|
| `D0` | Direct | One plan, one executor, one self-check. No explicit decomposition beyond a short plan. |
| `D1` | Fixed Ladder | Brief -> milestones -> tasks -> architecture -> development -> validation -> QA. |
| `D2` | Goal Tree | Brief -> goals, non-goals, constraints, obstacles -> subgoals -> leaf tasks. |
| `D3` | HTN | Recursively decompose abstract tasks into executable leaves until all leaves satisfy the solvability gate. |
| `D4` | DSM / Interface-First | Infer modules, interfaces, and dependency graph first, then cut work along low-coupling seams. |

### 2. Verification Formula

| ID | Name | Description |
|---|---|---|
| `V0` | Self-Check | Executor runs its own checks and declares completion. |
| `V1` | Independent Verifier | A distinct verifier evaluates each completed leaf before integration. |
| `V2` | Paired V-Model | Every implementation leaf is created with a sibling verifier plus hidden end-to-end QA. |

### 3. Coordination Topology

| ID | Name | Description |
|---|---|---|
| `T0` | Single | One agent handles planning, execution, and checking. |
| `T1` | Pipeline | Planner -> executor -> verifier. |
| `T2` | Graph | Planner emits a task DAG; scheduler runs ready leaves and joins at integration gates. |

## Initial Benchmark Matrix

Do not benchmark the full combinatorial space at first. Start with these
variants:

| Variant | Formula | What It Tests |
|---|---|---|
| `B0` | `D0 + V0 + T0` | Minimal-overhead baseline. |
| `B1` | `D1 + V1 + T1` | Closest analogue to the current THE_FACTORY process. |
| `B2` | `D2 + V1 + T1` | Goal/constraint/obstacle refinement before build work. |
| `B3` | `D3 + V1 + T1` | Recursive HTN decomposition with replan when leaves fail. |
| `B4` | `D4 + V1 + T1` | Dependency-aware, interface-first cutting before coding. |
| `B5` | `D3 + V2 + T2` | HTN plus strong verification and graph scheduling. |
| `B6` | `D4 + V2 + T2` | Interface-first plus strong verification and graph scheduling. |

These variants create:

- one naive baseline
- one "current philosophy" baseline
- goal-oriented decomposition
- formal recursive decomposition
- dependency-aware decomposition
- two high-reliability challengers

## Leaf Solvability Gate (`L1`)

Every decomposition formula must stop only when a candidate leaf satisfies the
same gate.

A leaf is benchmark-legal only if it has:

- one primary objective
- explicit inputs
- explicit outputs or artifacts
- explicit dependency list
- explicit verifier or oracle
- explicit replan trigger
- bounded context
- bounded blast radius

Starting thresholds:

- touches `<= 1` module or `<= 5` files
- depends on `<= 2` unresolved siblings
- has one primary artifact
- verifier runtime `<= 120s`
- fits inside a fixed context and budget envelope
- failure can be localized to that leaf

The benchmark program should measure both:

- whether a decomposition formula produces leaves that pass `L1`
- whether those leaves are actually solved on the first pass

## Benchmark Case Families

Start with 18 cases: 6 families x 3 cases each.

| Family | What It Tests |
|---|---|
| `F1 Bootstrap` | Build a new app skeleton from a brief. |
| `F2 Vertical Slice` | Add a full-stack feature across UI, backend, and data. |
| `F3 Bugfix` | Diagnose and fix a real regression with hidden tests. |
| `F4 Refactor` | Improve structure without changing behavior. |
| `F5 Integration` | Add an external API or service while preserving contracts. |
| `F6 Long-Horizon` | Build a small but multi-milestone app from scratch. |

Every case should define:

- `case_id`
- `family`
- `seed_repo`
- `brief`
- visible acceptance criteria
- hidden checks
- budget and TTL
- tool and network policy
- scoring weights

## Metrics

### Outcome Metrics

- visible acceptance pass rate
- hidden acceptance pass rate
- escaped defect rate
- final artifact usability

### Efficiency Metrics

- wall time
- token cost
- tool calls
- retries
- operator minutes

### Decomposition Metrics

- `%` of leaves that pass `L1`
- leaf first-pass solve rate
- replan frequency
- cross-leaf collision rate
- interface break rate
- average dependency fan-in and fan-out per leaf

### Process Reliability Metrics

- verification coverage
- gate violation rate
- loop rate
- timeout rate
- invalid completion claims
- artifact completeness

### Preference Metrics

- pairwise judge preference
- optional human ranking on a sampled subset

## Winner Policy

Do not promote variants on a single weighted score alone.

### Hard Gates

A challenger only advances if:

- hidden acceptance pass rate is not worse than incumbent
- catastrophic failure rate remains below threshold
- escaped defects do not increase
- operator minutes do not materially worsen

### Ranking Order

When multiple variants pass the hard gates, rank by:

1. hidden acceptance pass rate
2. visible acceptance pass rate
3. leaf first-pass solve rate
4. escaped defects
5. operator minutes
6. token cost

Tie-breakers:

1. pairwise judge preference
2. lower cost

## Recommended Repository Shape

```
projects/CRUCIBLE/
├── benchmarks/
│   ├── families/
│   └── cases/
├── variants/
│   ├── B0-direct/
│   ├── B1-ladder/
│   ├── B2-goal-tree/
│   ├── B3-htn/
│   ├── B4-dsm/
│   ├── B5-htn-vmodel/
│   └── B6-dsm-vmodel/
├── scorers/
│   ├── deterministic/
│   ├── judge/
│   └── pairwise/
├── experiments/
└── runs/
```

## Suggested Phases

### Phase 2: Benchmark Core

- add `BenchmarkCase`, `VariantSpec`, and `ExperimentSpec`
- implement deterministic scorers
- encode `B0` through `B4`
- run on `F1` through `F4`

### Phase 3: Strong Verification

- add `V2` hidden QA
- implement `B5` and `B6`
- add repeated trials

### Phase 4: Promotion Logic

- codify hard gates and ranking rules
- store incumbent/challenger comparisons
- support promotion history

### Phase 5: Workflow Search

- only after the benchmark suite is stable
- explore AFlow-style or search-based workflow optimization

## Governing Question

The benchmark program exists to answer this question:

**Which decomposition regime produces the highest rate of independently
verifiable, low-coupling, first-pass-solvable leaves under realistic budgets?**

That question is a stronger target than model quality alone and better matches
CRUCIBLE's role as an agent-infrastructure research project.
