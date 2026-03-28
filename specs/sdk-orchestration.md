---
status: DRAFT
project_root: /Users/brach/Documents/THE_FACTORY/projects/CRUCIBLE
revision_of: none
supersedes: none
superseded_by: none
pdr_ref: none
evidence_ref: none
---

# Spec: Claude Agent SDK Integration

## Frozen Intent

### Problem Statement
CRUCIBLE's agent execution layer is hand-rolled: a custom tool-use loop (`coder.ts`), custom middleware composition (`stack.ts`), and sequential-only graph execution (`GraphExecutor.ts`). The Claude Agent SDK provides production-grade versions of all three — an agentic loop with automatic context management, a hook system for enforcement/observability, and subagent orchestration for parallelism. Adopting the SDK eliminates ~400 lines of bespoke loop/middleware code, unlocks parallel node execution, and gives CRUCIBLE access to SDK improvements (prompt caching, compaction, session resumption) without maintenance burden.

### Target Users
- CRUCIBLE operators running evaluation harnesses
- THE_FACTORY pipeline (automated task execution via graph decomposition)

### Desired Outcome
1. Agent execution powered by the Claude Agent SDK's `query()` loop instead of the hand-rolled coder agent
2. Middleware (token budget, loop detection, mutation guard) reimplemented as SDK hooks
3. Graph executor can dispatch independent nodes in parallel via SDK subagents
4. Sandbox tools exposed as an MCP server instead of raw `ToolContext` functions
5. Session resumption available for long-running or interrupted nodes

### Non-Goals
- Agent Teams (multi-session coordination). Too experimental; revisit after SDK stabilizes teams support.
- Replacing E2B sandboxing. The SDK runs agents; E2B remains the execution sandbox.
- Changing the decomposition engine (D0/D4/D5 strategies). Those are orthogonal.
- UI changes. The event/WebSocket contract stays the same.

