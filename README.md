# CRUCIBLE

Sandboxed agent evaluation harness for testing AI orchestration pipeline variants autonomously, with hard safety stops.

CRUCIBLE runs an agent inside an isolated [E2B](https://e2b.dev) sandbox, monitors it with configurable kill switches (token budget, semantic loop detection, wall-clock TTL), traces every call via [Langfuse](https://langfuse.com), and writes a structured JSON result when the run ends — cleanly or killed.

## Prerequisites

- **Node.js** 18+
- **E2B account** — sandbox runtime ([e2b.dev](https://e2b.dev))
- **Anthropic API key** — LLM calls (Claude)
- **OpenAI API key** — embeddings for semantic loop detection (`text-embedding-3-small`)
- **Langfuse instance** — tracing (cloud or self-hosted)

## Setup

```bash
git clone <repo-url> && cd crucible
npm install
cp .env.example .env
# Fill in your API keys in .env
npm run build
```

## Usage

```bash
npx crucible run --task <file> [--variant <label>] [--budget <tokens>] [--ttl <seconds>]
```

### Flags

| Flag | Required | Description | Default |
|------|----------|-------------|---------|
| `--task <file>` | Yes | Path to task payload JSON file | — |
| `--variant <label>` | No | Label for this run variant | `default` |
| `--budget <tokens>` | No | Token budget for the run | `DEFAULT_TOKEN_BUDGET` env or `100000` |
| `--ttl <seconds>` | No | Wall-clock time limit in seconds | `DEFAULT_TTL_SECONDS` env or `300` |

### Examples

```bash
# Run with defaults
npx crucible run --task tasks/example-simple.json

# Run with custom budget and TTL
npx crucible run --task tasks/example-simple.json --variant v1-fast --budget 50000 --ttl 120
```

### Task Payload Format

Task files are JSON with this structure:

```json
{
  "description": "Write a haiku about programming to a file",
  "instructions": "Write a haiku about programming. Save it to haiku.txt.",
  "files": { "input.txt": "optional initial file content" },
  "networkAllowlist": []
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `description` | Yes | Short description of the task |
| `instructions` | Yes | Full instructions for the agent |
| `files` | No | Key-value map of files to upload to the sandbox before the run |
| `networkAllowlist` | No | Domains the sandbox may access (empty or omitted = fully locked) |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `E2B_API_KEY` | E2B sandbox API key | — (required) |
| `ANTHROPIC_API_KEY` | Anthropic API key for LLM calls | — (required) |
| `OPENAI_API_KEY` | OpenAI API key for embeddings (loop detector) | — (required) |
| `LANGFUSE_PUBLIC_KEY` | Langfuse public key | — (required) |
| `LANGFUSE_SECRET_KEY` | Langfuse secret key | — (required) |
| `LANGFUSE_HOST` | Langfuse host URL | `https://cloud.langfuse.com` |
| `DEFAULT_TOKEN_BUDGET` | Default token budget when `--budget` is not passed | `100000` |
| `DEFAULT_TTL_SECONDS` | Default TTL when `--ttl` is not passed | `300` |
| `LOOP_WINDOW_SIZE` | Number of recent messages to keep for similarity comparison | `8` |
| `LOOP_SIMILARITY_THRESHOLD` | Cosine similarity threshold to flag a loop | `0.92` |
| `LOOP_CONSECUTIVE_TURNS` | Consecutive high-similarity turns before killing | `5` |

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Clean completion — agent finished normally |
| `1` | Budget exceeded — token budget was exhausted |
| `2` | Loop detected — semantic loop detector triggered |
| `3` | TTL exceeded — wall-clock time limit reached |

## Architecture Overview

CRUCIBLE is a library + CLI with four layers:

```
CLI (src/cli/)
 ├── Middleware (src/middleware/)  — token budget, loop detector
 ├── Sandbox (src/sandbox/)       — E2B lifecycle, ToolContext facade
 └── Telemetry (src/telemetry/)   — Langfuse tracing
```

**LLM calls are host-side.** The E2B sandbox is purely an execution environment for agent tool actions (file I/O, shell commands). All LLM calls, token counting, loop detection, and tracing happen in the host Node.js process. The sandbox outbound network is fully locked by default.

The agent receives two things: a middleware-wrapped LLM call function and a `ToolContext` facade over sandbox operations. The agent has no reference to the tracer, the budget counter, or the sandbox handle directly.

### Middleware Stack

The middleware composes as a chain of wrappers around the base LLM call:

```
loopDetector → tokenBudget → tracer → baseLlmCall
```

- **Loop detector** runs before each call — embeds the input message, checks cosine similarity against a rolling window.
- **Token budget** runs after each call — counts tokens from the response, throws `BudgetExceededError` at 100%.
- **Tracer** wraps the actual API call with a Langfuse span.

## Kill Switches

Three independent kill switches protect every run. All paths converge on the same teardown sequence.

### Priority Order

1. **Token Budget** — checks after each LLM call. Fires first because it evaluates on every response.
2. **Loop Detector** — checks before each LLM call by embedding the input. Embedding latency means budget usually wins on the same turn if both conditions are met.
3. **TTL** — wall-clock backstop via `setTimeout`. Fires independently of LLM call cadence.

### Teardown Sequence

Regardless of how a run ends, the same teardown runs:

1. Log structured `KillEvent` JSON
2. Flush artifacts from sandbox to `./runs/<runId>/`
3. Close Langfuse trace
4. Destroy E2B sandbox
5. Write `RunResult` to `./runs/<runId>/result.json`

E2B's native TTL is set to `ttlSeconds + 30` as a hard backstop in case graceful teardown hangs.

## Project Structure

```
crucible/
├── src/
│   ├── cli/           # CLI entrypoint, run orchestration
│   ├── middleware/     # Token budget, loop detector, stack composer
│   ├── sandbox/        # E2B wrapper, ToolContext facade, teardown
│   ├── telemetry/      # Langfuse tracer
│   └── types/          # All shared interfaces, error classes
├── tasks/              # Example task payloads
├── runs/               # Output directory for run results (gitignored)
├── .env.example        # Environment variable template
├── package.json
└── tsconfig.json
```

## Output

Each run writes results to `./runs/<runId>/`:

| File | Description |
|------|-------------|
| `result.json` | Structured `RunResult` with exit reason, token usage, wall time, and artifact manifest |
| `*.{txt,json,...}` | Any artifacts the agent produced inside the sandbox, flushed during teardown |

The `result.json` includes:

- `runId` — unique identifier
- `variantLabel` — the variant label passed via `--variant`
- `exitReason` — discriminated union: `completed`, `budget_exceeded`, `loop_detected`, or `ttl_exceeded`
- `tokenUsage` — prompt, completion, and total token counts
- `wallTimeMs` — total wall-clock duration
- `startedAt` / `completedAt` — ISO 8601 timestamps
- `artifacts` — manifest of files flushed from the sandbox
