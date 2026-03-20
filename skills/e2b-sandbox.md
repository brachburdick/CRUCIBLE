# Skill: E2B Sandbox SDK

## When This Applies
Working with E2B sandboxes for isolated code execution in CRUCIBLE.

## Stack / Environment
- SDK: `e2b` or `@e2b/code-interpreter` (Node.js)
- Auth: `E2B_API_KEY` environment variable
- Sandboxes have configurable TTL (time-to-live)
- Network: outbound disabled by default, explicit allowlist only

## Common Patterns
[TODO: Fill from project experience]
- Sandbox creation with TTL
- File upload/download to sandbox filesystem
- Command execution inside sandbox
- Artifact retrieval before teardown
- Network policy configuration

## Known Gotchas
[TODO: Fill from project experience]
- Sandbox teardown is async — ensure artifact flush completes before kill
- TTL is wall-clock time, not CPU time
- E2B has its own timeout mechanism separate from any application-level timers

## Anti-Patterns
- Running without a TTL — sandbox can run indefinitely and rack up costs
- Relying on sandbox filesystem persistence between runs — sandboxes are ephemeral
- Starting outbound network access without an explicit allowlist
