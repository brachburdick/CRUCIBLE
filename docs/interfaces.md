# CRUCIBLE Interfaces

This file is the canonical cross-layer contract reference for CRUCIBLE.

## Current Source Of Truth
- Active feature contract: `specs/feat-mvp-sandbox/spec.md` under `## Interface Definitions`
- Implemented code contracts may also live in `src/types/` as the project evolves

## Active Interfaces

### MVP Sandbox Runner
The Phase 1 MVP interfaces currently defined for this project cover:
- Run configuration and task payload shapes
- Kill-reason and run-result payloads
- LLM call and middleware contracts
- Sandbox tool-context contracts
- Shared error types for budget and loop termination

Refer to `specs/feat-mvp-sandbox/spec.md` for the exact TypeScript signatures currently approved.

## Notes
- This scaffold exists to satisfy the v1.7 protocol requirement for a canonical interface document.
- It intentionally does not restate the full TypeScript contract until the project promotes those definitions into a dedicated interface artifact or updates this file during an interface-changing task.

## Follow-Up Needed
- Promote the current `specs/feat-mvp-sandbox/spec.md` interface definitions into this file when the next Architect or interface-impacting task revises CRUCIBLE's contracts.
