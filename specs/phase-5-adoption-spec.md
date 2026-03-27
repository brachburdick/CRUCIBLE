---
status: DRAFT (fragility-assessed)
created: 2026-03-27
project: CRUCIBLE
phase: 5
title: Ecosystem Adoption & Interoperability
research_inputs:
  - "support/research/crucible-adoption-analysis.md"
  - "CRUCIBLE_GPT_migrate_for_adoption.md"
supersedes: none
---

# Phase 5: Ecosystem Adoption & Interoperability

## 1. Problem Statement

CRUCIBLE builds most infrastructure from scratch: proprietary Langfuse tracing, custom loop detection, hand-authored task payloads, ad-hoc variant comparison heuristics. The ecosystem has matured enough that real dependency swaps exist — not convention-alignment, but actual integrations that reduce maintenance surface while expanding capabilities.

Three categories of work:

1. **Open CRUCIBLE to external agents** — MCP server turns the sandbox into a universal evaluation target
2. **Replace proprietary integrations with standards** — OTel replaces Langfuse SDK lock-in; JSON Schema replaces ad-hoc validation
3. **Expand evaluation capability** — three-tier loop detection, Elo ranking, SWE-bench ingestion, Inspect AI scoring

### What Success Looks Like

- Any MCP-capable agent can connect to a CRUCIBLE sandbox and be evaluated without writing CRUCIBLE-specific code
- Traces are portable to any OTel backend (Datadog, Jaeger, Grafana Tempo) via exporter config change
- CRUCIBLE can ingest SWE-bench tasks and produce results comparable with SWE-agent, Devin, OpenHands
- Variant ranking uses statistical methods (Elo, Bradley-Terry) instead of cascading heuristics

---

## 2. Workstream Overview

Nine proposals from two independent analyses, deduplicated and prioritized. Grouped into three implementation phases. Dependency fragility assessed — see §8 for rationale on what was revised.

| # | Workstream | Effort | Impact | Phase | New Deps |
|---|-----------|--------|--------|-------|----------|
| 5.1 | MCP Sandbox Server | Medium | Very High | A | `@modelcontextprotocol/sdk` |
| 5.2 | OTel Telemetry (replace Langfuse SDK) | Medium | High | A | `@opentelemetry/*` (3 pkgs) |
| 5.3 | Prometheus Metrics (extends 5.2) | Low | Medium | A | `@opentelemetry/*` (2 pkgs) |
| 5.4 | Three-Tier Loop Detection (native TS) | Medium | High | B | None |
| 5.5 | SWE-bench Task Ingestion | Low | High | B | None |
| 5.6 | Elo/Bradley-Terry Variant Ranking | Low | Medium | B | None |
| 5.7 | JSON Schema + OpenAPI | Low | Medium | C | `@fastify/swagger` |
| 5.8 | Inspect AI Scoring (depends on 5.5) | Medium | Medium | C | `inspect-ai` (Python subprocess) |
| 5.9 | Docker Containerization | Low | High | C | None |

**Phase A** = highest leverage, no cross-dependencies.
**Phase B** = core differentiators + benchmark ecosystem. Zero new npm deps.
**Phase C** = polish, packaging, benchmark scoring.

**Net dependency change:** +6 runtime deps, −1 (`langfuse`). No Python in the hot path.

---

## 3. Workstream Specifications

### 5.1 — MCP Sandbox Server

**Goal:** Expose `ToolContext` operations as MCP tools so any MCP-capable agent can be evaluated.

**Current state:** Only `AgentFn` implementations can use the sandbox. Evaluating a new agent requires writing a CRUCIBLE wrapper.

**What changes:**
- New dependency: `@modelcontextprotocol/sdk`
- New file: `src/server/mcp.ts` — creates `McpServer` from a `ToolContext`
- Three MCP tools: `exec`, `writeFile`, `readFile` — directly wrapping `ToolContext`
- MCP resources: sandbox file listing, cwd
- New CLI mode: `npx crucible serve-mcp --task <file>` — starts sandbox + MCP server, waits for external agent

**MCP tool definitions:**

| Tool | Input Schema | Maps To |
|------|-------------|---------|
| `exec` | `{ command: string }` | `ToolContext.exec()` |
| `writeFile` | `{ path: string, content: string }` | `ToolContext.writeFile()` |
| `readFile` | `{ path: string }` | `ToolContext.readFile()` |

