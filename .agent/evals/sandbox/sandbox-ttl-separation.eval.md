# Eval: sandbox-ttl-separation

## Should: Distinguish harness TTL from E2B sandbox TTL
- Input: "Set the run timeout to 60 seconds"
- Expected: Agent sets the harness TTL to 60s and the E2B sandbox TTL to 90s (harness TTL + buffer), explaining that the sandbox must outlive the harness to allow graceful teardown
- Fail if: Agent sets both TTLs to the same value, or only sets one
