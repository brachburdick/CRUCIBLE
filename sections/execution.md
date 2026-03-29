# Section: execution

## Purpose

Agent lifecycle management, sandboxed execution, and middleware composition. This section takes a configured task and actually runs an agent on it — managing process/container lifecycle, streaming events, applying kill switches (token budget, loop detection, mutation guard), and collecting artifacts. Three execution backends: E2B sandbox (coder), Claude CLI (claude-cli), Docker container (docker-cli).

## Owned Paths

```
src/agents/coder.ts
src/agents/cli-runner.ts
src/agents/docker-cli-agent.ts
src/agents/echo.ts                    # test agent
src/agents/looping.ts                 # test agent

src/sandbox/runner.ts                 # E2B SandboxRunner
src/sandbox/docker-runner.ts          # Docker container lifecycle
src/sandbox/teardown.ts               # Convergent teardown logic
src/sandbox/runtime-detect.ts         # Runtime ecosystem detection
src/sandbox/index.ts

src/middleware/tokenBudget.ts
src/middleware/loopDetector.ts
src/middleware/mutationGuard.ts
src/middleware/stack.ts                # composeMiddleware()
src/middleware/index.ts
```

## Incoming Inputs

- **From orchestration (via types):** `TaskPayload`, `RunConfig`, `AgentFn`, `Middleware`, `OnTurnCallback`
- **From server (RunEngine):** Execution commands — which agent backend, budget, TTL, seed files, system prompt
- **From environment:** Docker daemon (docker-cli), E2B API (coder), Claude CLI binary (claude-cli), `~/.claude/` OAuth tokens

## Outgoing Outputs

- **Types:** `AgentOutput`, `AgentTurnEvent`, `RunResult`, `ArtifactManifest`, `KillEvent`, `ExecResult`, `CliAgentResult`
- **Events:** `agent_turn_complete`, `token_warning`, `kill`, `run_completed` — emitted via callbacks, consumed by RunEngine/server
- **Side effects:**
  - E2B: sandbox created and destroyed, files uploaded/downloaded
  - Docker: container created, files copied in/out (`docker cp`), container destroyed
  - CLI: temp directory created, `claude -p` subprocess spawned, stdin piped, stdout parsed
  - All backends: artifacts flushed to local filesystem on completion

## Invariants

- **Single convergent teardown path.** All exit codes (0, 1, 2, 3) go through the same cleanup logic (`createIdempotentTeardown`). No exit path skips resource cleanup.
- **Prompt via stdin, not positional argument.** CLI agents (`claude-cli`, `docker-cli`) pipe the prompt to the `claude` process via stdin and close stdin after writing. Passing prompt as a CLI argument is forbidden (shell escaping issues, length limits).
- **Middleware order matters.** `composeMiddleware()` applies middleware in array order. Token budget must wrap loop detector must wrap mutation guard. Reordering changes behavior.
- **No imports from engine/ except types.** Execution never calls ReadinessGate, DecompositionEngine, or GraphExecutor. It receives a task and runs it; it does not decide what to run or how to decompose.
- **Docker `--cap-add NET_ADMIN` required.** The Docker entrypoint uses iptables to lock down network access (Anthropic API endpoints + DNS only). Without NET_ADMIN, the container starts but has unrestricted network access — a security violation.
- **Orphan container cleanup.** DockerRunner tracks running containers. Server startup calls cleanup to destroy containers from previous sessions. Container names are prefixed `crucible-` for identification.

## Allowed Dependencies

**May import:**
- `src/types/` (shared types — consumed, not owned)
- `src/middleware/` (own files)
- `src/agents/` (own files)
- `src/sandbox/` (own files)
- External: `@anthropic-ai/sdk` (coder agent), `e2b` (sandbox runner), `dockerode` or child_process (docker runner), `openai` (embeddings for loop detector)

**Must NOT import:**
- `src/engine/*` (except type-only imports from `src/types/`)
- `src/server/*`
- `src/session/*`
- `src/cli/*`

**Note on telemetry:** `src/telemetry/` is currently imported by `coder.ts` for span creation. This is a known coupling. Acceptable because telemetry is cross-cutting, but if execution needs to be tested without Langfuse, the tracer import must be conditional/mockable.

## How to Verify

```bash
npx vitest run src/test/phase5.test.ts src/test/docker-integration.test.ts src/test/runtime-detect.test.ts
```

These tests cover: CLI agent stream-json parsing, Docker container lifecycle (create → run → flush artifacts → destroy), runtime ecosystem detection, E2B sandbox wrapper, middleware composition (token budget enforcement, loop detection, mutation guard), convergent teardown, stdin prompt delivery.

**Docker tests require:** Docker daemon running, `crucible-runner:latest` image built (`docker build -t crucible-runner:latest ./docker`).

Passing means: all three execution backends can receive a task, run an agent, stream events, enforce kill switches, collect artifacts, and clean up — independently of orchestration logic.