**Architecture:**
```
External Agent ──MCP──> CRUCIBLE MCP Server
                              │
                        ┌─────┴─────┐
                        │ Middleware │  (token budget, loop detector, mutation guard)
                        └─────┬─────┘
                              │
                        ┌─────┴─────┐
                        │ ToolContext│  (E2B sandbox facade)
                        └───────────┘
```

Kill switches (token budget, loop detection, TTL) still apply — they wrap MCP tool responses. The middleware stack is identical to `AgentFn` mode.

**Key constraint:** MCP server must go through the same middleware stack as internal agents. No bypass path.

**Transport:** MCP SSE transport is deprecated. Use **stdio** for local CLI usage and **Streamable HTTP** for remote/networked agents. The `@modelcontextprotocol/sdk` v1.28+ supports both natively.

**New types:**
```typescript
interface McpServerOptions {
  taskPayload: TaskPayload;
  tokenBudget: number;
  ttlSeconds: number;
  loopDetection: LoopDetectorConfig;
  transport: 'stdio' | 'streamable-http';  // stdio for CLI, Streamable HTTP for remote
}
```

**Dependency note:** `@modelcontextprotocol/sdk` is at v1.28.0 (5.6M weekly downloads, maintained by Anthropic). v2 is in pre-alpha; v1.x gets 6 months of support after v2 ships. Pin to `^1.28.0`.

**Tests:**
- MCP tool call → ToolContext delegation (unit, mock sandbox)
- Kill switch triggers via MCP (token budget exceeded mid-tool-call)
- TTL expiry tears down MCP server cleanly

---

### 5.2 — OpenTelemetry Telemetry (Replace Langfuse SDK)

**Goal:** Replace `langfuse` SDK with OTel SDK. Langfuse v3 becomes an OTLP backend, not a client dependency.

**Current state:** `src/telemetry/tracer.ts` uses `langfuse.trace()`, `trace.generation()`. Traces are locked to Langfuse.

**What changes:**
- Remove dependency: `langfuse`
- Add dependencies: `@opentelemetry/api`, `@opentelemetry/sdk-trace-node`, `@opentelemetry/exporter-trace-otlp-http`
- `RunTracer.create()` initializes OTel `TracerProvider` with OTLP exporter (pointed at Langfuse or any OTel backend)
- `createTracerMiddleware()` creates OTel spans instead of Langfuse generations
- `traceToolCall()` / `traceMiddlewareEvent()` become OTel span creation
- `close()` calls `tracerProvider.shutdown()` instead of `langfuse.flushAsync()`

**OTel GenAI semantic convention attributes:**

| Attribute | Value | Span Type |
|-----------|-------|-----------|
| `gen_ai.operation.name` | `chat`, `execute_tool`, `invoke_agent` | All |
| `gen_ai.request.model` | e.g. `claude-opus-4-20250514` | LLM call |
| `gen_ai.usage.input_tokens` | integer | LLM call |
| `gen_ai.usage.output_tokens` | integer | LLM call |
| `gen_ai.agent.name` | variant label | Root |
| `gen_ai.tool.name` | `exec`, `writeFile`, `readFile` | Tool call |

**Risk: GenAI semantic conventions are experimental** (v1.40.0 as of Feb 2025). Breaking changes every 2-3 months — v1.37 restructured message attributes, v1.38 removed `gen_ai.prompt`/`gen_ai.completion` entirely, v1.39 deprecated `gen_ai.system`. This is the main fragility in the OTel adoption.

**Mitigation (mandatory):**
1. All `gen_ai.*` attribute names live in a single constants file: `src/telemetry/otel-attributes.ts`
2. Pin `@opentelemetry/semantic-conventions` to a specific version (not `^`)
3. Accept quarterly review of attribute names as maintenance cost
4. The OTel core SDK (`@opentelemetry/api`, `sdk-trace-node`) is stable (v2.6.0) — the risk is only in the convention names, not the tracing infrastructure

**Langfuse v3 OTLP details:** Langfuse accepts standard OTLP over HTTP (not gRPC). Auth is HTTP Basic: `Authorization: Basic <base64(public_key:secret_key)>`. Endpoint: `<host>/api/public/otel`. Requires Langfuse v3.22.0+. No proprietary protocol.

