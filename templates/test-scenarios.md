# Test Scenario Matrix: [FILL: AREA_NAME]

## System Preconditions
[FILL: Define the variable axes for this test area.]
- [FILL: E.g., "E2B sandbox: RUNNING | STOPPED | TIMED_OUT"]
- [FILL: E.g., "Token budget: UNDER_LIMIT | AT_WARNING | EXCEEDED"]

## Scenarios

### SC-001: [FILL: Short descriptive name]
- **Given:** [FILL: Precondition state]
- **When:** [FILL: User/system action]
- **Then:**
  - [ ] [FILL: Expected outcome 1]
  - [ ] [FILL: Expected outcome 2]
- **Actual:** [FILL: Filled by QA Tester during execution]
- **Status:** [FILL: PASS | FAIL | NOT_TESTED]
- **Notes:** [FILL: Edge cases observed, timing details]

### SC-002: [FILL: Recovery from SC-001]
- **Given:** [FILL: State after SC-001]
- **When:** [FILL: Recovery action]
- **Then:**
  - [ ] [FILL: Expected recovery]
- **Actual:** [FILL: ...]
- **Status:** [FILL: ...]

[Scenarios come in pairs: disruption + recovery. Every "When [thing breaks]" gets a "When [thing is restored]." Write "Then" items with concrete thresholds, not vague expectations.]
