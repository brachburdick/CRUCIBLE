# QA Verdict: [FILL: TASK_ID or BUG_ID]

## Verdict: [FILL: PASS | FAIL]

## Environment
- Server: [FILL: how started, any flags]
- Services: [FILL: E2B sandbox state, Langfuse connection, etc.]

## Scenarios Executed
| Scenario | Status | Notes |
|----------|--------|-------|
| [FILL: SC-001] | [FILL: PASS] | |
| [FILL: SC-002] | [FILL: FAIL] | [brief] |

## Failures
### [FILL: SC-002]: [Name]
- **Expected:** [FILL: from test scenario matrix]
- **Observed:** [FILL: what actually happened, with timestamps if relevant]
- **Logs:** [FILL: relevant log excerpts — minimum needed to diagnose]
- **Severity:** [FILL: BLOCKING | DEGRADED | COSMETIC]

## Regression Check
- Previously passing scenarios still pass: [FILL: YES | NO — list regressions]

## Mock Tool Gaps
- [FILL: "[SC-XXX] requires: [capability not yet available]" or "All executed scenarios had available tooling."]

## Recommendation
[FILL: If FAIL — specific guidance for next Developer handoff. Reference scenario IDs.]