**Public API unchanged:** `RunTracer.create()`, `createTracerMiddleware()`, `traceToolCall()`, `traceMiddlewareEvent()`, `close()` — same signatures, different internals.

**Env vars:**
- Remove: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`
- Add: `OTEL_EXPORTER_OTLP_ENDPOINT` (defaults to `http://localhost:4318`), `OTEL_SERVICE_NAME` (defaults to `crucible`)
- Langfuse v3 users: point `OTEL_EXPORTER_OTLP_ENDPOINT` at their Langfuse OTLP endpoint

**Tests:**
- Span creation verified via in-memory OTel exporter (no network calls)
- Token usage attributes present on LLM call spans
- `close()` flushes provider without throwing on failure

---

### 5.3 — Prometheus Metrics Exporter

**Goal:** Expose operational metrics at `/metrics` for Prometheus scraping.

**Depends on:** 5.2 (shares OTel initialization).

**What changes:**
- Add dependencies: `@opentelemetry/sdk-metrics`, `@opentelemetry/exporter-prometheus`
- `src/server/index.ts` gets a `/metrics` route
- Metrics initialized alongside traces in OTel setup

**Metrics:**

| Metric | Type | Labels |
|--------|------|--------|
| `crucible_runs_total` | Counter | `status`, `variant` |
| `crucible_run_duration_seconds` | Histogram | `variant`, `task` |
| `crucible_tokens_used_total` | Counter | `variant`, `direction` |
| `crucible_sandbox_startup_seconds` | Histogram | — |
| `crucible_loop_detections_total` | Counter | `tier` |
| `crucible_budget_exceeded_total` | Counter | — |

**Tests:**
- `/metrics` returns Prometheus text format
- Counter increments on run completion

---

### 5.4 — Three-Tier Loop Detection (Native TS)

**Goal:** Add action-pattern detection and progress tracking alongside the existing embedding detector. All three tiers implemented in native TypeScript — zero new dependencies.

**Current state:** `src/middleware/loopDetector.ts` is purely embedding-based. Misses identical tool-call sequences, write-revert cycles, stalled progress.

**Why not `invariant-ai`:** The original spec proposed importing `invariant-ai` as an in-process library. Research revealed it's **Python-only** (no npm package exists, no TypeScript SDK). Options were: (a) Python subprocess on every LLM call (latency disaster in the inner loop), (b) HTTP gateway (heavy, adds network hop), (c) port the concept to native TS. Option (c) wins — the pattern matching for "N identical tool calls" and "write-revert-write" is a sliding window over a tool-call history array, not a complex NLP problem. Invariant's value is their declarative rule language with quantifiers; CRUCIBLE's initial rule set is small enough that a purpose-built matcher is simpler and has zero dependency risk.

**Three tiers:**

| Tier | Method | Catches | Implementation |
|------|--------|---------|----------------|
| 1 | Action pattern matching (native TS) | Identical tool sequences, write-revert cycles, repeated failed execs | New file, zero deps |
| 2 | Embedding similarity | Semantically identical but syntactically different messages | Existing (unchanged) |
| 3 | Progress tracking (native TS) | N turns with no new artifacts or test result changes | New file, zero deps |

**What changes:**
- New file: `src/middleware/actionPatternDetector.ts` — sliding window over tool-call history, pattern matching
- New file: `src/middleware/progressTracker.ts` — monitors `ToolContext` for new artifacts between turns
- New file: `src/middleware/loopDetectionStack.ts` — composes all three tiers
- Extend `LoopDetectorConfig` with `actionPatterns` section
- No new dependencies

**Tier 1 — Action Pattern Detector:**

Maintains a rolling buffer of `{ toolName, args, result }` records. Checks three patterns after each tool call:

1. **Consecutive identical calls:** If the last N entries have identical `toolName` + `args` (deep equality), fire. Default N=3.
2. **Write-revert-write:** If `writeFile(path, contentA)` is followed by `writeFile(path, contentB)` then `writeFile(path, contentA)` (same path, content reverts), fire.
3. **Repeated failed execs:** If the last N `exec` calls have identical args and all returned non-zero exit codes, fire. Default N=3.

