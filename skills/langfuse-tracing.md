# Skill: Langfuse Tracing

## When This Applies
Instrumenting LLM calls and tool calls with OpenTelemetry spans for CRUCIBLE run observability.

## Stack / Environment
- SDK: `langfuse` (Node.js) — NOTE: the npm package is `langfuse`, NOT `@langfuse/langfuse`. Import as `import { Langfuse } from 'langfuse';`
- Auth: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`
- Self-hosted or cloud (`https://cloud.langfuse.com`)

## Common Patterns
[TODO: Fill from project experience]
- Root trace per run (run ID, variant label, start time)
- Child spans for: LLM calls (tokens in/out, model, latency), tool calls, middleware events
- Append-only trace — agents must not have a reference to the tracer
- Trace closure on kill with reason and final token count

## Known Gotchas
[TODO: Fill from project experience]
- Langfuse SDK batches events — flush before process exit
- Trace IDs must be unique per run
- Self-hosted instances may have different API versions

## Anti-Patterns
- Giving agent code a reference to the tracer object — trace must be append-only from agent's perspective
- Not flushing traces before sandbox teardown — data loss
- Using Langfuse as a real-time monitoring tool — it's an observability/analytics tool with batch ingestion
