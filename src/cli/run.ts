#!/usr/bin/env node

import * as fs from 'node:fs/promises';
import { Command } from 'commander';
import type {
  KillReason,
  LlmCallFn,
  LlmMessage,
  LlmCallOptions,
  LlmResponse,
  RunConfig,
  TaskPayload,
} from '../types/index.js';
import { BudgetExceededError, LoopDetectedError } from '../types/index.js';
import { SandboxRunner } from '../sandbox/runner.js';
import { createIdempotentTeardown, type TeardownContext } from '../sandbox/teardown.js';
import { createTokenBudget } from '../middleware/tokenBudget.js';
import { createLoopDetector } from '../middleware/loopDetector.js';
import { composeMiddleware } from '../middleware/stack.js';
import { RunTracer } from '../telemetry/tracer.js';

// ─── Exit codes ────────────────────────────────────────────────────────────────
const EXIT_COMPLETED = 0;
const EXIT_BUDGET_EXCEEDED = 1;
const EXIT_LOOP_DETECTED = 2;
const EXIT_TTL_EXCEEDED = 3;

// ─── Agent ──────────────────────────────────────────────────────────────────────
import { createAgent } from '../agents/echo.js';

// ─── Base LLM call via Anthropic Messages API ──────────────────────────────────
const baseLlmCall: LlmCallFn = async (
  messages: LlmMessage[],
  options?: LlmCallOptions,
): Promise<LlmResponse> => {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set');
  }

  const model = options?.model ?? 'claude-sonnet-4-20250514';
  const maxTokens = options?.maxTokens ?? 4096;

  const body = {
    model,
    max_tokens: maxTokens,
    messages: messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content })),
    ...(messages.some((m) => m.role === 'system')
      ? { system: messages.find((m) => m.role === 'system')!.content }
      : {}),
    ...(options?.temperature !== undefined
      ? { temperature: options.temperature }
      : {}),
  };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text?: string }>;
    model: string;
    usage: { input_tokens: number; output_tokens: number };
  };

  const content = data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');

  return {
    content,
    usage: {
      promptTokens: data.usage.input_tokens,
      completionTokens: data.usage.output_tokens,
    },
    model: data.model,
  };
};

// ─── Task payload validation ───────────────────────────────────────────────────
function validateTaskPayload(raw: unknown): TaskPayload {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Task payload must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj['description'] !== 'string' || obj['description'].length === 0) {
    throw new Error('Task payload must have a non-empty "description" string');
  }
  if (typeof obj['instructions'] !== 'string' || obj['instructions'].length === 0) {
    throw new Error('Task payload must have a non-empty "instructions" string');
  }

  const payload: TaskPayload = {
    description: obj['description'],
    instructions: obj['instructions'],
  };

  if (obj['files'] !== undefined) {
    if (typeof obj['files'] !== 'object' || obj['files'] === null) {
      throw new Error('Task payload "files" must be an object');
    }
    payload.files = obj['files'] as Record<string, string>;
  }

  if (obj['networkAllowlist'] !== undefined) {
    if (!Array.isArray(obj['networkAllowlist'])) {
      throw new Error('Task payload "networkAllowlist" must be an array');
    }
    payload.networkAllowlist = obj['networkAllowlist'] as string[];
  }

  return payload;
}