Implementation: ~80 lines. Sliding window of configurable size (default 20 tool calls). Pattern checks are O(window_size) per tool call — negligible vs. LLM latency.

**Tier 3 — Progress Tracker:**

Tracks sandbox state between turns:
- Snapshot file listing after each tool-call batch
- If N consecutive turns produce no new files and no test result changes (same exit codes for same commands), flag as stalled
- Default stalled threshold: 5 turns

Requires `ToolContext.exec('find . -type f')` or equivalent — lightweight sandbox query.

**New types:**
```typescript
/** Recorded tool call for pattern matching */
interface ToolCallRecord {
  toolName: string;
  args: Record<string, unknown>;
  result: { exitCode?: number; error?: boolean };
  timestamp: number;
}

interface LoopDetectionStackConfig {
  actionPatterns?: {
    enabled: boolean;
    windowSize?: number;              // default: 20
    maxConsecutiveIdentical?: number;  // default: 3
    maxRepeatedFailedExecs?: number;   // default: 3
    detectWriteRevert?: boolean;       // default: true
  };
  embedding?: LoopDetectorConfig;     // existing config, unchanged
  progress?: {
    enabled: boolean;
    stalledTurnThreshold?: number;    // default: 5
  };
}

type LoopDetectionTier = 'action_pattern' | 'embedding_similarity' | 'progress_stall';
```

**Composition:** `createLoopDetectionStack()` returns a middleware that runs tiers in order: tier 1 (fast, synchronous) → tier 2 (async, embedding API call) → tier 3 (async, sandbox query). First tier to fire wins. Each tier's detection is reported with its `LoopDetectionTier` label for the Prometheus `crucible_loop_detections_total{tier}` counter.

**Tests:**
- Tier 1: 3 identical `exec("python test.py")` calls triggers detection
- Tier 1: write-revert-write on same path fires
- Tier 1: 3 failed execs with same args fires
- Tier 1: different tool calls in sequence does NOT fire
- Tier 3: N turns with no new artifacts = stalled
- Tier 3: new file creation resets stall counter
- Combined: each tier fires independently, first match wins
- Combined: tier ordering is correct (fast tiers checked first)

---

### 5.5 — SWE-bench Task Ingestion

**Goal:** CLI command to pull SWE-bench instances from HuggingFace and convert to CRUCIBLE task payloads.

**What changes:**
- New CLI command: `npx crucible ingest --source swe-bench --dataset princeton-nlp/SWE-bench_Verified --limit 10`
- New file: `src/cli/ingest.ts`
- Pulls JSONL from HuggingFace datasets API (HTTP, no Python dependency)
- Converts each instance to `TaskPayload`:
  - `instance_id` → `metadata.instance_id`
  - `problem_statement` → `description` + `instructions`
  - `repo` + `base_commit` → `seedDir` generation (clone + checkout)
  - `FAIL_TO_PASS` → generated `CheckSpec` entries
  - `PASS_TO_PASS` → generated `CheckSpec` entries
- Writes to `tasks/swe-bench/<instance_id>.json`

**Extended TaskPayload fields:**
```typescript
// Added to existing TaskPayload interface
interface TaskPayload {
  // ... existing fields unchanged ...

  /** Benchmark interop */
  inspect_task?: string;          // Inspect AI task ID for delegated scoring
  benchmark?: {
    source: string;               // e.g. "swe-bench"
    instance_id: string;          // original benchmark ID
    repo?: string;                // e.g. "django/django"
    base_commit?: string;         // commit to checkout
    FAIL_TO_PASS?: string[];      // tests that must flip
    PASS_TO_PASS?: string[];      // tests that must stay passing
    patch?: string;               // reference patch (for scoring comparison)
  };
}
```

**Note:** Benchmark fields are nested under `benchmark` rather than flattened onto `TaskPayload` to keep the core interface clean. The `benchmark` field is optional — existing tasks are unaffected.

**Tests:**
- HuggingFace JSONL parsing (mock HTTP response)
- Field mapping correctness (instance_id, problem_statement, checks)
- Generated CheckSpec entries match FAIL_TO_PASS/PASS_TO_PASS

---

### 5.6 — Elo/Bradley-Terry Variant Ranking

