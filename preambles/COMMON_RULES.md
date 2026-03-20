# Common Rules — All Roles

These rules apply to every agent session in the CRUCIBLE project. Read `AGENT_BOOTSTRAP.md` before this file.

## Ask-Don't-Assume
When encountering ambiguity not covered by your handoff packet or spec, do not infer a default. Flag it as `[DECISION NEEDED]` (Architect, Designer) or `[BLOCKED]` (Developer) and stop.

## Research Escalation (2-Attempt Rule)
If two attempts to solve a problem fail, stop. Write a Research Request using `templates/research-request.md` and set status to BLOCKED. Do not guess on attempt three.

## Artifact Templates
All outputs must use the corresponding template from `templates/`. Missing required fields = incomplete artifact.

## [DECISION NEEDED] Protocol
Mark ambiguity that could produce divergent implementations. Do not infer. Do not proceed past it. The human operator resolves these.

## [BLOCKED] Protocol
When blocked by missing information or unresolved dependencies:
1. Document what is blocked and why.
2. Complete as much unblocked work as possible.
3. Set status to BLOCKED or PARTIAL in your session summary.

## Read Before Edit
Read every file before editing it. The Edit tool rejects changes to unread files. When your handoff lists files to modify, read them all before making any edits.

## Decision Transparency
Every choice must be documented with rationale and rejected alternatives in your session summary.

## Inline-Fix Accountability
Any agent that resolves a bug without delegating must write a session summary with role `[ROLE]-inline` and complete:
1. Bug log update
2. Milestone tracker update if BLOCKER closed

## Milestone Maintenance
Any session that closes a `[BLOCKER]` item must update the milestone tracker before ending.

## Misstep Reporting
Record all tool failures, wrong commands, retries, and environment surprises in the `## Missteps` section of your session summary. Be specific: what was tried, what failed, what worked instead. This feeds the Orchestrator's pattern detection.

## Universal Exit Sequence
Every session ends with all of the following, in order:
1. Artifact checklist: confirm every required artifact was written to disk at the exact path named in the handoff.
2. Chain-status declaration: set artifact status fields honestly (`COMPLETE`, `PARTIAL`, or `BLOCKED`) and identify what should happen next.
3. Session retro: record missteps, learnings, and any follow-up items worth promoting.
4. Self-assessment: state confidence and the biggest remaining risk.

## Session Summary
Every session ends with a session summary written to disk using `templates/session-summary.md`. No exceptions.
