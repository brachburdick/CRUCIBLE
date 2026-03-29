# CRUCIBLE Section Map

## Sections

| Section | Status | Owned Paths | LOC (est.) | Independent Tests |
|---------|--------|-------------|------------|-------------------|
| **orchestration** | Active | `src/engine/` (excl. RunEngine, agents.ts), `src/types/` | ~2000 | phase0, phase1, phase2, phase3 |
| **execution** | Active | `src/agents/`, `src/sandbox/`, `src/middleware/` | ~1500 | phase5, docker-integration, runtime-detect |
| session | Deferred | `src/session/` | ~600 | session tests |
| server | Deferred | `src/server/`, `src/cli/`, `src/engine/RunEngine.ts`, `src/engine/agents.ts` | ~800 | (integration — needs other sections) |
| ui | Deferred | `ui/src/` | ~1200 | (none yet) |

**Active** = contract written, invariants enforced.
**Deferred** = boundary identified, contract not yet written. Will activate when LOC grows or parallel agent work begins.

## Co-ownership

| File | Primary Section | Co-owner | Reason |
|------|----------------|----------|--------|
| `src/engine/RunEngine.ts` | server | orchestration | Wires orchestration + execution + session. Integration point. |
| `src/engine/agents.ts` | server | execution | Agent registry — maps names to agent functions across backends |
| `src/types/` | orchestration | (all sections) | Shared type definitions. Orchestration owns and evolves them; all sections consume. |

## Telemetry

`src/telemetry/` (~200 LOC, 4 files) is cross-cutting. Co-owned by server. Too small to justify its own section contract.

## Coupling Map

Can these sections be worked on in parallel by independent agents?

| Pair | Parallel? | Notes |
|------|-----------|-------|
| orchestration + execution | **Yes** | Clean boundary: orchestration produces TaskPayload/DecompositionGraph, execution consumes them. No shared mutable state. |
| orchestration + ui | **Yes** | UI talks to orchestration only via HTTP API (server mediates). |
| orchestration + session | **Yes** | No imports between them. Session persists .agent/ files; orchestration reads task payloads. |
| execution + ui | **Yes** | No direct coupling. Server mediates via WebSocket events. |
| execution + session | **Yes** | Execution emits events; session stores run records. No direct imports. |
| server + anything | **Caution** | Server is the integration point. Changes to server routes may require coordinating API contract changes with UI. |

## Split / Merge Criteria

**Split candidate:** Section exceeds 2500 LOC with identifiable sub-boundaries and independent tests for each sub-unit. Likely candidate: orchestration could split into gate (ReadinessGate + StrategySelector) and graph (DecompositionEngine + GraphExecutor + GraphBuilder) once Phase 7B lands.

**Merge candidate:** Section falls below 400 LOC or its boundary contract is more complex than its internals.

## Coverage

Every `.ts` source file in `src/` must belong to exactly one section (or be co-owned with explicit annotation). Orphan check:

```bash
# List files not covered by any section (run from project root)
find src -name '*.ts' -not -path '*/test/*' | sort > /tmp/all-src.txt
# Compare against section owned paths — manual for now, eval later
```