**Goal:** Replace cascading heuristic winner selection with statistical ranking.

**Current state:** `src/cli/compare.ts` picks a winner via: completed > pass rate > fewer tokens > faster.

**What changes:**
- New file: `src/engine/ranking.ts` — Elo update + Bradley-Terry MLE (~50 lines each)
- New CLI command: `npx crucible rank --runs-dir ./runs/comparisons/`
- Reads `ComparisonResult` JSON files, extracts pairwise outcomes, produces ranked leaderboard

**Algorithms:**
- **Elo:** Standard chess-style with configurable K-factor. Updates after each pairwise comparison.
- **Bradley-Terry:** MLE of variant strength from batch pairwise data. More rigorous when all comparisons known upfront.

**Output:**
```typescript
interface RankingResult {
  rankings: Array<{
    variant: string;
    elo: number;
    bradleyTerry: number;
    wins: number;
    losses: number;
    ties: number;
  }>;
  comparisons: number;
  tasks: string[];
}
```

**Why TypeScript, not a Python dep:** The algorithms are mathematically simple (~50 lines each). Native TS avoids a subprocess dependency for this narrow use case.

**Tests:**
- Known pairwise outcomes produce expected Elo ratings
- Bradley-Terry converges on known strength parameters
- Ties handled correctly

---

### 5.7 — JSON Schema + OpenAPI

**Goal:** Schema-validate task payloads, variant configs, and HTTP endpoints.

**What changes:**

**JSON Schema (hand-authored, no codegen):**
- Hand-author `schemas/task-payload.schema.json`, `schemas/variant-config.schema.json`, `schemas/check-spec.schema.json`
- Three schemas for three stable interfaces — small enough that hand-authoring is faster and more reliable than a codegen build step
- `src/engine/validation.ts` uses `ajv` (transitive dep via Fastify) for runtime validation
- Task JSON files reference `"$schema": "../schemas/task-payload.schema.json"` for IDE autocompletion

**Why no `ts-json-schema-generator`:** Adds a build step that must stay in sync with TypeScript types. If it breaks or drifts, schemas silently diverge. The three schemas are small and change infrequently — hand-authoring takes ~30 minutes and eliminates the sync risk entirely.

**OpenAPI for Fastify:**
- Add dep: `@fastify/swagger` (spec generation only)
- Route handlers in `routes/runs.ts` get Fastify JSON Schema annotations
- `/docs/json` serves OpenAPI 3.0 spec (machine-readable, usable with any external Swagger UI or client codegen)

**Why no `@fastify/swagger-ui`:** 2MB of static assets for a CLI-first tool. Anyone who wants a visual UI can paste the `/docs/json` output into swagger.io/editor or import into Postman. The spec generation (`@fastify/swagger`) is the valuable part.

**Tests:**
- Valid task payload passes schema validation
- Invalid payload (missing required field) rejected at runtime
- `/docs/json` returns valid OpenAPI 3.0 document

---

### 5.8 — Inspect AI Scoring

**Goal:** Delegate standardized benchmark scoring to Inspect AI as a Python subprocess.

**Depends on:** 5.5 (SWE-bench tasks must exist).

**What changes:**
- When `TaskPayload.inspect_task` is set, scoring calls `python -m inspect eval` as subprocess
- New function: `runInspectScoring()` in `src/engine/scorer.ts`
- Captures Inspect's `EvalLog` JSON, maps to CRUCIBLE `ScoreResult`
- CRUCIBLE's `CheckSpec` system stays for custom checks — Inspect handles standardized benchmarks

**Concept mapping:**

| Inspect | CRUCIBLE | Notes |
|---------|----------|-------|
| `Dataset` | `TaskPayload` | Task definition |
| `Solver` | `AgentFn` + variant | Pipeline under test |
| `Scorer` | `runChecks()` | Post-run evaluation |
| `EvalLog` | `RunResult` + `ScoreResult` | Structured output |
| `Score(value, explanation)` | `CheckResult { passed, stdout }` | Per-check result |

**Trade-off:** Adds Python runtime dependency (~36MB wheel, 30+ transitive deps). Acceptable because:
- E2B sandboxes already have Python
- THE_FACTORY has Python infrastructure (`.venv/`, `scripts/`)
- Inspect is only invoked for benchmark tasks, not custom evaluations
- It's in the scoring path (post-run), not the hot loop