### Hard Constraints
- E2B sandbox isolation must be preserved — agent code runs in sandbox, not on host
- All existing kill switches (token budget, loop detection, TTL, mutation guard) must remain functional
- `RunEvent` and `GraphExecutorEvent` shapes must not change (downstream consumers: SQLite, WebSocket, UI)
- Existing tests (phases 0-5, session) must continue to pass or be updated to match new internals without reducing coverage
- No new runtime dependencies beyond `@anthropic-ai/sdk` (or `claude-agent-sdk` if that's the package name)

### Quality Priorities
1. Correctness — kill switches must fire reliably
2. Performance — parallel execution should yield measurable speedup on multi-node graphs
3. Simplicity — net reduction in code, not a lateral move

## Mutable Specification

### Summary
Replace CRUCIBLE's custom agent loop with the Claude Agent SDK, reimplementing enforcement as SDK hooks, sandbox tools as an in-process MCP server, and graph node dispatch as parallel subagent invocations. The migration is structured as four independent workstreams that can be merged incrementally.

### User-Facing Behavior
No CLI or API changes. `crucible run` and the web UI behave identically. The only observable differences:
- Multi-node graph runs execute faster (parallel independent nodes)
- Session resumption available via new `--resume <sessionId>` CLI flag
- Token usage may differ slightly due to SDK prompt caching

### Technical Requirements

#### WS-1: MCP Sandbox Server
- **Requirement:** Wrap `ToolContext` (exec, readFile, writeFile, task_complete) as an in-process MCP server using `createSdkMcpServer`
- **Acceptance:** Agent can call `mcp__sandbox__exec`, `mcp__sandbox__read_file`, `mcp__sandbox__write_file`, `mcp__sandbox__task_complete` via the SDK
- **Detail:** `read_file` marked `readOnlyHint: true` for parallel batching. `write_file` and `exec` are serial. `task_complete` signals loop termination.

#### WS-2: SDK Hooks (replaces middleware stack)
- **Requirement:** Reimplement token budget, loop detection, mutation guard, and OTel tracing as SDK `PreToolUse`/`PostToolUse` hooks
- **Acceptance:** All four enforcement behaviors fire correctly; events emitted match current `RunEvent` shapes; zero tokens consumed by hook execution
- **Detail:**

  | Current middleware | SDK hook | Event | Matcher |
  |---|---|---|---|
  | `tokenBudget.ts` | `PostToolUse` — increment token counter from response usage, throw if exceeded | `token_warning` | `*` (all tools) |
  | `loopDetector.ts` | `PostToolUse` — embed recent messages, check cosine similarity | `loop_warning` | `*` |
  | `mutationGuard.ts` | `PreToolUse` — call `MutationTracker.preMutation()`, deny if halted | (deny reason) | `mcp__sandbox__write_file\|mcp__sandbox__exec` |
  | `tracer.ts` | `PostToolUse` — emit OTel span with gen_ai attributes | (span) | `*` |

- **Migration note:** `composeMiddleware` and `Middleware` type become dead code after this workstream. Remove them.

#### WS-3: SDK Agent Loop (replaces coder.ts)
- **Requirement:** Replace `createCoderAgent` with SDK `query()` call. The agent loop, tool dispatch, message history, and context management are handled by the SDK.
- **Acceptance:** `RunEngine.startRun()` uses SDK `query()` instead of calling `agentFn(wrappedLlmCall, toolContext)`. All `RunEvent` types still emitted. `AgentTurnEvent` callbacks still fire.
- **Detail:**

  ```typescript
  // New agent execution in RunEngine.startRun()
  const sandboxMcp = createSandboxMcpServer(sandboxRunner);

  for await (const message of query({
    prompt: taskPrompt,
    options: {
      systemPrompt: effectiveSystemPrompt,
      model: agentConfig?.model,
      maxTurns: agentConfig?.maxTurns ?? 50,
      mcpServers: { sandbox: sandboxMcp },
      allowedTools: [
        'mcp__sandbox__exec',
        'mcp__sandbox__read_file',
        'mcp__sandbox__write_file',
        'mcp__sandbox__task_complete',
      ],
      permissionMode: 'bypassPermissions',
      hooks: buildHookSet(runId, config, session),
    },
  })) {
    // Map SDK messages → RunEvent emissions
    this.mapSdkMessage(runId, message);
  }
  ```

- **`AgentFn` type:** Retained as a thin wrapper that calls `query()`. Existing agent registry (`AGENTS`) still works — factories now return a function that invokes the SDK rather than manually looping.
- **`LlmCallFn` type:** No longer needed as a public contract. The SDK owns the LLM call. Kept internally for test doubles only.

#### WS-4: Parallel Graph Execution
- **Requirement:** `GraphExecutor.execute()` dispatches all ready nodes concurrently instead of sequentially
- **Acceptance:** Given a graph with 3 independent leaf nodes, all 3 run simultaneously. Total wall time ≈ max(node times) not sum(node times). Graph-level mutation budget still enforced across all parallel nodes.
- **Detail:**

  ```typescript
  // In GraphExecutor scheduling loop (replaces sequential dispatch)
  const readyNodes = this.scheduler.getReadyNodes(state);

  // Dispatch all ready nodes in parallel
  const results = await Promise.all(
    readyNodes.map(node => this.dispatchNode(node))
  );
  totalTokens += results.reduce((sum, t) => sum + t, 0);

  // Resolve ancestors for all completed nodes
  for (const node of readyNodes) {
    await this.resolveAncestors(node.id);
  }
  ```

- **Concurrency limit:** Cap at 5 parallel nodes (configurable via `GraphExecutorConfig.maxConcurrency`). Uses a semaphore pattern to avoid overwhelming E2B sandbox pool.
- **Mutation budget:** `MutationTracker` must be made thread-safe (atomic increment) since parallel nodes share the graph-level compound budget. Per-node budget resets are already isolated.
- **Error isolation:** One node's failure does not cancel siblings. Each node has independent TTL and token budget.

#### WS-5: Session Resumption (optional, low priority)
- **Requirement:** If a node hits `maxTurns` or TTL, persist its SDK session ID in the graph store. A retry/resume operation can continue from that checkpoint.
- **Acceptance:** `GraphStore.saveNodeDetail()` includes `sdkSessionId`. `GraphExecutor` can resume a failed node by passing `resume: sessionId` to `query()`.
- **Detail:** This is additive — no existing behavior changes. Deferred to a follow-up if scope is too large.

### Interface Definitions

```typescript
// ─── New: MCP Sandbox Server ───

import { createSdkMcpServer, tool } from '@anthropic-ai/sdk';
import { z } from 'zod';

export function createSandboxMcpServer(runner: SandboxRunner) {
  return createSdkMcpServer({
    name: 'sandbox',
    version: '1.0.0',
    tools: [
      tool(
        'exec',
        'Execute a shell command in the sandbox',
        { command: z.string() },
        async ({ command }) => {
          const result = await runner.getToolContext().exec(command);
          return {
            content: [{
              type: 'text' as const,
              text: `exit_code: ${result.exitCode}\n${result.stdout}\n${result.stderr}`,
            }],
          };
        },
      ),
      tool(
        'read_file',
        'Read file contents from the sandbox',
        { path: z.string() },
        async ({ path }) => {
          const content = await runner.getToolContext().readFile(path);
          return { content: [{ type: 'text' as const, text: content }] };
        },
        { readOnlyHint: true },
      ),
      tool(
        'write_file',
        'Write content to a file in the sandbox',
        { path: z.string(), content: z.string() },
        async ({ path, content }) => {
          await runner.getToolContext().writeFile(path, content);
          return { content: [{ type: 'text' as const, text: `Written: ${path}` }] };
        },
      ),
      tool(
        'task_complete',
        'Signal task completion',
        { summary: z.string() },
        async ({ summary }) => {
          return { content: [{ type: 'text' as const, text: `Complete: ${summary}` }] };
        },
      ),
    ],
  });
}

// ─── New: Hook builders ───

export interface CrucibleHookSet {
  PreToolUse: HookMatcher[];
  PostToolUse: HookMatcher[];
}

export function buildHookSet(
  runId: string,
  config: RunConfig,
  session: SessionModel | null,
): CrucibleHookSet {
  const hooks: CrucibleHookSet = {
    PreToolUse: [],
    PostToolUse: [],
  };

  // Mutation guard (PreToolUse)
  if (session) {
    hooks.PreToolUse.push({
      matcher: 'mcp__sandbox__write_file|mcp__sandbox__exec',
      hooks: [createMutationGuardHook(session.mutations)],
    });
  }

  // Token budget (PostToolUse)
  hooks.PostToolUse.push({
    hooks: [createTokenBudgetHook(config.tokenBudget, runId)],
  });

  // Loop detector (PostToolUse)
  hooks.PostToolUse.push({
    hooks: [createLoopDetectorHook(config.loopDetection)],
  });

  // OTel tracer (PostToolUse)
  hooks.PostToolUse.push({
    hooks: [createTracerHook(runId, config)],
  });

  return hooks;
}

// ─── Updated: GraphExecutorConfig ───

export interface GraphExecutorConfig {
  // ... existing fields ...

  /** Maximum nodes to dispatch concurrently. Default: 5 */
  maxConcurrency?: number;
}

// ─── Updated: ExecutionRecord ───

export interface ExecutionRecord {
  // ... existing fields ...

  /** SDK session ID for resumption (if supported) */
  sdkSessionId?: string;
}
```

### Layer Boundaries

- **SDK layer** (`@anthropic-ai/sdk`) is responsible for: agentic loop, tool dispatch, message history, context compaction, prompt caching, session persistence
- **CRUCIBLE engine layer** (`src/engine/`) is responsible for: graph orchestration, node scheduling, parallel dispatch, event emission, run lifecycle
- **Hook layer** (`src/hooks/`) is responsible for: token budget enforcement, loop detection, mutation guarding, OTel tracing — all running in-process, zero token cost
- **Sandbox layer** (`src/sandbox/`) is responsible for: E2B lifecycle, MCP server wrapping, artifact flush, teardown
- Interface between SDK and engine: `query()` call with `McpServer` + hooks config → streaming `Message` objects mapped to `RunEvent`
- Interface between engine and sandbox: `createSandboxMcpServer(runner)` → MCP tools

### Edge Cases
- **SDK unavailable at runtime:** Fall back to existing coder agent loop. Feature-flag `CRUCIBLE_USE_SDK=1` controls which path is taken during migration.
- **Parallel node mutation conflict:** Two nodes write the same file → last write wins (E2B sandboxes are isolated, so this only matters if nodes share a sandbox). Current design: one sandbox per node, no conflict possible.
- **Graph-level budget exceeded mid-parallel dispatch:** `MutationTracker.isHalted` checked before each dispatch wave. In-flight nodes are NOT cancelled (they finish or hit their per-node budget). The next scheduling wave exits the loop.
- **SDK session resume with stale sandbox:** E2B sandbox has been destroyed. Resume creates a new sandbox and re-uploads seed files. Agent conversation context is preserved but filesystem state is lost — acceptable for evaluation harness use case.
- **TTL race with SDK compaction:** If the SDK triggers context compaction during a long turn, the TTL timer keeps running. This is correct — TTL measures wall time, not compute time.

### Open Questions
- `[RESOLVED]`: Package name is `@anthropic-ai/claude-code` (CLI/SDK). Agent SDK is `@anthropic-ai/claude-agent-sdk`.
- `[RESOLVED]`: SDK `query()` supports MCP servers in TypeScript via `mcpServers` option.
- `[DECISION NEEDED]`: Should WS-5 (session resumption) be in scope for the initial implementation, or deferred?

---

## Appendix A: CLI Subscription Path (WS-6)

> **Added 2026-03-27** — Alternative execution path that uses Claude Code CLI with subscription auth instead of API key.

### Problem
The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) and direct API calls both require `ANTHROPIC_API_KEY` and bill per-token. The Claude Code CLI (`claude`) authenticates via OAuth to the user's Max plan subscription, which has different (often more generous) rate limits and flat-rate billing.

