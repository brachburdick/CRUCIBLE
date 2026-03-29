# Phase 7 — Deferred & Stripped Items

Items removed or deferred during spec review. Tracked here so they aren't lost.

## Stripped from 7A

| Item | Reason | Revisit when |
|------|--------|-------------|
| PipelineStrip component | Only 2 pages in primary flow; visual affordance for a pipeline the operator already understands | CRUCIBLE has a distinct review/compare step in the UI |
| Waivers DB column | Premature — no query use case yet. Store waivers in run metadata JSON blob instead | Waiver data needs to be queried/aggregated across runs |
| `risk_classified` as REQUIRED | Inferred from keywords; low penalty for wrong classification. Downgraded to WAIVABLE | Never — WAIVABLE is the right tier for this |
| Keystroke debounce (400ms) | Flickering concern — operator sees unstable results mid-typing. Replaced with 1.5s idle trigger | Never — idle trigger is strictly better UX |

## Stripped from 7B

| Item | Reason | Revisit when |
|------|--------|-------------|
| Lines-changed heuristic | Redundant with file count for the decision it informs (decompose or not) | If file count alone proves insufficient for strategy selection |
| Fix-on-fix detection | VCS access requirements underspecified; evidence is "moderate" (Kamei et al.); requires plumbing not yet built | VCS integration exists and 30+ runs show fix-on-fix as a failure predictor |
| Test-suite-presence check | Overlaps with `has_verification_command` fast check | Fast check proves insufficient for detecting test infra |
| Sequential unlock (auto-trigger deep analysis) | Wrong UX — operator who knows their strategy doesn't need to wait for LLM. Replaced with opt-in "Run deep analysis" button | Never — opt-in is the right pattern for expensive checks |
| Cascade as gate/auto-selection | Borrowed heuristics from METR/SWE-bench aren't CRUCIBLE-calibrated. Cascade becomes a suggestion, not a decision-maker | 30+ runs with outcome data enable CRUCIBLE-specific calibration |
| Stale indicator on deep results | Adds "stale but maybe relevant" ambiguity. Replaced with clear-on-edit + re-show button | Never — clear state is better than stale state |
| Separate `/api/readiness/deep` endpoint | Overlapping schemas with `/api/readiness`. Merged into single endpoint with `deep: boolean` flag | Never — single endpoint is cleaner |
| Anti-heuristic runtime checks (DAG width/chain collapse) | Requires D4 to run first; belongs in execution phase, not pre-flight | Runtime escalation feature is built |

## Deferred to Phase 8+

| Item | Dependency | Notes |
|------|-----------|-------|
| Runtime auto-escalation (D0→D4 on failure) | Phase 7B shipped + outcome data | UI reserves conceptual space but no implementation |
| Historical accuracy tracking per task profile | 50+ completed runs | Kim et al. 45% threshold becomes testable |
| Task-type template library | 30+ runs with pattern analysis | Agentless-style known decomposition optimization |
| Domain readiness profiles | 20-30 tasks per domain | Theoretical concept; build from CRUCIBLE's own data |
| Data-driven strategy selection (logistic regression) | 50+ runs with feature vectors | Replace rule-based cascade with learned model |
| Missing-context vs. difficulty failure classifier | Open research problem | No validated method exists |
| Trace-to-template promotion ("Add to Domain Profile") | Domain profiles exist | Feedback loop from runs to intake templates |
| Run comparison scorecard | Multiple runs on same task | Terminal + web comparison views |
| Configuration version control (promote/rollback) | Run comparison exists | Track template versions with source run and outcome |

---

## Pre-Implementation Review Items

Observations from codebase audit that should be addressed before or during Phase 7 implementation.
These are not blockers but affect how much weight the gate UI can carry.

### 1. Readiness model is too shallow for the UX it supports

`ReadinessCheck.binding` is still `'hard' | 'advisory'` (the type migration in 7A hasn't landed).
`dependencies_resolved` always passes. `risk_classified` is a keyword guess with `hard` binding.
`assessNode()` fakes verification with `command: 'true'`. The current gate is useful as triage but
not yet trustworthy as a prominent pre-flight signal. **Before shipping 7A's UI, the binding
migration must land and check quality should be reviewed — showing unreliable checks prominently
risks training the operator to always click "Launch anyway."**

### 2. Readiness is computed but discarded in the graph path

In `D4Strategy`, node readiness is assessed and then discarded. `GraphBuilder` defaults nodes back
to `emptyReadiness()`. This breaks the intended "graph carries readiness intelligence" story. **7A
doesn't depend on per-node readiness, but 7B's strategy suggestion and any future graph-aware gate
will need this fixed.** Consider as a pre-7B cleanup task.

### 3. Decomposition exists architecturally but not in the product loop

`loadExtendedVariant` exists but CLI and comparison paths still use `loadVariant` and call
`RunEngine.startRun` directly. D0/D4/D5 are present in the engine but not first-class at launch
time. **7A adds a strategy dropdown (D0/D4/D5) to the launch form and passes it to
`POST /api/runs` — the wiring from the run payload through to the actual strategy selection in
RunEngine needs to be verified or built during 7A Step 1e.**

### 4. Comparison layer is thinner than the benchmark thesis

The stated goal is comparing decomposition, verification, and coordination formulas — especially
leaf solvability and coupling. But `compare.ts` mostly ranks by completion, visible checks, tokens,
and time. GraphView is still a placeholder. **This doesn't block Phase 7, but it means the
"compare results" step of the UX pipeline (Area 4 from the UX research) has no real foundation
yet.** The deep analysis snapshot stored in run metadata (7B) is designed to feed future comparison
— but the comparison view itself is Phase 8+ work.

### 5. Server routing and run payload don't yet support Phase 7 fields

`server/index.ts` wires runs/ws/session/graphs/projects only. `runs.ts` accepts neither `strategy`
nor gate metadata. `LaunchForm` has a single straight-through submit path. **These are expected gaps
— 7A's Step 1 explicitly addresses them. Listed here so the implementing agent doesn't mistake
current state for target state.**