**Inspect AI maturity:** v0.3.201, 15M monthly downloads, 208 contributors, MIT license, weekly releases. SWE-bench support is real and working. CLI: `inspect eval <task> --model <model> --log-format json`. JSON output is file-based (written to `./logs/`), not stdout — `runInspectScoring()` must read the log file after subprocess completes.

**Tests:**
- Mock `inspect eval` subprocess + log file output, verify EvalLog parsing
- Fallback to CheckSpec when `inspect_task` not set

---

### 5.9 — Docker Containerization

**Goal:** Single `docker run` command to start CRUCIBLE.

**What changes:**
- `Dockerfile` — multi-stage: build (`npm ci && npm run build`) + runtime (`node:18-slim`)
- `docker-compose.yml` — CRUCIBLE server + Prometheus + Grafana (optional) + Langfuse (optional)
- `.dockerignore` — excludes `node_modules`, `dist`, `data/`, `.env`
- npm scripts: `npm run docker:build`, `npm run docker:up`

**Note:** E2B sandbox calls out to E2B cloud — the sandbox itself isn't containerized, but the harness orchestration is.

**Tests:**
- Dockerfile builds successfully
- Container starts and `/api/health` responds

---

## 4. Dependency Impact

### New Runtime Dependencies (npm)

| Package | Purpose | Workstream | Weekly Downloads | Maintainer |
|---------|---------|-----------|-----------------|------------|
| `@modelcontextprotocol/sdk` | MCP server | 5.1 | 5.6M | Anthropic |
| `@opentelemetry/api` | Trace API | 5.2 | High (core OTel) | OTel project |
| `@opentelemetry/sdk-trace-node` | Trace SDK | 5.2 | 799 dependents | OTel project |
| `@opentelemetry/exporter-trace-otlp-http` | OTLP export | 5.2 | — | OTel project |
| `@opentelemetry/sdk-metrics` | Metrics API | 5.3 | — | OTel project |
| `@opentelemetry/exporter-prometheus` | Prometheus endpoint | 5.3 | — | OTel project |
| `@fastify/swagger` | OpenAPI spec generation | 5.7 | — | Fastify team |

### New Subprocess Dependencies (Python, not in node_modules)

| Package | Purpose | Workstream | Monthly Downloads | Notes |
|---------|---------|-----------|------------------|-------|
| `inspect-ai` | Benchmark scoring | 5.8 | 15M | Invoked post-run only, not in hot path |

### Removed Dependencies

| Package | Replaced By |
|---------|------------|
| `langfuse` | `@opentelemetry/*` (Langfuse v3 accepts OTLP natively) |

### Dependencies Considered and Rejected

| Package | Original Workstream | Rejection Reason |
|---------|-------------------|-----------------|
| `invariant-ai` | 5.4 | Python-only (no npm package). Would require subprocess on every LLM call. Concept ported to native TS instead. |
| `@fastify/swagger-ui` | 5.7 | 2MB static assets for a CLI-first tool. `/docs/json` endpoint sufficient. |
| `ts-json-schema-generator` | 5.7 | Build step sync risk. Three small schemas hand-authored instead. |

### New Dev Dependencies

None.

### Unchanged
`e2b`, `commander`, `openai` (embeddings), `fastify`, `better-sqlite3`, `yaml`

---

## 5. What Stays Custom (and Should)

- **DecompositionGraph data model** (`types/graph.ts`) — no standard exists
- **Pipeline variant comparison framework** — the D/V/T search space is novel
- **Convergent teardown** (`sandbox/teardown.ts`) — architecture-specific, correct
- **Middleware composition** (`composeMiddleware()`) — simple, correct, specific
- **MutationTracker / MutationGuard** — THE_FACTORY enforcement, no external equivalent
- **Session model** (`src/session/`) — THE_FACTORY lifecycle, no external equivalent

---

## 6. What Was Considered and Rejected

### Proposals Rejected (from GPT analysis)