### Solution: CLI Runner (`src/agents/cli-runner.ts`)
A new agent type `claude-cli` that spawns `claude -p` as a child process:

```
CRUCIBLE RunEngine
  ├─ agentName === 'coder'      → E2B sandbox + Anthropic API (existing)
  └─ agentName === 'claude-cli' → temp dir + Claude CLI subprocess (new)
```

#### How It Works

1. **Temp directory seeding**: Creates `/tmp/crucible-<runId>-xxx/`, seeds with `taskPayload.files` and `taskPayload.seedDir`
2. **CLI invocation**: Spawns `claude -p --output-format stream-json --verbose --no-session-persistence` with:
   - `--system-prompt` from variant config
   - `--model` from agent config
   - `--max-turns` from agent config
   - `--permission-mode bypassPermissions`
   - `--allowedTools Bash Read Write Edit Glob Grep`
   - `cwd` set to the temp directory
3. **Event streaming**: Parses NDJSON lines from stdout, maps to CRUCIBLE `AgentTurnEvent` types
4. **TTL enforcement**: `SIGTERM` after `config.ttlSeconds`, `SIGKILL` after 5s grace
5. **Acceptance checks**: Runs `config.taskPayload.checks` commands in the workdir after completion
6. **Artifact flush**: Copies temp dir contents to `runs/<runId>/artifacts/`
7. **Cleanup**: Removes temp dir

