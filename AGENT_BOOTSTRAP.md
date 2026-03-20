# CRUCIBLE

A sandboxed agent evaluation harness for testing and comparing AI orchestration pipeline variants autonomously, with hard safety stops.

## Quick Reference
- **Stack:** TypeScript, Node.js, E2B SDK, Langfuse, OpenAI embeddings (text-embedding-3-small)
- **Current milestone:** Phase 1 MVP — single sandbox run with kill switches
- **Active spec:** `specs/feat-mvp-sandbox/spec.md`
- **Active plan:** `specs/feat-mvp-sandbox/plan.md`
- **Active tasks:** `specs/feat-mvp-sandbox/tasks.md`

## Your Role Setup
1. Read this file first.
2. Read `preambles/COMMON_RULES.md`.
3. Read your role-specific preamble from `preambles/[ROLE].md`.
4. Read any workflow artifact named in your startup prompt or handoff packet, including `docs/interfaces.md` when contracts matter.
5. Read any skill files referenced in your handoff packet.

## Project Layout
- `docs/` — Architecture, interface contracts, constraints, decisions, glossary
- `docs/interfaces.md` — Canonical cross-layer contract reference; keep aligned with active specs and interface-impacting tasks
- `docs/agents/orchestrator-state.md` — Current coordination snapshot for Orchestrator sessions
- `docs/agents/startup-prompts/` — Copy-paste role startup prompts
- `specs/` — Feature specs, plans, tasks, session logs
- `skills/` — Domain knowledge files (E2B, Langfuse, embeddings)
- `src/` — Source code (sandbox/, middleware/, telemetry/, cli/, types/)
- `templates/` — Artifact schemas (use these for all outputs)
- `runs/` — Output directory for run results (gitignored)
- `tasks/` — Example task payloads

## Top 3 Things Agents Get Wrong in This Project
1. Forgetting that every kill path must converge on the same artifact-flush + sandbox-teardown sequence — no silent state discard
2. Making LLM calls synchronous or blocking — all calls must be async
3. Coupling middleware to agent internals — token budget and loop detector must wrap any LLM call function without requiring changes inside the agent