| Proposal | Rejection Reason |
|----------|-----------------|
| MLflow experiment tracking | CRUCIBLE evaluates agents, not ML models. THE_FACTORY's run records + assess.py cover this. |
| Kubernetes orchestration | Premature. Single-service harness. Docker is sufficient. |
| gRPC | Fastify HTTP is adequate. 99% of time is LLM/sandbox latency. |
| Agent Client Protocol (ACP) | CRUCIBLE is an eval harness, not an IDE agent. MCP is the correct protocol. |
| S3-compatible storage | Artifacts are small JSON. Local storage + SQLite are adequate. |

### Dependencies Rejected (from fragility assessment)

| Dependency | Original Workstream | Rejection Reason |
|------------|-------------------|-----------------|
| `invariant-ai` | 5.4 (loop detection) | **No npm package exists.** Python-only (776 downloads/month on PyPI). The spec proposed in-process import — impossible in TypeScript. Subprocess on every LLM call is a latency disaster. The rule-matching concept (sliding window pattern detection) is ~80 lines of TS. Ported natively. |
| `@fastify/swagger-ui` | 5.7 (OpenAPI) | 2MB static assets for a CLI-first tool. The spec generation (`@fastify/swagger`) provides `/docs/json` — users paste into swagger.io/editor or Postman. |
| `ts-json-schema-generator` | 5.7 (JSON Schema) | Adds a build step that must stay synchronized with TypeScript types. Silent drift risk. Three small, stable schemas hand-authored in ~30 minutes instead. |

---

## 7. Implementation Order

```
Phase A (parallel, no cross-deps):
  5.1 MCP Server
  5.2 OTel Telemetry
  5.3 Prometheus Metrics (after 5.2)

Phase B (after A):
  5.4 Three-Tier Loop Detection
  5.5 SWE-bench Ingestion
  5.6 Elo/Bradley-Terry Ranking

Phase C (after B):
  5.7 JSON Schema + OpenAPI
  5.8 Inspect AI Scoring (after 5.5)
  5.9 Docker Containerization
```

Each workstream is a self-contained unit of work with its own tests. No workstream modifies existing Phase 0–4 behavior — all changes are additive or replacement-in-kind (OTel replacing Langfuse with identical public API).

---

## 8. Fragility Assessment

Every proposed dependency was researched for actual ecosystem maturity (npm/PyPI downloads, maintenance status, API stability, TypeScript availability). This section documents the risk profile of each retained dependency.

### Retained Dependencies — Risk Profile

| Dependency | Risk | Rationale |
|------------|------|-----------|
| `@modelcontextprotocol/sdk` | **Low** | 5.6M weekly downloads, v1.28.0, Anthropic-maintained. v2 migration coming but v1 gets 6 months of support. Pin `^1.28.0`. |
| `@opentelemetry/api` + `sdk-trace-node` | **Low** | Core OTel SDK is stable (v2.6.0). 799 downstream npm packages. The infrastructure is mature. |
| `@opentelemetry/semantic-conventions` | **Medium-High** | `gen_ai.*` conventions are experimental. Breaking changes every 2-3 months. **Mitigated:** constants file, pinned version, quarterly review budget. |
| `@opentelemetry/exporter-*` (OTLP, Prometheus) | **Low** | Standard OTel exporters, widely deployed. |
| `@fastify/swagger` | **Low** | Maintained by Fastify core team. Minimal surface area. |
| `inspect-ai` (Python subprocess) | **Low** | 15M monthly downloads, 208 contributors, MIT. Post-run only — not in hot path. Failure mode is graceful (fall back to CheckSpec). |

### Key Fragility Identified and Fixed

**`invariant-ai` was the spec's biggest error.** The original analysis (from both research documents) assumed it could be imported as an in-process TypeScript library. It cannot — it's Python-only with no npm package. This would have forced either: (a) a Python subprocess on every LLM call (inner-loop latency), or (b) an HTTP gateway (operational complexity). Neither is acceptable. The concept was ported to ~80 lines of native TS pattern matching with zero dependency risk.

### Dependency Budget

| Metric | Before Phase 5 | After Phase 5 |
|--------|----------------|---------------|
| Runtime npm deps | 7 | 12 (+6, −1) |
| Dev npm deps | 3 | 3 (unchanged) |
| Python subprocess deps | 0 | 1 (Inspect AI, scoring path only) |
| Total new dep surface | — | ~1MB npm, ~36MB Python (scoring only) |
