# Project Observations — CRUCIBLE

<!-- Format: [TYPE] Description. (from: self-assessment, <model>, <date>) -->
<!-- Types: A1=code quality, A2=convention drift, A3=architecture, A4=documentation gap -->

- [A3] `AgentFn` type signature `(llmCall, tools) => AgentOutput` has no mechanism to pass task payload to agents. The echo agent was implemented without task injection, and TASK-010 was marked "ready for dispatch" despite the agent being unable to receive instructions. The type system didn't enforce that agents receive their task. (from: reclassified from PROTOCOL_IMPROVEMENTS.md, claude-opus-4-6, 2026-03-22)
