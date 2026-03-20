# CRUCIBLE — Project CLAUDE.md

## Stack
- TypeScript (ESM, NodeNext), Node 18+
- E2B sandbox runtime for isolated agent execution
- Langfuse for tracing/observability
- OpenAI embeddings for semantic loop detection
- Commander CLI

## Build / Test
```bash
npm run build        # tsc
npm run typecheck    # tsc --noEmit
```

## Architecture
Sandboxed agent evaluation harness. Runs an agent in an E2B sandbox with configurable kill switches (token budget, semantic loop detection, wall-clock TTL). Traces via Langfuse. Outputs structured JSON results.

Key layers: CLI entrypoint -> middleware stack (token budget, loop detector, tracer) -> E2B sandbox wrapper -> teardown convergence.

## Critical Rules
- Single convergent teardown path — all exit codes (0-3) go through the same cleanup.
- Middleware is composed via `composeMiddleware()`, order matters.
- Task payloads are JSON files in `tasks/`.

## Flow Skills
Flow skills (spec/plan/implement/test/verify gates) are inherited from the portfolio level (`skills/`). No project-specific flow modifications needed for CRUCIBLE.

## Gotchas
- OpenAI dependency is for embeddings only (loop detection), not for LLM calls.
- E2B sandbox TTL is separate from the harness TTL flag.
- ESM module resolution — use NodeNext, see `skills/typescript-node.md` for patterns.