// ─── Parse number from env with fallback ───────────────────────────────────────
function envNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) return fallback;
  return parsed;
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const program = new Command();

  program
    .name('crucible')
    .description('Run a sandboxed agent evaluation')
    .requiredOption('--task <file>', 'Path to task payload JSON file')
    .option('--variant <label>', 'Variant label for this run', 'default')
    .option('--budget <tokens>', 'Token budget (overrides DEFAULT_TOKEN_BUDGET env)')
    .option('--ttl <seconds>', 'TTL in seconds (overrides DEFAULT_TTL_SECONDS env)')
    .parse(process.argv);

  const opts = program.opts<{
    task: string;
    variant: string;
    budget?: string;
    ttl?: string;
  }>();

  // ── Step 2: Read and validate task payload ────────────────────────────────
  const taskFileContent = await fs.readFile(opts.task, 'utf-8');
  const taskPayload = validateTaskPayload(JSON.parse(taskFileContent));

  // ── Step 3: Build RunConfig ───────────────────────────────────────────────
  const tokenBudget = opts.budget !== undefined
    ? Number(opts.budget)
    : envNumber('DEFAULT_TOKEN_BUDGET', 100_000);

  const ttlSeconds = opts.ttl !== undefined
    ? Number(opts.ttl)
    : envNumber('DEFAULT_TTL_SECONDS', 300);

  const runConfig: RunConfig = {
    taskPayload,
    variantLabel: opts.variant,
    tokenBudget,
    ttlSeconds,
    loopDetection: {
      windowSize: envNumber('LOOP_WINDOW_SIZE', 8),
      similarityThreshold: envNumber('LOOP_SIMILARITY_THRESHOLD', 0.92),
      consecutiveTurns: envNumber('LOOP_CONSECUTIVE_TURNS', 5),
    },
  };

  const startedAt = new Date();

  // ── Step 4: Create RunTracer ──────────────────────────────────────────────
  const tracer = RunTracer.create(runConfig);
  const runId = tracer.getRunId();
  console.log(JSON.stringify({ event: 'run_started', runId, variant: runConfig.variantLabel, timestamp: startedAt.toISOString() }));

  // ── Step 5: Create SandboxRunner ──────────────────────────────────────────
  const sandboxRunner = await SandboxRunner.create(runConfig);
  console.log(JSON.stringify({ event: 'sandbox_created', runId, timestamp: new Date().toISOString() }));

  // ── Step 6: Create token budget middleware ────────────────────────────────
  const { middleware: tokenBudgetMW, getTokenCount } = createTokenBudget({
    budget: runConfig.tokenBudget,
    onWarning: (threshold, currentCount, budget) => {
      console.log(JSON.stringify({ event: 'token_warning', runId, threshold, currentCount, budget, timestamp: new Date().toISOString() }));
    },
  });

  // ── Step 7: Create loop detector middleware ───────────────────────────────
  const loopDetectorMW = createLoopDetector({
    windowSize: runConfig.loopDetection.windowSize,
    similarityThreshold: runConfig.loopDetection.similarityThreshold,
    consecutiveTurns: runConfig.loopDetection.consecutiveTurns,
    onWarning: (meanSimilarity, consecutiveCount) => {
      console.log(JSON.stringify({ event: 'loop_warning', runId, meanSimilarity, consecutiveCount, timestamp: new Date().toISOString() }));
    },
  });

  // ── Step 8: Create tracer middleware ──────────────────────────────────────
  const tracerMW = tracer.createTracerMiddleware();

  // ── Step 9: Compose middleware stack ───────────────────────────────────────
  // Order: composeMiddleware(base, tracerMW, tokenBudgetMW, loopDetectorMW)
  // Call chain: loopDetector → tokenBudget → tracer → baseLlmCall
  const wrappedLlmCall = composeMiddleware(baseLlmCall, tracerMW, tokenBudgetMW, loopDetectorMW);

  // ── Step 10: Build ToolContext ────────────────────────────────────────────
  const toolContext = sandboxRunner.getToolContext();

  // ── Step 11: Build TeardownContext ────────────────────────────────────────
  const teardownContext: TeardownContext = {
    sandboxRunner,
    tracer,
    getTokenCount,
    runConfig,
    startedAt,
  };

  // ── Step 12: Create idempotent teardown ───────────────────────────────────
  const safeTeardown = createIdempotentTeardown(teardownContext);

  // ── Step 13: Set TTL setTimeout ───────────────────────────────────────────
  const ttlMs = runConfig.ttlSeconds * 1000;
  const ttlTimer = setTimeout(async () => {
    const wallTimeMs = Date.now() - startedAt.getTime();
    const killReason: KillReason = { type: 'ttl_exceeded', wallTimeMs, ttlMs };
    await safeTeardown(killReason);
    process.exit(EXIT_TTL_EXCEEDED);
  }, ttlMs);

  // Unref the timer so it doesn't prevent clean exit
  ttlTimer.unref();

  // ── Steps 14–18: Run agent and handle outcomes ────────────────────────────
  try {
    // Step 14: Call agent
    const agentFn = createAgent(taskPayload);
    const result = await agentFn(wrappedLlmCall, toolContext);
    console.log(JSON.stringify({ event: 'agent_completed', runId, finalMessage: result.finalMessage, timestamp: new Date().toISOString() }));

    // Step 15: Clean completion
    clearTimeout(ttlTimer);
    await safeTeardown({ type: 'completed' });
    process.exit(EXIT_COMPLETED);
  } catch (err) {
    clearTimeout(ttlTimer);

    if (err instanceof BudgetExceededError) {
      // Step 16: Budget exceeded
      const killReason: KillReason = {
        type: 'budget_exceeded',
        tokenCount: err.tokenCount,
        budget: err.budget,
      };
      await safeTeardown(killReason);
      process.exit(EXIT_BUDGET_EXCEEDED);
    }

    if (err instanceof LoopDetectedError) {
      // Step 17: Loop detected
      const killReason: KillReason = {
        type: 'loop_detected',
        similarityScore: err.similarityScore,
        consecutiveCount: err.consecutiveCount,
        lastMessages: err.lastMessages,
      };
      await safeTeardown(killReason);
      process.exit(EXIT_LOOP_DETECTED);
    }

    // Unexpected error — still teardown cleanly
    console.error(JSON.stringify({
      event: 'unexpected_error',
      runId,
      error: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    }));
    await safeTeardown({ type: 'completed' });
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error during startup:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