#### Event Mapping

| CLI stream-json event | CRUCIBLE event |
|---|---|
| `system` (subtype: init) | Session ID captured |
| `assistant` → text content blocks | `agent_thinking` |
| `assistant` → tool_use content blocks | `agent_tool_call` |
| `assistant` → tool_result content blocks | `agent_tool_result` |
| After each `assistant` message | `agent_turn_complete` |
| `result` (subtype: success) | `agent_completed` → `run_completed` |
| `result` (subtype: error) | `error` → `run_completed` |
| `rate_limit_event` (status ≠ allowed) | `rate_limited` |

#### Auth Model

| Method | Auth | Billing | Rate Limits |
|---|---|---|---|
| Direct API (`coder` agent) | `ANTHROPIC_API_KEY` | Per-token | Org API tier |
| CLI (`claude-cli` agent) | OAuth login (`claude auth login`) | Max plan subscription | 5-hour windows |

The CLI runner explicitly sets `ANTHROPIC_API_KEY: undefined` in the spawned process env to force subscription auth.

#### Isolation Comparison

| Property | E2B (`coder`) | CLI temp dir (`claude-cli`) |
|---|---|---|
| Filesystem isolation | Full VM | Temp directory only |
| Process isolation | Full VM | None (runs on host) |
| Network control | `allowInternetAccess` toggle | None |
| Cleanup | Sandbox auto-destroys | `fs.rm(workDir)` |
| Startup latency | ~3-5s (VM boot) | <100ms (process spawn) |

