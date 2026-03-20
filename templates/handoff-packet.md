# Handoff Packet: [FILL: TASK_ID]

> Status: [FILL: APPROVED]
> Project Root: [FILL: /absolute/path/to/project]
> Revision Of: [FILL: artifact path or "none"]
> Supersedes: [FILL: artifact path(s) or "none"]
> Superseded By: [FILL: artifact path(s) or "none"]

## Dispatch
- Mode: [FILL: ORCHESTRATOR DISPATCH | DIRECT DISPATCH]
- Output path: [FILL: exact artifact path this agent must write before ending the session]
- Parallel wave: [FILL: wave ID or "none"]

## Objective
[FILL: One sentence — what must be true when this task is done.]

## Role
[FILL: Architect | Researcher | Designer | Developer | Validator | QA Tester]

## Working Directory
- Run from: [FILL: exact working directory]
- Related feature/milestone: [FILL: feature or milestone name]

## Scope Boundary
- Files this agent MAY read/modify:
  - [FILL: explicit file paths or glob patterns]
- Files this agent must NOT touch:
  - [FILL: explicit exclusions]

## Context Files
- `AGENT_BOOTSTRAP.md`
- [FILL: relevant spec, plan, tasks, interfaces, findings, or skill files]

## Interface Contracts
- [FILL: exact contract file(s), payloads, signatures, or "none"]
- [FILL: if parallel work exists, state ownership split and shared boundary]

## Required Output
- Write: `[FILL: same exact path from Dispatch > Output path]`
- If you supersede an existing artifact, mark it `SUPERSEDED` before session end.
- If you discover backlog-worthy out-of-scope improvements, capture them in `## Follow-Up Items` of the session summary.

## Constraints
- [FILL: non-negotiable rule]
- [FILL: non-negotiable rule]

## Acceptance Criteria
- [ ] [FILL: specific, testable condition]
- [ ] [FILL: specific, testable condition]
- [ ] All pre-existing tests pass

## Dependencies
- Requires completion of: [FILL: TASK_ID(s) or "none"]
- Blocks: [FILL: TASK_ID(s) or "none"]

## Open Questions
- [FILL: unresolved item or "none"]

> If this is a Developer handoff and `## Open Questions` is non-empty, do not dispatch yet.
