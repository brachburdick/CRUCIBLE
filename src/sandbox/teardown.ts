import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  KillReason,
  KillEvent,
  RunResult,
  ArtifactManifest,
  RunConfig,
} from '../types/index.js';
import type { SandboxRunner } from './runner.js';
import type { RunTracer } from '../telemetry/tracer.js';

/**
 * All dependencies needed to execute teardown.
 * The teardown function receives these as a context object — it does NOT
 * instantiate SandboxRunner or RunTracer itself.
 */
export interface TeardownContext {
  sandboxRunner: SandboxRunner;
  tracer: RunTracer;
  getTokenCount: () => number;
  runConfig: RunConfig;
  startedAt: Date;
}

/**
 * Empty manifest used when artifact flush fails — teardown must not abort.
 */
function emptyManifest(runId: string): ArtifactManifest {
  return {
    outputDir: path.join('runs', runId, 'artifacts'),
    files: [],
  };
}

/**
 * Single convergent teardown path for all kill reasons (budget, loop, TTL,
 * clean completion). All kill paths MUST call this function.
 *
 * Execution order (guaranteed):
 *   1. Log KillEvent JSON to stdout
 *   2. flushArtifacts(runId) — download sandbox artifacts to host
 *   3. tracer.close(killReason, tokenCount) — close Langfuse trace and flush
 *   4. sandboxRunner.destroy() — destroy E2B sandbox
 *   5. Write RunResult JSON to ./runs/<runId>/result.json
 *
 * Each step is wrapped in try/catch. If any step fails, the error is logged
 * and execution continues to the next step. Teardown NEVER throws.
 *
 * Idempotent: a boolean guard prevents the sequence from executing more than
 * once per teardown call site. Re-entrant calls return immediately.
 */
export async function teardown(
  context: TeardownContext,
  killReason: KillReason,
): Promise<void> {
  const { sandboxRunner, tracer, getTokenCount, runConfig, startedAt } =
    context;

  const runId = tracer.getRunId();
  const tokenCount = getTokenCount();
  const completedAt = new Date();
  const wallTimeMs = completedAt.getTime() - startedAt.getTime();

  // ── Step 1: Log KillEvent JSON to stdout ──────────────────────────────────
  const killEvent: KillEvent = {
    runId,
    killReason,
    tokenCount,
    wallTimeMs,
    timestamp: completedAt.toISOString(),
  };

  try {
    console.log(JSON.stringify(killEvent));
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'teardown_step_failed',
        step: 'log_kill_event',
        runId,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    );
  }

  // ── Step 2: Flush artifacts from sandbox to host ───────────────────────────
  let artifactManifest: ArtifactManifest = emptyManifest(runId);

  try {
    artifactManifest = await sandboxRunner.flushArtifacts(runId);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'teardown_step_failed',
        step: 'flush_artifacts',
        runId,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    );
  }

  // ── Step 3: Close Langfuse trace and flush ────────────────────────────────
  try {
    await tracer.close(killReason, tokenCount);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'teardown_step_failed',
        step: 'tracer_close',
        runId,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    );
  }

  // ── Step 4: Destroy E2B sandbox ───────────────────────────────────────────
  try {
    await sandboxRunner.destroy();
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'teardown_step_failed',
        step: 'sandbox_destroy',
        runId,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    );
  }

  // ── Step 5: Write RunResult JSON to ./runs/<runId>/result.json ────────────
  try {
    const runDir = path.join('runs', runId);
    await fs.mkdir(runDir, { recursive: true });

    const runResult: RunResult = {
      runId,
      variantLabel: runConfig.variantLabel,
      exitReason: killReason,
      tokenUsage: {
        // getTokenCount() returns a cumulative total. The prompt/completion
        // breakdown is not separately tracked at the teardown boundary — the
        // middleware only exposes a single counter. Set total accurately and
        // leave individual counters at 0 to avoid fabricating data.
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: tokenCount,
      },
      wallTimeMs,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      artifacts: artifactManifest,
    };

    const resultPath = path.join(runDir, 'result.json');
    await fs.writeFile(resultPath, JSON.stringify(runResult, null, 2), 'utf-8');
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'teardown_step_failed',
        step: 'write_result_json',
        runId,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    );
  }
}

/**
 * Wrap teardown() with a once-only guard so that callers can safely invoke it
 * from multiple code paths (e.g. TTL setTimeout + BudgetExceededError catch)
 * without executing the teardown sequence twice.
 *
 * Usage:
 *   const safeTeardown = createIdempotentTeardown(context);
 *   // Both of these will only execute teardown once:
 *   await safeTeardown(killReason1);
 *   await safeTeardown(killReason2); // no-op
 */
export function createIdempotentTeardown(
  context: TeardownContext,
): (killReason: KillReason) => Promise<void> {
  let called = false;

  return async (killReason: KillReason): Promise<void> => {
    if (called) {
      return;
    }
    called = true;
    await teardown(context, killReason);
  };
}