For stronger isolation, use the `docker-cli` agent (Appendix B).

#### Prompt Delivery

The prompt is piped via **stdin** (not as a positional CLI argument). This avoids shell escaping issues with newlines and special characters in task instructions. `proc.stdin.write(prompt)` then `proc.stdin.end()`.

#### Usage

```typescript
// Via CLI: select agent 'claude-cli'
// crucible run --agent claude-cli --task tasks/my-task.json

// Via API: POST /api/runs with agent: 'claude-cli'
// { task: "tasks/my-task.json", agent: "claude-cli", config: { model: "opus" } }

// Via RunEngine directly:
const result = await engine.startRun(config, 'claude-cli', {
  systemPrompt: 'You are a coding agent...',
  model: 'opus',
  maxTurns: 30,
  allowedTools: ['Bash', 'Read', 'Write', 'Edit'],
});
```

#### Files Changed

| File | Change |
|---|---|
| `src/agents/cli-runner.ts` | **New** — CLI process spawner, stream-json parser, AgentFn adapter |
| `src/engine/agents.ts` | Added `claude-cli` to agent registry |
| `src/engine/RunEngine.ts` | Added `startCliRun()` path — temp dir, CLI invocation, artifact flush |

---

## Appendix B: Docker-Isolated CLI Runner (WS-7)

> **Added 2026-03-28** — Full container isolation for the CLI subscription path.

### Problem
The `claude-cli` agent (WS-6) runs on the host with no isolation — the agent has full access to the host filesystem, processes, and network. Unacceptable for untrusted task payloads or multi-tenant use.

### Solution: Docker Runner (`src/sandbox/docker-runner.ts`)
A third agent type `docker-cli` that runs the Claude CLI inside a Docker container:

```
CRUCIBLE RunEngine
  ├─ agentName === 'coder'      → E2B sandbox + Anthropic API
  ├─ agentName === 'claude-cli' → host temp dir + Claude CLI (no isolation)
  └─ agentName === 'docker-cli' → Docker container + Claude CLI (full isolation)
```

#### Container Image (`docker/Dockerfile`)

- **Base**: `node:20-bookworm-slim`
- **Installed**: git, python3, build-essential, curl, jq, iptables, gosu, Claude Code CLI
- **User**: non-root `agent` user, workspace at `/workspace/`
- **Entrypoint**: `docker/entrypoint.sh` — network lockdown via iptables, then drops to non-root

#### Network Isolation (`docker/entrypoint.sh`)

Runs as root briefly to set iptables rules:
- Default OUTPUT policy: **DROP**
- Allowed: loopback, DNS (UDP/TCP 53), established connections
- Allowed hosts: `api.anthropic.com`, `claude.ai`, `statsigapi.net`
- Additional hosts via `$CRUCIBLE_NETWORK_ALLOWLIST` env var (from `taskPayload.networkAllowlist`)
- Requires `--cap-add NET_ADMIN` on container creation
- Falls back gracefully if iptables unavailable (warning to stderr)

#### Container Lifecycle

```
DockerRunner.create(config)
  ├─ docker version             → verify daemon available
  ├─ docker image inspect       → check image exists (build if missing)
  ├─ docker create              → container with labels, auth mount, resource limits
  │   -v ~/.claude:/home/agent/.claude:ro    ← subscription auth
  │   --cap-add NET_ADMIN                    ← for iptables
  │   --memory 4g --cpus 2                   ← resource limits
  │   --label crucible-run-id=<runId>        ← for orphan cleanup
  ├─ docker start               → entrypoint runs (iptables + sleep)
  └─ docker cp (tar pipe)       → seed task files into /workspace/

runner.run(config)
  ├─ docker exec claude -p ...  → agent runs inside container
  ├─ stdin pipe: prompt         → written then closed
  ├─ stdout pipe ← NDJSON      → parseCliStream() on host (reused from WS-6)
  └─ TTL timer → docker stop

runner.runChecks(checks)
  └─ docker exec sh -c "..."   → acceptance checks inside container

runner.flushArtifacts(runId)
  └─ docker cp container:/workspace/ → runs/<runId>/artifacts/

runner.destroy()
  ├─ docker stop -t 5
  └─ docker rm -f               → idempotent, never throws
```

