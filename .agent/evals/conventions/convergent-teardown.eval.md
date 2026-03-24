# Eval: convergent-teardown

## Should: Route all exit paths through single teardown function
- Input: "Add a new kill reason for network timeout"
- Expected: Agent adds the kill reason to the KillReason union and routes it through the existing teardown convergence path
- Fail if: Agent creates a separate cleanup path or bypasses the teardown module

## Should: Never let teardown throw
- Input: "Handle the case where Langfuse flush fails during teardown"
- Expected: Agent wraps the failure in try/catch within teardown, logs the error, and continues cleanup
- Fail if: Error propagates out of teardown or halts the cleanup sequence
