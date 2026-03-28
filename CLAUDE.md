# CRUCIBLE — Project CLAUDE.md

## Stack
- TypeScript (ESM, NodeNext), Node 18+
- E2B sandbox runtime for isolated agent execution
- Claude Code CLI for subscription-based agent execution
- Docker for containerized CLI isolation
- Langfuse for tracing/observability
- OpenAI embeddings for semantic loop detection
- Commander CLI, Fastify web server

## Build / Test
```bash
npm run build        # tsc
npm run typecheck    # tsc --noEmit
npm test             # 139 tests across 35 suites
npm run serve        # web UI at http://localhost:3100
```

## Architecture
Agent evaluation harness with three execution backends. Runs agents with configurable kill switches (token budget, semantic loop detection, wall-clock TTL). Traces via Langfuse. Outputs structured JSON results. Web UI streams events via WebSocket.

### Execution Paths (Agent Types)

| Agent | Backend | Billing | Isolation | When to use |
|---|---|---|---|---|
| `coder` | E2B sandbox + Anthropic API | Per-token (API key) | Full VM | Production evals, untrusted tasks |
| `claude-cli` | Host temp dir + Claude CLI | Subscription (Max plan) | None | Quick local iteration, trusted tasks |
| `docker-cli` | Docker container + Claude CLI | Subscription (Max plan) | Full container | Untrusted tasks without E2B cost |

Key layers:
- **`coder` path**: CLI entrypoint → middleware stack (token budget, loop detector, tracer) → E2B sandbox wrapper → teardown convergence
- **`claude-cli` path**: RunEngine → temp dir + seed files → `claude -p` subprocess → stream-json parser → event emission → cleanup
- **`docker-cli` path**: RunEngine → DockerRunner.create() → container + seed files → `docker exec claude -p` → stream-json parser → `docker cp` artifacts → container destroy

### CLI Agent Architecture
Both `claude-cli` and `docker-cli` share the same stream-json parsing logic (`parseCliStream()` in `src/agents/cli-runner.ts`). The prompt is delivered via **stdin pipe** (not positional argument). Events are mapped from CLI stream-json types to CRUCIBLE `AgentTurnEvent` types.

### Docker Runner (`src/sandbox/docker-runner.ts`)
Manages Docker container lifecycle: `create()` → `run()` → `runChecks()` → `flushArtifacts()` → `destroy()`. Auth via read-only mount of `~/.claude/`. Network locked down via iptables in `docker/entrypoint.sh` (allows only Anthropic API endpoints + DNS). Orphan cleanup at server startup.

Build image: `docker build -t crucible-runner:latest ./docker`

## Critical Rules
- Single convergent teardown path — all exit codes (0-3) go through the same cleanup.
- Error catch blocks in RunEngine MUST emit `run_completed` event (prevents stuck "running" status).
- Middleware is composed via `composeMiddleware()`, order matters (coder path only).
- CLI agents pipe prompt via stdin, not positional argument.
- Task payloads are JSON files in `tasks/`.

## Trigger Table
| Task Pattern | Skill | Notes |
|---|---|---|
| E2B sandbox / sandbox lifecycle / artifact flush | skills/e2b-sandbox.md | TTL, network policy, file upload |
| Docker runner / container lifecycle / docker-cli | specs/sdk-orchestration.md | Appendix B: WS-7 |
| CLI runner / claude-cli / stream-json | specs/sdk-orchestration.md | Appendix A: WS-6 |
| Langfuse / tracing / observability / spans | skills/langfuse-tracing.md | SDK type gotchas, trace patterns |
| TypeScript / ESM / NodeNext / module resolution | skills/typescript-node.md | Extensions, barrel files |

## Flow Skills
Flow skills (spec/plan/implement/test/verify gates) are inherited from the portfolio level (`skills/`). No project-specific flow modifications needed for CRUCIBLE.

## Gotchas
- OpenAI dependency is for embeddings only (loop detection), not for LLM calls.
- E2B sandbox TTL is separate from the harness TTL flag.
- ESM module resolution — use NodeNext, see `skills/typescript-node.md` for patterns.
- `--bare` flag is NOT supported on Claude CLI v2.1.79. Do not add it to CLI args.
- CLI agents must close stdin after writing the prompt, or the CLI hangs waiting for input.
- Docker `--cap-add NET_ADMIN` is required for iptables network lockdown in the container entrypoint.