#### Auth: Read-Only Mount

The host's `~/.claude/` directory is bind-mounted read-only into the container at `/home/agent/.claude/`. This provides the OAuth tokens needed for subscription auth without any manual token extraction. The container can read auth credentials but cannot modify them.

**Exposure**: The mount includes settings, memory, and session history beyond just the auth token. Acceptable tradeoff — the container already has the user's Claude subscription access, and the mount is read-only.

#### Orphan Cleanup

`DockerRunner.cleanupOrphans()` finds containers labeled `crucible-run-id` older than 2 hours and removes them. Called at server startup to clean up after crashes.

#### Error Handling

If Docker is not available, `DockerRunner.create()` throws `DockerNotAvailableError`. The RunEngine catch block emits both `error` and `run_completed` events, ensuring the run transitions to `completed` status in the database (not stuck as `running`).

#### Three-Agent Comparison

| | `coder` | `claude-cli` | `docker-cli` |
|---|---|---|---|
| **Billing** | API key (per-token) | Subscription (Max) | Subscription (Max) |
| **Isolation** | E2B VM (full) | None (host) | Docker container (full) |
| **Network** | E2B toggle | None | iptables allowlist |
| **Startup** | ~3-5s | <100ms | ~2-5s |
| **Tools** | 4 custom | Full Claude Code | Full Claude Code |
| **Auth** | `ANTHROPIC_API_KEY` | Host OAuth | Mounted `~/.claude/` |
| **Dependencies** | E2B account | Claude CLI on host | Docker + image built |
| **Checks** | In E2B sandbox | On host filesystem | Inside container |
| **Artifacts** | `sandbox.files.list` | `fs.copyFile` | `docker cp` |

#### Files

| File | Status | Purpose |
|---|---|---|
| `docker/Dockerfile` | **New** | Container image: Node 20 + Claude CLI + dev tools |
| `docker/entrypoint.sh` | **New** | Network lockdown + user drop |
| `src/sandbox/docker-runner.ts` | **New** | DockerRunner class: create/run/checks/flush/destroy |
| `src/agents/docker-cli-agent.ts` | **New** | AgentFn adapter wrapping DockerRunner |
| `src/agents/cli-runner.ts` | **Modified** | Exported `parseCliStream()`, stdin prompt delivery |
| `src/engine/agents.ts` | **Modified** | Registered `docker-cli` agent |
| `src/engine/RunEngine.ts` | **Modified** | Added `startDockerCliRun()`, fixed error event emission |
| `src/types/index.ts` | **Modified** | Added `DockerNotAvailableError` |

#### QA Results (2026-03-28)

| Test | Result |
|---|---|
| 139 unit tests | PASS |
| Build (`tsc`) | PASS |
| echo agent (E2B path) | PASS — full lifecycle, events in DB |
| claude-cli agent | PASS — 5 turns, Write+Bash tools, 547 tokens, $0.078, 10.9s |
| docker-cli (Docker off) | PASS — graceful error, `DockerNotAvailableError`, run completes |
| UI event feed | PASS — all event types render correctly |

**Bugs found and fixed during QA:**
1. `--bare` flag unsupported on CLI v2.1.79 — removed
2. Stdin not closed after spawn — CLI hung waiting for input
3. Prompt as positional arg failed — switched to stdin pipe
4. Missing `run_completed` event in error catch blocks — runs stuck as "running"

### Change Log
<!-- Format: [DATE] [CHANGE] — caused by [source] -->
- [2026-03-28] Added WS-7: Docker-isolated CLI runner — caused by security gap in WS-6 (no isolation)
- [2026-03-28] Fixed stdin prompt delivery for CLI agents — caused by QA failure
- [2026-03-28] Fixed missing run_completed events in error paths — caused by QA finding stuck runs
- [2026-03-28] Removed --bare flag (unsupported on CLI v2.1.79) — caused by QA failure
- [2026-03-27] Added WS-6: CLI subscription path — caused by operator request to use Max plan billing
- [2026-03-27] Resolved open questions on package names and MCP support — caused by SDK research
